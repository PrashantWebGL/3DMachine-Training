export type UserRole = 'trainer' | 'trainee';

export interface Tag3D {
  id: string;
  title: string;
  description: string;
  audioUrl?: string;
  position: { x: number; y: number; z: number };
  /**
   * If set, tag is visible only between these times (seconds) unless alwaysVisible is true.
   * Defaults to full animation range.
   */
  visibleFrom?: number;
  visibleTo?: number;
  /** Flag to pin the tag for the entire animation. */
  alwaysVisible?: boolean;
}

export interface AnimationStop {
  id: string;
  time: number; // seconds
  label?: string;
}

export interface Course {
  id: string;
  title: string;
  description?: string;
  modelUrl: string;
  tags: Tag3D[];
  animationStops: AnimationStop[];
  duration?: number;
  status?: 'draft' | 'ready';
}
