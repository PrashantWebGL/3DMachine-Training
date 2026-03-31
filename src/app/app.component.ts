import { Component, OnInit } from '@angular/core';
import { AnimationStop, Course, Tag3D, UserRole } from './models/course.model';
import { CourseStorageService } from './services/course-storage.service';

interface LibraryModel {
  id: string;
  name: string;
  description: string;
  glbPath: string;
  imagePath: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent implements OnInit {
  view: 'landing' | 'trainer' | 'trainee' = 'landing';
  role: UserRole = 'trainer';
  courses: Course[] = [];
  selectedCourse: Course | null = null;

  trainerTab: 'create' | 'my-courses' = 'create';
  trainerStep: 'create' | 'upload' | 'edit' = 'create';

  draftTitle = '';
  draftDescription = '';
  draftModelName = '';
  draftModelUrl = '';
  editingCourse: Course | null = null;
  exporting = false;
  private fileHandle: FileSystemFileHandle | null = null;

  libraryModels: LibraryModel[] = [
    {
      id: 'industrial_robot_arm',
      name: 'Industrial Robot Arm',
      description: '6-axis articulated arm with sample animation.',
      glbPath: 'assets/models/industrial_robot_arm.glb',
      imagePath: 'assets/thumbnails/industrial_robot_arm.png',
    },
    {
      id: 'delta_robot_irb_390',
      name: 'Delta Robot IRB 390',
      description: 'High-speed delta picker with looping motion.',
      glbPath: 'assets/models/delta_robot_irb_390.glb',
      imagePath: 'assets/thumbnails/delta_robot_irb_390.png',
    },
    {
      id: 'kuka_robot_arm',
      name: 'Kuka Robot Arm',
      description: 'Collaborative-style manipulator with multi-step path.',
      glbPath: 'assets/models/kuka_robot_arm.glb',
      imagePath: 'assets/thumbnails/Kuka_manipulator.png',
    },
  ];

  constructor(private storage: CourseStorageService) { }

  ngOnInit(): void {
    this.courses = this.storage.getAll();
    if (this.courses.length === 0) {
      this.seedDefaultCourse();
    }
    this.selectedCourse = this.courses[0] || null;
  }

  private seedDefaultCourse(): void {
    const starter: Course = {
      id: 'starter-course',
      title: 'Industrial Robot Arm (Sample)',
      description: 'Preloaded sample course with animations for quick preview.',
      modelUrl: 'assets/models/industrial_robot_arm.glb',
      tags: [],
      animationStops: [],
      duration: 0,
      status: 'ready',
    };
    this.storage.upsert(starter);
    this.courses = this.storage.getAll();
  }

  openRole(role: UserRole): void {
    this.role = role;
    this.view = role;
    if (role === 'trainer') {
      this.startNewCourse();
    } else {
      this.selectedCourse = null;
    }
  }

  startNewCourse(): void {
    this.trainerTab = 'create';
    this.trainerStep = 'create';
    this.draftTitle = '';
    this.draftDescription = '';
    this.draftModelName = '';
    this.draftModelUrl = '';
    this.editingCourse = null;
    this.selectedCourse = null;
  }

  onModelFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.draftModelUrl = URL.createObjectURL(file);
    this.draftModelName = file.name;

    if (this.editingCourse) {
      this.editingCourse.modelUrl = this.draftModelUrl;
      this.selectedCourse = { ...this.editingCourse };
      this.trainerStep = 'edit';
      this.storage.upsert(this.selectedCourse);
      this.refreshCourses();
    }
  }

  createCourse(): void {
    if (!this.draftTitle) return;
    const course: Course = {
      id: `course-${Date.now()}`,
      title: this.draftTitle.trim(),
      description: this.draftDescription.trim(),
      modelUrl: '',
      tags: [],
      animationStops: [],
      duration: 0,
      status: 'draft',
    };
    this.editingCourse = course;
    this.trainerStep = 'upload';
  }

  selectCourse(course: Course): void {
    this.selectedCourse = course;
    this.editingCourse = this.role === 'trainer' ? { ...course } : null;
    this.trainerStep = this.role === 'trainer' ? 'edit' : this.trainerStep;
    this.trainerTab = 'my-courses';
  }

  deleteCourse(courseId: string): void {
    this.storage.delete(courseId);
    this.refreshCourses();
    if (this.selectedCourse?.id === courseId) {
      this.selectedCourse = this.courses[0] || null;
    }
  }

  onTagsChange(tags: Tag3D[]): void {
    if (!this.selectedCourse || this.role !== 'trainer') return;
    this.selectedCourse = { ...this.selectedCourse, tags };
    this.storage.upsert(this.selectedCourse);
    this.refreshCourses();
  }

  onStopsChange(stops: AnimationStop[]): void {
    if (!this.selectedCourse || this.role !== 'trainer') return;
    this.selectedCourse = { ...this.selectedCourse, animationStops: stops };
    this.storage.upsert(this.selectedCourse);
    this.refreshCourses();
  }

  onDurationChange(duration: number): void {
    if (!this.selectedCourse || this.role !== 'trainer') return;
    this.selectedCourse = { ...this.selectedCourse, duration };
    this.storage.upsert(this.selectedCourse);
    this.refreshCourses();
  }

  completeCourse(): void {
    if (!this.selectedCourse || !this.selectedCourse.modelUrl) return;
    const saved: Course = { ...this.selectedCourse, status: 'ready' };
    this.selectedCourse = saved;
    this.editingCourse = saved;
    this.storage.upsert(saved);
    this.refreshCourses();
    this.trainerTab = 'my-courses';
    this.trainerStep = 'edit';
    this.view = 'trainer'; // ensure the shell shows My Courses after completion
  }

  showUploadStep(): boolean {
    return this.role === 'trainer' && this.trainerStep === 'upload';
  }

  showEditStep(): boolean {
    if (this.role === 'trainee') return !!this.selectedCourse;
    return this.trainerStep === 'edit' && !!this.selectedCourse;
  }

  applySampleModel(path: string): void {
    if (!this.selectedCourse || this.role !== 'trainer') return;
    this.selectedCourse = { ...this.selectedCourse, modelUrl: path, status: 'ready' };
    this.storage.upsert(this.selectedCourse);
    this.refreshCourses();
    this.trainerStep = 'edit';
  }

  getVisibleCourses(): Course[] {
    return this.selectedCourse ? [this.selectedCourse] : this.courses;
  }

  async exportCourses(): Promise<void> {
    try {
      this.exporting = true;
      const serialized = [];
      for (const course of this.courses) {
        serialized.push(await this.serializeCourse(course));
      }
      const data = JSON.stringify(serialized, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'courses-export.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed', err);
      alert('Export failed. See console for details.');
    } finally {
      this.exporting = false;
    }
  }

  importCourses(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (!Array.isArray(parsed)) throw new Error('Invalid format');
        const hydrated = parsed.map((c: any) => this.hydrateCourse(c));
        this.storage.replaceAll(hydrated);
        this.refreshCourses();
        this.selectedCourse = this.courses[0] || null;
      } catch (err) {
        console.error('Import failed', err);
        alert('Could not import courses. Ensure the file is a valid courses-export.json.');
      }
      input.value = '';
    };
    reader.readAsText(file);
  }

  async chooseProjectFile(): Promise<void> {
    const w = window as any;
    if (!w.showOpenFilePicker && !w.showSaveFilePicker) {
      alert('File System Access API not supported in this browser. Use Export/Import instead.');
      return;
    }
    try {
      // Let user pick existing or create new
      const handle =
        (await w.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'Training JSON', accept: { 'application/json': ['.json'] } }],
        }).then((res: any) => res[0])) ||
        (await w.showSaveFilePicker({
          suggestedName: 'courses.json',
          types: [{ description: 'Training JSON', accept: { 'application/json': ['.json'] } }],
        }));
      this.fileHandle = handle;
      await this.loadFromLinkedFile();
    } catch (err) {
      if ((err as any).name !== 'AbortError') console.error('chooseProjectFile failed', err);
    }
  }

  async saveToLinkedFile(): Promise<void> {
    if (!this.fileHandle) {
      alert('No linked project file. Choose one first.');
      return;
    }
    try {
      const serialized = [];
      for (const course of this.courses) {
        serialized.push(await this.serializeCourse(course));
      }
      const data = JSON.stringify(serialized, null, 2);
      const writable = await (this.fileHandle as any).createWritable();
      await writable.write(data);
      await writable.close();
      alert('Saved to linked project file.');
    } catch (err) {
      console.error('saveToLinkedFile failed', err);
      alert('Save failed. See console for details.');
    }
  }

  private async loadFromLinkedFile(): Promise<void> {
    if (!this.fileHandle) return;
    try {
      const file = await (this.fileHandle as any).getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Invalid format');
      const hydrated = parsed.map((c: any) => this.hydrateCourse(c));
      this.storage.replaceAll(hydrated);
      this.refreshCourses();
      this.selectedCourse = this.courses[0] || null;
      alert('Loaded courses from linked file.');
    } catch (err) {
      console.error('loadFromLinkedFile failed', err);
      alert('Could not load linked file. See console for details.');
    }
  }

  useLibraryModel(model: LibraryModel): void {
    if (!this.editingCourse) return;
    const updated: Course = {
      ...this.editingCourse,
      modelUrl: model.glbPath,
      status: 'draft',
    };
    this.editingCourse = updated;
    this.selectedCourse = updated;
    this.draftModelName = model.name;
    this.draftModelUrl = model.glbPath;
    this.trainerStep = 'edit';
    this.storage.upsert(updated);
    this.refreshCourses();
  }

  private refreshCourses(): void {
    const prevId = this.selectedCourse?.id;
    this.courses = this.storage.getAll();
    if (prevId) {
      this.selectedCourse = this.courses.find((c) => c.id === prevId) || this.courses[0] || null;
    } else {
      this.selectedCourse = this.courses[0] || null;
    }
  }

  private async serializeCourse(course: Course): Promise<any> {
    const tags = [];
    for (const tag of course.tags) {
      let audioDataUrl: string | undefined;
      if (tag.audioUrl) {
        try {
          audioDataUrl = await this.toDataUrl(tag.audioUrl);
        } catch (err) {
          console.warn('Failed to embed audio for tag', tag.id, err);
        }
      }
      tags.push({ ...tag, audioDataUrl });
    }
    return { ...course, tags };
  }

  private hydrateCourse(raw: any): Course {
    const tags = (raw.tags || []).map((t: any) => {
      let audioUrl = t.audioUrl;
      if (!audioUrl && t.audioDataUrl) {
        try {
          const blob = this.dataUrlToBlob(t.audioDataUrl);
          audioUrl = URL.createObjectURL(blob);
        } catch (err) {
          console.warn('Failed to restore audio for tag', t.id, err);
        }
      }
      const { audioDataUrl, ...rest } = t;
      return { ...rest, audioUrl };
    });
    return { ...raw, tags };
  }

  private async toDataUrl(url: string): Promise<string> {
    const res = await fetch(url);
    const blob = await res.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private dataUrlToBlob(dataUrl: string): Blob {
    const [meta, data] = dataUrl.split(',');
    const mimeMatch = meta.match(/data:(.*);base64/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: mime });
  }
}
