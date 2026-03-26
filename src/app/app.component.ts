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
      id: 'boka_manipulator',
      name: 'Boka Manipulator',
      description: 'Collaborative-style manipulator with multi-step path.',
      glbPath: 'assets/models/boka_manipulator.glb',
      imagePath: 'assets/thumbnails/boka_manipulator.png',
    },
  ];

  constructor(private storage: CourseStorageService) {}

  ngOnInit(): void {
    this.courses = this.storage.getAll();
    if (this.courses.length === 0) {
      this.seedDefaultCourse();
    }
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
    this.courses = this.storage.getAll();
  }
}
