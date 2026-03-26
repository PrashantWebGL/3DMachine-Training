import { Injectable } from '@angular/core';
import { Course } from '../models/course.model';

const STORAGE_KEY = 'training-platform-courses';

@Injectable({
  providedIn: 'root',
})
export class CourseStorageService {
  private courses: Course[] = [];

  constructor() {
    this.load();
  }

  getAll(): Course[] {
    return this.courses;
  }

  upsert(course: Course): void {
    const index = this.courses.findIndex((c) => c.id === course.id);
    if (index >= 0) {
      this.courses[index] = course;
    } else {
      this.courses.push(course);
    }
    this.persist();
  }

  delete(id: string): void {
    this.courses = this.courses.filter((c) => c.id !== id);
    this.persist();
  }

  private load(): void {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      try {
        this.courses = JSON.parse(raw);
      } catch (err) {
        console.warn('Failed to parse stored courses', err);
      }
    }
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.courses));
  }
}
