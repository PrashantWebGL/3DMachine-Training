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

  constructor(private cdr: ChangeDetectorRef) {}
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
    });

    this.renderer.xr.addEventListener('sessionend', () => {
      this.xrHitTestSource = null;
      this.xrReferenceSpace = null;
      if (this.reticle) {
        this.scene.remove(this.reticle);
      }
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
          this.checkStopPoints();
        }

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
      model.userData.isCourseModel = true;
      this.clearExistingCourseModels();
      this.scene.add(model);

      try {
        this.frameCameraToObject(model);
      } catch (err) {
        console.warn('Framing failed, using default camera', err);
      }

      if (gltf.animations && gltf.animations.length > 0) {
        this.mixer = new THREE.AnimationMixer(model);
        this.mixer.stopAllAction();
        this.activeAction = this.mixer.clipAction(gltf.animations[0]);
        this.activeAction.clampWhenFinished = true;
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
    const targetSize = 3; // world units
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

  private checkStopPoints(): void {
    if (!this.activeAction || this.animationStops.length === 0) return;
    const currentTime = this.activeAction.time;
    const stopsSorted = [...this.animationStops].sort((a, b) => a.time - b.time);
    const nextStop = stopsSorted[this.nextStopIndex];
    if (nextStop && currentTime >= nextStop.time) {
      this.pause();
      this.nextStopIndex = Math.min(this.nextStopIndex + 1, stopsSorted.length - 1);
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
    visibleFrom?: number;
    visibleTo?: number;
    alwaysVisible?: boolean;
  }): void {
    if (!this.pendingTagPosition || !this.course) return;
    const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    let audioUrl: string | undefined;
    if (form.audioFile) {
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
    this.activeAction.reset();
    this.activeAction.paused = false;
    this.activeAction.play();
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
      this.seek(current); // ensure we start from exact current time
      this.nextStopIndex = sorted.findIndex((s) => s.id === next.id);
      this.play();
    } else {
      // loop back to first stop
      this.seek(sorted[0].time);
      this.nextStopIndex = 0;
      this.play();
    }
  }

  jumpToPreviousStop(): void {
    if (!this.animationStops.length || !this.activeAction) return;
    const sorted = [...this.animationStops].sort((a, b) => a.time - b.time);
    const current = this.activeAction.time;
    const prev = [...sorted].reverse().find((s) => s.time < current - 0.001);
    if (prev) {
      this.seek(prev.time);
      this.nextStopIndex = sorted.findIndex((s) => s.id === prev.id);
      this.pause();
    } else {
      this.seek(sorted[sorted.length - 1].time);
      this.nextStopIndex = sorted.length - 1;
      this.pause();
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
}
