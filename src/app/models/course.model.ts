export type UserRole = 'trainer' | 'trainee';

export interface Tag3D {
  id: string;
  title: string;
  description: string;
  audioUrl?: string;
  /** Position in world space (legacy) or model-local space if localPosition is set. */
  position: { x: number; y: number; z: number };
  /** Preferred: position stored in model-local coordinates to stay attached through transforms. */
  localPosition?: { x: number; y: number; z: number };
  /** 
   * If set, tag is visible only between these times (seconds) unless alwaysVisible is true.
   * Defaults to full animation range.
   */
  visibleFrom?: number;
  visibleTo?: number;
  /** Flag to pin the tag for the entire animation. */
  alwaysVisible?: boolean;
  /** When true, tag overlay is hidden (not rendered) without deleting the tag. */
  hidden?: boolean;
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
