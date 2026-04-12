/** 2D coordinate */
export interface Point {
  x: number;
  y: number;
}

/** GPU buffer references cached on each stroke */
export interface StrokeGPUData {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  tessellationScale?: number;
  floorIndex?: number;
}

/** A single drawn stroke (pen, highlighter, shape, eraser) */
export interface Stroke {
  id: string | number;
  type: string;
  points: Point[];
  color: string;
  opacity: number;
  floorIndex: number;
  worldWidth?: number;
  lineWidth?: number;
  isErasing?: boolean;
  gpuData?: StrokeGPUData | null;
  rawPoints?: Point[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** A canvas layer containing strokes */
export interface Layer {
  id: number;
  name: string;
  isVisible: boolean;
  strokes: Stroke[];
}

/** Serialised form of a ZoomFloor for persistence */
export interface SerializedZoomFloor {
  index: number;
  originInParent: Point;
  child: SerializedZoomFloor | null;
  _hasStrokes?: boolean;
}

/** Persisted state for a single canvas card */
export interface CanvasData {
  layers: Layer[];
  activeLayerId: number;
  panOffset: Point;
  scale: number;
  floorTree: SerializedZoomFloor;
  currentFloorIndex: number;
  strokes?: Stroke[];
}

/** A card inside a revision column */
export interface KanbanCard {
  id: number;
  title: string;
  canvasState: CanvasData;
}

/** A column in the revision board */
export interface RevisionColumn {
  id: number;
  title: string;
  cards: KanbanCard[];
}
export type KanbanColumn = RevisionColumn;

/** The top-level revision board */
export interface RevisionBoard {
  title: string;
  columns: RevisionColumn[];
}

/** Root application data */
export interface AppData {
  revisions: RevisionBoard;
}

/** Laser pointer point with timestamp */
export interface LaserPoint extends Point {
  time: number;
}

/** Bounding box */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resize handle descriptor */
export interface ResizeHandle {
  x: number;
  y: number;
  cursor: string;
  type: string;
}

/** Temporary shape being drawn */
export interface TempShape {
  id: string | number;
  type: string;
  color?: string;
  opacity?: number;
  lineWidth?: number;
  floorIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  gpuData?: StrokeGPUData | null;
  points?: Point[];
  isErasing?: boolean;
  worldWidth?: number;
}

/** Brush settings for each tool */
export interface BrushSettings {
  color?: string;
  lineWidth: number;
  opacity?: number;
  smoothness?: number;
}

/** An undo/redo action */
export interface HistoryAction {
  type: 'ADD' | 'REMOVE' | 'MODIFY';
  strokes?: Stroke[];
  before?: Stroke[];
  after?: Stroke[];
  layerId: number;
}

/** Per-card undo/redo stack */
export interface CardHistory {
  history: HistoryAction[];
  historyIndex: number;
}

/** Canvas UI interaction state */
export interface CanvasUIState {
  isDrawing: boolean;
  isPanning: boolean;
  isLassoing: boolean;
  isMovingSelection: boolean;
  isResizingSelection: boolean;
  lastPos: Point;
  panStart: Point;
  activeTool: string;
  lassoPoints: Point[];
  laserPoints: LaserPoint[];
  selectedStrokes: Set<string | number>;
  selectionBox: Box | null;
  resizeHandle: ResizeHandle | null;
  tempShape: TempShape | null;
  activeSettingWedge: string | null;
}

declare global {
  interface Window {
    updateActiveWedge?: () => void;
  }
}

import type { ZoomFloor } from '../canvas/zoom';

export interface ViewState {
  scale: number;
  panOffset: Point;
  targetScale: number;
  targetPanOffset: Point;
  currentFloor: ZoomFloor;
}
