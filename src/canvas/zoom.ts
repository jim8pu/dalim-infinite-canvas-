import { Point } from '../core/types';
import { FLOOR_BASE } from '../core/constants';

/**
 * Node within a multi-floor infinite canvas tree space.
 */
export class ZoomFloor {
  index: number;
  parent: ZoomFloor | null;
  child: ZoomFloor | null;
  originInParent: Point;
  BASE: number;
  _hasStrokes?: boolean;

  constructor(index: number, originInParent: Point = { x: 0, y: 0 }, parent: ZoomFloor | null = null) {
      this.index = index;
      this.parent = parent;
      this.child = null;
      this.originInParent = { ...originInParent };
      this.BASE = FLOOR_BASE;
  }

  getOrCreateChild(originInParent: Point): ZoomFloor {
      if (!this.child) {
          this.child = new ZoomFloor(this.index + 1, originInParent, this);
      } else {
          // Check if any strokes exist on the child floor
          // If no strokes, re-center the child's origin
          if (!this.child._hasStrokes) {
              this.child.originInParent = { ...originInParent };
              this.child.child = null; // Reset deeper floors too
          }
      }
      return this.child;
  }

  toJSON(): import('../core/types').SerializedZoomFloor {
      return {
          index: this.index,
          originInParent: { ...this.originInParent },
          child: this.child ? this.child.toJSON() : null,
          _hasStrokes: this._hasStrokes,
      };
  }

  static fromJSON(data: import('../core/types').SerializedZoomFloor | null, parent: ZoomFloor | null = null): ZoomFloor | null {
      if (!data) return null;
      const floor = new ZoomFloor(data.index, data.originInParent, parent);
      if (data._hasStrokes) floor._hasStrokes = true;
      if (data.child) {
          floor.child = ZoomFloor.fromJSON(data.child, floor);
      }
      return floor;
  }

  getRoot(): ZoomFloor {
      let f: ZoomFloor = this;
      while (f.parent) f = f.parent;
      return f;
  }

  getFloorByIndex(targetIndex: number): ZoomFloor | null {
      let f: ZoomFloor | null = this.getRoot();
      if (targetIndex < f.index) return null;
      while (f && f.index < targetIndex) f = f.child;
      return (f && f.index === targetIndex) ? f : null;
  }
}

/**
 * Transforms a world point from its native floor to the target floor continuously in Float64
 */
export function transformPointToFloor(pt: Point, srcFloorIndex: number, dstFloor: ZoomFloor): Point {
  let p = { x: pt.x, y: pt.y };
  let f: ZoomFloor | null = dstFloor.getRoot().getFloorByIndex(srcFloorIndex);
  if (!f) return p;

  if (srcFloorIndex < dstFloor.index) {
      // Walk down (zoom deeper)
      while (f && f.index < dstFloor.index && f.child) {
          f = f.child;
          p.x = (p.x - f.originInParent.x) * f.BASE;
          p.y = (p.y - f.originInParent.y) * f.BASE;
      }
  } else if (srcFloorIndex > dstFloor.index) {
      // Walk up (zoom out)
      while (f && f.index > dstFloor.index && f.parent) {
          p.x = p.x / f.BASE + f.originInParent.x;
          p.y = p.y / f.BASE + f.originInParent.y;
          f = f.parent;
      }
  }
  return p;
}

/** Interface required by transitionFloor */
export interface TransitionViewState {
  scale: number;
  panOffset: Point;
  targetScale: number;
  targetPanOffset: Point;
  currentFloor: ZoomFloor;
}

/**
 * Perform floor transition on both current and target view values
 */
export function transitionFloor(viewState: TransitionViewState, direction: 'up' | 'down') {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
  const w = (canvas?.width || 0) / dpr;
  const h = (canvas?.height || 0) / dpr;
  const screenCenterX = w / 2;
  const screenCenterY = h / 2;

  if (direction === 'up') {
      const worldCenterX = (screenCenterX - viewState.panOffset.x) / viewState.scale;
      const worldCenterY = (screenCenterY - viewState.panOffset.y) / viewState.scale;
      const child = viewState.currentFloor.getOrCreateChild({ x: worldCenterX, y: worldCenterY });
      const origin = child.originInParent;

      const newScale = viewState.scale / FLOOR_BASE;
      viewState.panOffset.x = viewState.panOffset.x + origin.x * viewState.scale;
      viewState.panOffset.y = viewState.panOffset.y + origin.y * viewState.scale;
      viewState.scale = newScale;

      const newTargetScale = viewState.targetScale / FLOOR_BASE;
      viewState.targetPanOffset.x = viewState.targetPanOffset.x + origin.x * viewState.targetScale;
      viewState.targetPanOffset.y = viewState.targetPanOffset.y + origin.y * viewState.targetScale;
      viewState.targetScale = newTargetScale;

      viewState.currentFloor = child;
  } else if (direction === 'down' && viewState.currentFloor.parent) {
      const origin = viewState.currentFloor.originInParent;

      const newScale = viewState.scale * FLOOR_BASE;
      viewState.panOffset.x = viewState.panOffset.x - origin.x * newScale;
      viewState.panOffset.y = viewState.panOffset.y - origin.y * newScale;
      viewState.scale = newScale;

      const newTargetScale = viewState.targetScale * FLOOR_BASE;
      viewState.targetPanOffset.x = viewState.targetPanOffset.x - origin.x * newTargetScale;
      viewState.targetPanOffset.y = viewState.targetPanOffset.y - origin.y * newTargetScale;
      viewState.targetScale = newTargetScale;

      viewState.currentFloor = viewState.currentFloor.parent;
  }
}
