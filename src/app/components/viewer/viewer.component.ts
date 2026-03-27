import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { Course, Tag3D, AnimationStop, UserRole } from '../../models/course.model';

@Component({
  selector: 'app-viewer',
  templateUrl: './viewer.component.html',
  styleUrls: ['./viewer.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewerComponent implements AfterViewInit, OnDestroy, OnChanges {
  @Input() course: Course | null = null;
  @Input() role: UserRole = 'trainee';
  @Input() editMode = false;

  @Output() tagsChange = new EventEmitter<Tag3D[]>();
  @Output() stopsChange = new EventEmitter<AnimationStop[]>();
  @Output() durationChange = new EventEmitter<number>();

  @ViewChild('rendererHost', { static: true }) rendererHost!: ElementRef<HTMLDivElement>;

  scene = new THREE.Scene();
  camera!: THREE.PerspectiveCamera;
  renderer!: THREE.WebGLRenderer;
  controls!: OrbitControls;
  mixer: THREE.AnimationMixer | null = null;
  activeAction: THREE.AnimationAction | null = null;
  private lastFrameTime = performance.now();
  model: THREE.Object3D | null = null;
  tags: Tag3D[] = [];
  projectedTags: Array<Tag3D & { screenX: number; screenY: number }> = [];
  pendingTagPosition: THREE.Vector3 | null = null;

  animationStops: AnimationStop[] = [];
  nextStopIndex = 0;
  animationDuration = 0;
  currentTime = 0;
  isPlaying = false;
  isLoading = false;
  loadingProgress = 0;
  loadError = '';
  private lastUiTick = performance.now();

  // XR state
  private xrHitTestSource: XRHitTestSource | null = null;
  private xrReferenceSpace: XRReferenceSpace | null = null;
  private reticle: THREE.Mesh | null = null;
  private dracoLoader: DRACOLoader | null = null;
  private autoPlacedInAR = false;
  private arPlacementPending = false;
  private modelBaseYOffset = 0;
  xrPresenting = false;

  // recording
  isRecording = false;
  recordedAudioUrl: string | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: BlobPart[] = [];
  recordError = '';

  // stop navigation state
  private navigationTarget: number | null = null;
  private navigationDirection: 'forward' | 'backward' | null = null;
  // Pinch zoom
  private pinchStartDist = 0;
  private pinchBaseScale = 1;
  private pinchTargetScale = 1;
  private pinchSmooth = 0.15;
  private pinchListenerCleanup: (() => void) | null = null;

  constructor(private cdr: ChangeDetectorRef) { }
  private isInitialized = false;

  ngAfterViewInit(): void {
    this.initThree();
    this.startRenderLoop();
    this.setupResizeListener();
    this.addLights();
    this.addReferenceHelpers();

    this.isInitialized = true;
    if (this.course) {
      this.loadCourse(this.course);
    }
  }

  private isValidTime(time: number): boolean {
    return Number.isFinite(time) && time >= 0;
  }

  private sanitizeStops(stops: AnimationStop[] = []): AnimationStop[] {
    return stops.filter((s) => this.isValidTime((s as any)?.time)).sort((a, b) => a.time - b.time);
  }

  private safeDuration(): number {
    return Number.isFinite(this.animationDuration) && this.animationDuration > 0 ? this.animationDuration : 0;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['course'] && this.course) {
      const prev: Course | null = changes['course'].previousValue;
      const curr: Course = this.course;
      const modelChanged = !prev || prev.id !== curr.id || prev.modelUrl !== curr.modelUrl;

      if (modelChanged) {
        this.isLoading = true;
        this.loadingProgress = 0;
        this.loadError = '';
        this.cdr.markForCheck();
        setTimeout(() => this.course && this.loadCourse(this.course), 0);
      } else {
        // Same model; just sync metadata without reloading to avoid flashing
        this.tags = [...curr.tags];
        this.animationStops = this.sanitizeStops(curr.animationStops);
        this.resetNextStopIndex(this.currentTime);
        this.cdr.markForCheck();
      }
    }
    if (changes['editMode'] && !this.editMode) {
      this.pendingTagPosition = null;
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.handleResize);
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.controls?.dispose();
    this.teardownPinchZoom();
  }

  private initThree(): void {
    const { clientWidth, clientHeight } = this.rendererHost.nativeElement;
    const width = Math.max(clientWidth, 320);
    const height = Math.max(clientHeight, 240);
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      });
    } catch (err) {
      this.loadError =
        'Unable to create WebGL renderer. Your browser/device may block WebGL or hardware acceleration.';
      this.cdr.markForCheck();
      throw err;
    }
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height);
    this.renderer.autoClear = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.xr.enabled = true;
    this.rendererHost.nativeElement.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 2000);
    this.camera.position.set(2, 2, 4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;

    this.scene.background = new THREE.Color(0xf6f8ff);

    this.setupXRButtons();
    this.setupPointerHandler();
    this.setupPinchZoom();
  }

  private addLights(): void {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
    hemi.position.set(0, 50, 0);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1);
    dir.position.set(5, 10, 7.5);
    dir.castShadow = true;
    this.scene.add(dir);
  }

  private addReferenceHelpers(): void {
    const grid = new THREE.GridHelper(10, 20, 0xa3baff, 0xe5eafe);
    grid.position.y = 0;
    this.scene.add(grid);

    const axes = new THREE.AxesHelper(2);
    this.scene.add(axes);
  }

  private clearExistingCourseModels(): void {
    const removable = this.scene.children.filter((child: any) => child?.userData?.isCourseModel);
    removable.forEach((child) => this.scene.remove(child));
  }

  private placeModelOnGround(y: number): void {
    if (!this.model) return;
    // Always keep model at the scene origin
    this.model.position.set(0, 0, 0);
    this.model.updateMatrixWorld(true);
  }

  private setupXRButtons(): void {
    const vrButton = VRButton.createButton(this.renderer);
    vrButton.classList.add('xr-button');
    this.rendererHost.nativeElement.appendChild(vrButton);

    const arButton = ARButton.createButton(this.renderer, {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: this.rendererHost.nativeElement },
    });
    arButton.classList.add('xr-button');
    this.rendererHost.nativeElement.appendChild(arButton);

    this.renderer.xr.addEventListener('sessionstart', (event) => {
      this.onXRSessionStart(event);
      this.xrPresenting = true;
      this.cdr.markForCheck();
    });

    this.renderer.xr.addEventListener('sessionend', () => {
      this.xrHitTestSource = null;
      this.xrReferenceSpace = null;
      if (this.reticle) {
        this.scene.remove(this.reticle);
      }
      this.xrPresenting = false;
      this.cdr.markForCheck();
    });
  }

  private setupPointerHandler(): void {
    this.renderer.domElement.addEventListener('pointerdown', (event) => {
      if (!this.editMode || this.role !== 'trainer' || !this.model) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, this.camera);
      const intersects = raycaster.intersectObject(this.model, true);
      if (intersects.length > 0) {
        this.pendingTagPosition = intersects[0].point.clone();
      }
    });
  }

  private onXRSessionStart(event: THREE.Event): void {
    const xrSession = this.renderer.xr.getSession();
    if (!xrSession) return;
    const session: XRSession = xrSession;
    this.autoPlacedInAR = false;
    this.arPlacementPending = true;
    this.xrPresenting = true;
    this.cdr.markForCheck();

    session.requestReferenceSpace('local').then((refSpace: XRReferenceSpace) => {
      this.xrReferenceSpace = refSpace;
      const requestHitTest = (session as any).requestHitTestSource?.bind(session);
      if (!requestHitTest) {
        return;
      }
      requestHitTest({ space: refSpace }).then((hitTestSource: XRHitTestSource) => {
        this.xrHitTestSource = hitTestSource;
      });
    });

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.12, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x1e5eff })
    );
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    const onSelect = () => {
      if (this.reticle?.visible) {
        this.placeModelOnGround(this.reticle.position.y);
        this.autoPlacedInAR = true;
        this.arPlacementPending = false;
      }
    };
    session.addEventListener('select', onSelect);
    session.addEventListener('end', () => {
      session.removeEventListener('select', onSelect);
      this.autoPlacedInAR = false;
      this.arPlacementPending = false;
      this.xrPresenting = false;
      if (this.model) {
        this.placeModelOnGround(0);
      }
      this.cdr.markForCheck();
    });
  }

  private startRenderLoop(): void {
    this.renderer.setAnimationLoop((time, frame) => {
      try {
        const now = performance.now();
        const delta = (now - this.lastFrameTime) / 1000;
        this.lastFrameTime = now;
        if (this.model && this.isLoading) {
          this.isLoading = false;
          this.loadingProgress = 100;
          this.cdr.markForCheck();
        }
        if (this.mixer && this.isPlaying) {
          this.mixer.update(delta);
          this.checkNavigationTarget();
        }

        this.updatePinchZoom();
        this.currentTime = this.activeAction ? this.activeAction.time : 0;
        this.updateTagsScreenPositions();
        this.controls?.update();

        if (frame && this.xrHitTestSource && this.xrReferenceSpace) {
          const hitTestResults = frame.getHitTestResults(this.xrHitTestSource);
          if (hitTestResults.length > 0 && this.reticle) {
            const pose = hitTestResults[0].getPose(this.xrReferenceSpace);
            if (pose) {
              this.reticle.visible = true;
              this.reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
              this.reticle.updateMatrixWorld(true);
              if (!this.autoPlacedInAR || this.arPlacementPending) {
                this.placeModelOnGround(this.reticle.position.y);
                this.autoPlacedInAR = true;
                this.arPlacementPending = false;
              }
            }
          }
        }

        this.renderer.render(this.scene, this.camera);

        if (now - this.lastUiTick > 100) {
          this.cdr.markForCheck();
          this.lastUiTick = now;
        }
      } catch (err) {
        console.error('Render loop error', err);
        this.isPlaying = false;
        this.loadError = 'Rendering paused due to an error. Please reload the model.';
        this.cdr.markForCheck();
      }
    });
  }

  private setupResizeListener(): void {
    window.addEventListener('resize', this.handleResize);
  }

  private handleResize = (): void => {
    const { clientWidth, clientHeight } = this.rendererHost.nativeElement;
    const width = Math.max(clientWidth, 320);
    const height = Math.max(clientHeight, 240);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private disposeCurrentModel(): void {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((child: any) => {
        if (child.isMesh) {
          child.geometry?.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((mat: any) => mat.dispose?.());
          } else {
            child.material?.dispose?.();
          }
        }
      });
    }
    this.model = null;
    this.mixer = null;
    this.activeAction = null;
  }

  private loadCourse(course: Course): void {
    if (!this.isInitialized || !course) return;

    this.isLoading = true;
    this.loadingProgress = 0;
    this.loadError = '';
    this.arPlacementPending = true;
    this.disposeCurrentModel();
    this.tags = [...course.tags];
    this.animationStops = this.sanitizeStops(course.animationStops);
    this.nextStopIndex = 0;
    this.isPlaying = false;

    if (!this.dracoLoader) {
      this.dracoLoader = new DRACOLoader();
      this.dracoLoader.setDecoderPath('assets/draco/');
      this.dracoLoader.setDecoderConfig({ type: 'wasm' });
    }

    const loader = new GLTFLoader();
    loader.setDRACOLoader(this.dracoLoader);

    const onLoad = (gltf: any) => {
      const model = gltf.scene;
      this.model = model;
      model.traverse((child: any) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      this.normalizeAndCenter(model);
      const box = new THREE.Box3().setFromObject(model);
      this.modelBaseYOffset = -box.min.y;
      model.userData.isCourseModel = true;
      this.clearExistingCourseModels();
      this.scene.add(model);
      model.position.set(0, 0, 0);
      // Reset pinch targets to the new normalized scale
      this.pinchBaseScale = model.scale.x;
      this.pinchTargetScale = model.scale.x;

      try {
        this.frameCameraToObject(model);
      } catch (err) {
        console.warn('Framing failed, using default camera', err);
      }

      if (gltf.animations && gltf.animations.length > 0) {
        this.mixer = new THREE.AnimationMixer(model);
        this.mixer.stopAllAction();
        this.activeAction = this.mixer.clipAction(gltf.animations[0]);
        this.activeAction.clampWhenFinished = false;
        this.activeAction.setLoop(THREE.LoopRepeat, Infinity);
        this.activeAction.enabled = true;
        this.activeAction.setEffectiveWeight(1);
        this.activeAction.setEffectiveTimeScale(1);
        this.activeAction.time = 0;
        this.activeAction.paused = true; // start paused until user presses play
        this.animationDuration = gltf.animations[0].duration;
        this.durationChange.emit(this.animationDuration);
        this.isPlaying = false;
      } else {
        this.animationDuration = 0;
        this.durationChange.emit(0);
      }
      this.currentTime = 0;
      this.resetNextStopIndex(0);
      this.isLoading = false;
      this.loadingProgress = 100;
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    };

    const onProgress = (event: ProgressEvent) => {
      if (event.lengthComputable) {
        this.loadingProgress = Math.round((event.loaded / event.total) * 100);
      } else {
        this.loadingProgress = Math.min(this.loadingProgress + 5, 95);
      }
      this.cdr.markForCheck();
      // do not detectChanges aggressively here to avoid thrash
    };

    const onError = (err: any) => {
      console.error('GLB load error', err);
      this.isLoading = false;
      this.loadError =
        'Unable to load model. Details: ' +
        ((err as any)?.message || (err as any)?.toString?.() || 'unknown error');
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    };

    if (course.modelUrl.startsWith('blob:')) {
      // Use fetch + parse for blob URLs to avoid CORS/Extension issues in GLTFLoader.load
      fetch(course.modelUrl)
        .then((res) => res.arrayBuffer())
        .then((buffer) => {
          loader.parse(buffer, '', onLoad, onError);
        })
        .catch(onError);
    } else {
      loader.setCrossOrigin('anonymous');
      loader.load(course.modelUrl, onLoad, onProgress, onError);
    }
  }

  private normalizeAndCenter(object: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // Avoid zero-size boxes
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    // In AR, 1 unit = 1 meter; use a smaller target to avoid filling the screen.
    const targetSize = this.renderer?.xr?.isPresenting ? 0.2 : 1; // meters when in AR
    const scale = targetSize / maxDim;

    object.position.sub(center); // center to origin
    object.scale.setScalar(scale);
    object.updateMatrixWorld(true);
  }

  private frameCameraToObject(object: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fitHeightDistance = maxDim / (2 * Math.atan((Math.PI * this.camera.fov) / 360));
    const fitWidthDistance = fitHeightDistance / this.camera.aspect;
    const distance = Math.max(fitHeightDistance, fitWidthDistance);

    const direction = new THREE.Vector3()
      .subVectors(this.camera.position, center)
      .normalize()
      .multiplyScalar(distance);
    this.camera.position.copy(center).add(direction);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  checkNavigationTarget(): void {
    if (!this.activeAction || this.navigationTarget === null || !this.navigationDirection) return;
    const t = this.activeAction.time;
    const epsilon = 0.0001;
    if (this.navigationDirection === 'forward' && t >= this.navigationTarget - epsilon) {
      const target = this.navigationTarget ?? t;
      this.navigationTarget = null;
      this.navigationDirection = null;
      this.seek(target);
      this.pause();
    }
    if (this.navigationDirection === 'backward' && this.navigationTarget !== null && t <= this.navigationTarget + epsilon) {
      const target = this.navigationTarget;
      this.navigationTarget = null;
      this.navigationDirection = null;
      this.seek(target ?? t);
      this.pause();
    }
  }

  private updateTagsScreenPositions(): void {
    if (!this.model || !this.camera) return;
    const visibleTags = this.tags.filter((tag) => this.shouldDisplayTag(tag));
    this.projectedTags = visibleTags.map((tag) => {
      const pos = new THREE.Vector3(tag.position.x, tag.position.y, tag.position.z);
      const projected = pos.project(this.camera);
      const x = (projected.x * 0.5 + 0.5) * this.renderer.domElement.clientWidth;
      const y = (-projected.y * 0.5 + 0.5) * this.renderer.domElement.clientHeight;
      return { ...tag, screenX: x, screenY: y };
    });
  }

  private shouldDisplayTag(tag: Tag3D): boolean {
    if (tag.hidden) return false;
    if (tag.alwaysVisible) return true;
    if (!this.activeAction) return true;
    const start = tag.visibleFrom ?? 0;
    const end = tag.visibleTo ?? this.animationDuration ?? Number.POSITIVE_INFINITY;
    const t = this.currentTime;
    return t >= start && t <= end;
  }

  addTagFromForm(form: {
    title: string;
    description: string;
    audioFile?: File | null;
    audioUrl?: string | null;
    visibleFrom?: number;
    visibleTo?: number;
    alwaysVisible?: boolean;
  }): void {
    if (!this.pendingTagPosition || !this.course) return;
    const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    let audioUrl: string | undefined;
    if (form.audioUrl) {
      audioUrl = form.audioUrl;
    } else if (form.audioFile) {
      audioUrl = URL.createObjectURL(form.audioFile);
    }
    const defaultStart = this.currentTime || 0;
    const duration = this.safeDuration() || defaultStart;
    const visibleFrom = form.alwaysVisible ? 0 : form.visibleFrom ?? defaultStart;
    const visibleTo = form.alwaysVisible ? duration : form.visibleTo ?? duration;
    const tag: Tag3D = {
      id,
      title: form.title,
      description: form.description,
      audioUrl,
      position: {
        x: this.pendingTagPosition.x,
        y: this.pendingTagPosition.y,
        z: this.pendingTagPosition.z,
      },
      visibleFrom,
      visibleTo,
      alwaysVisible: !!form.alwaysVisible,
    };
    this.tags = [...this.tags, tag];
    this.pendingTagPosition = null;
    this.tagsChange.emit(this.tags);
    this.updateTagsScreenPositions();
  }

  removeTag(id: string): void {
    this.tags = this.tags.filter((t) => t.id !== id);
    this.tagsChange.emit(this.tags);
  }

  playTagAudio(tag: Tag3D): void {
    if (!tag.audioUrl) return;
    const audio = new Audio(tag.audioUrl);
    audio.play();
  }

  hideTag(id: string): void {
    this.tags = this.tags.map((t) => (t.id === id ? { ...t, hidden: true } : t));
    this.tagsChange.emit(this.tags);
    this.updateTagsScreenPositions();
  }

  addStop(time: number, label?: string): void {
    if (!this.isValidTime(time)) return;
    const stop: AnimationStop = { id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36), time, label };
    this.animationStops = this.sanitizeStops([...this.animationStops, stop]);
    this.resetNextStopIndex(this.currentTime);
    this.stopsChange.emit(this.animationStops);
  }

  addStopFromInputs(timeInput: HTMLInputElement, labelInput?: HTMLInputElement): void {
    const raw = timeInput?.valueAsNumber;
    const time = this.isValidTime(raw) ? raw : this.currentTime;
    const label = labelInput?.value?.trim() || undefined;
    try {
      this.addStop(time, label);
    } catch (err) {
      console.error('Failed to add stop', err);
    }
    if (timeInput) timeInput.value = '';
    if (labelInput) labelInput.value = '';
  }

  removeStop(id: string): void {
    this.animationStops = this.animationStops.filter((s) => s.id !== id);
    this.resetNextStopIndex(this.currentTime);
    this.stopsChange.emit(this.animationStops);
  }

  seek(time: number): void {
    if (!this.activeAction || !this.mixer) return;
    if (!this.isValidTime(time)) return;
    const duration = this.safeDuration();
    const clipped = Math.max(0, Math.min(time, duration));
    this.mixer.setTime(clipped);
    this.activeAction.time = clipped;
    this.currentTime = clipped;
    this.resetNextStopIndex(clipped);
  }

  togglePlay(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  formatStopLabel(time: number): string {
    const t = Number.isFinite(time) ? time : 0;
    return `Stop @ ${t.toFixed(2)}s`;
  }

  play(): void {
    if (!this.activeAction) return;
    this.navigationTarget = null;
    this.navigationDirection = null;
    this.activeAction.paused = false;
    this.activeAction.play();
    this.activeAction.setEffectiveTimeScale(1);
    this.isPlaying = true;
    this.cdr.markForCheck();
  }

  pause(): void {
    if (!this.activeAction) return;
    this.activeAction.paused = true;
    this.isPlaying = false;
    this.cdr.markForCheck();
  }

  jumpToNextStop(): void {
    if (!this.animationStops.length || !this.activeAction) return;
    const sorted = [...this.animationStops].sort((a, b) => a.time - b.time);
    const current = this.activeAction.time;
    const next = sorted.find((s) => s.time > current + 0.001);
    if (next) {
      this.nextStopIndex = sorted.findIndex((s) => s.id === next.id);
      this.startNavigation(next.time, 'forward');
    } else {
      // already at or past last stop; do nothing
    }
  }

  jumpToPreviousStop(): void {
    if (!this.animationStops.length || !this.activeAction) return;
    const sorted = [...this.animationStops].sort((a, b) => a.time - b.time);
    const current = this.activeAction.time;
    const prev = [...sorted].reverse().find((s) => s.time < current - 0.001);
    if (prev) {
      const idx = sorted.findIndex((s) => s.id === prev.id);
      this.nextStopIndex = Math.min(idx + 1, sorted.length - 1);
      this.startNavigation(prev.time, 'backward');
    } else {
      // at first stop, stay put
    }
  }

  private resetNextStopIndex(currentTime: number): void {
    const sorted = [...this.animationStops].sort((a, b) => a.time - b.time);
    if (!sorted.length) {
      this.nextStopIndex = 0;
      return;
    }
    const idx = sorted.findIndex((s) => s.time >= currentTime);
    this.nextStopIndex = idx >= 0 ? idx : sorted.length - 1;
  }

  private startNavigation(target: number, direction: 'forward' | 'backward'): void {
    if (!this.activeAction) return;
    this.navigationTarget = target;
    this.navigationDirection = direction;
    const speed = direction === 'forward' ? 1 : -1;
    this.activeAction.setEffectiveTimeScale(speed);
    this.activeAction.paused = false;
    this.activeAction.play();
    this.isPlaying = true;
    this.cdr.markForCheck();
  }

  private setupPinchZoom(): void {
    const dom = this.renderer?.domElement;
    if (!dom) return;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2 && this.model) {
        this.pinchStartDist = this.getTouchDistance(e);
        this.pinchBaseScale = this.model.scale.x;
        this.pinchTargetScale = this.pinchBaseScale;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !this.model || !this.pinchStartDist) return;
      e.preventDefault();
      const dist = this.getTouchDistance(e);
      const factor = dist / this.pinchStartDist;
      const next = THREE.MathUtils.clamp(this.pinchBaseScale * factor, 0.2, 5);
      this.pinchTargetScale = next;
    };
    const onTouchEnd = () => {
      this.pinchStartDist = 0;
    };
    // Attach both to canvas and window to catch touches during AR domOverlay
    dom.addEventListener('touchstart', onTouchStart, { passive: false });
    dom.addEventListener('touchmove', onTouchMove, { passive: false });
    dom.addEventListener('touchend', onTouchEnd);
    dom.addEventListener('touchcancel', onTouchEnd);
    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
    this.pinchListenerCleanup = () => {
      dom.removeEventListener('touchstart', onTouchStart);
      dom.removeEventListener('touchmove', onTouchMove);
      dom.removeEventListener('touchend', onTouchEnd);
      dom.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }

  private teardownPinchZoom(): void {
    this.pinchListenerCleanup?.();
    this.pinchListenerCleanup = null;
  }

  private getTouchDistance(e: TouchEvent): number {
    if (e.touches.length < 2) return 0;
    const [t0, t1] = [e.touches[0], e.touches[1]];
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.hypot(dx, dy);
  }

  private updatePinchZoom(): void {
    if (!this.model) return;
    const current = this.model.scale.x;
    const next = THREE.MathUtils.lerp(current, this.pinchTargetScale, this.pinchSmooth);
    this.model.scale.setScalar(next);
  }

  startRecording(): void {
    this.recordError = '';
    if (!navigator.mediaDevices?.getUserMedia) {
      this.recordError = 'Recording not supported on this device.';
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        this.recordedChunks = [];
        this.mediaRecorder = new MediaRecorder(stream);
        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.recordedChunks.push(e.data);
        };
        this.mediaRecorder.onstop = () => {
          const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
          this.recordedAudioUrl = URL.createObjectURL(blob);
          stream.getTracks().forEach((t) => t.stop());
          this.isRecording = false;
          this.cdr.markForCheck();
        };
        this.mediaRecorder.start();
        this.isRecording = true;
        this.cdr.markForCheck();
      })
      .catch((err) => {
        this.recordError = err?.message || 'Unable to start recording.';
        this.isRecording = false;
        this.cdr.markForCheck();
      });
  }

  stopRecording(): void {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
    }
  }
}
