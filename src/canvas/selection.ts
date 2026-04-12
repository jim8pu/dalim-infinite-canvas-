import { Point, Stroke, Box } from '../core/types';
import { canvasState, getActiveLayer } from '../core/store';
import { isPointInPolygon, getStrokeBounds } from '../utils/math';
import { showSelectionToolbar, hideSelectionToolbar } from '../ui/Toolbar';

export function selectStrokesInLasso() {
    const activeLayer = getActiveLayer(); 
    if (!activeLayer) return;

    canvasState.selectedStrokes.clear();
    activeLayer.strokes.forEach((stroke: Stroke) => {
        if (stroke.points && stroke.points.length > 0) {
            if (stroke.points.some((p: Point) => isPointInPolygon(p, canvasState.lassoPoints))) {
                canvasState.selectedStrokes.add(stroke.id);
            }
        } else {
            const bounds = getStrokeBounds(stroke);
            const corners = [
                { x: bounds.minX, y: bounds.minY }, 
                { x: bounds.maxX, y: bounds.minY }, 
                { x: bounds.maxX, y: bounds.maxY }, 
                { x: bounds.minX, y: bounds.maxY }
            ];
            if (corners.some(p => isPointInPolygon(p, canvasState.lassoPoints))) {
                canvasState.selectedStrokes.add(stroke.id);
            }
        }
    });

    canvasState.lassoPoints = [];
    calculateSelectionBox();
}

export function calculateSelectionBox() {
    const activeLayer = getActiveLayer();
    if (!activeLayer || canvasState.selectedStrokes.size === 0) {
        canvasState.selectionBox = null;
        hideSelectionToolbar();
        return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    activeLayer.strokes.forEach((stroke: Stroke) => {
        if (canvasState.selectedStrokes.has(stroke.id)) {
            const b = getStrokeBounds(stroke);
            minX = Math.min(minX, b.minX); 
            minY = Math.min(minY, b.minY);
            maxX = Math.max(maxX, b.maxX); 
            maxY = Math.max(maxY, b.maxY);
        }
    });

    canvasState.selectionBox = { 
        x: minX, 
        y: minY, 
        width: maxX - minX, 
        height: maxY - minY 
    };
    showSelectionToolbar();
}

export function getResizeHandles(box: Box | null) {
    if (!box) return [];
    return [
        { x: box.x, y: box.y, cursor: 'nwse-resize', type: 'tl' },
        { x: box.x + box.width, y: box.y, cursor: 'nesw-resize', type: 'tr' },
        { x: box.x, y: box.y + box.height, cursor: 'nesw-resize', type: 'bl' },
        { x: box.x + box.width, y: box.y + box.height, cursor: 'nwse-resize', type: 'br' },
    ];
}

export function getResizeHandleUnderCursor(pos: Point) {
    const handleSize = 1.5;
    if (!canvasState.selectionBox) return null;
    return getResizeHandles(canvasState.selectionBox).find(h =>
        pos.x >= h.x - handleSize / 2 && pos.x <= h.x + handleSize / 2 &&
        pos.y >= h.y - handleSize / 2 && pos.y <= h.y + handleSize / 2
    );
}

export function moveSelection(dx: number, dy: number) {
    const activeLayer = getActiveLayer(); 
    if (!activeLayer) return;

    activeLayer.strokes.forEach((stroke: Stroke) => {
        if (canvasState.selectedStrokes.has(stroke.id)) {
            if (stroke.points && stroke.points.length > 0) { 
                stroke.points.forEach((p: Point) => { p.x += dx; p.y += dy; }); 
            } else if (stroke.x !== undefined && stroke.y !== undefined) { 
                stroke.x += dx; 
                stroke.y += dy; 
            }
            if(stroke.gpuData){ stroke.gpuData.vertexBuffer.destroy(); stroke.gpuData.indexBuffer.destroy(); stroke.gpuData = null; }
        }
    });

    if (canvasState.selectionBox) {
        canvasState.selectionBox.x += dx;
        canvasState.selectionBox.y += dy;
    }
}

export function resizeSelection(dx: number, dy: number) {
    const activeLayer = getActiveLayer(); 
    if (!activeLayer) return;

    const box = canvasState.selectionBox!;
    const handleType = canvasState.resizeHandle!.type;
    const originalBox = { ...box };
    let scaleX = 1, scaleY = 1, originX = 0, originY = 0;

    if (handleType.includes('r')) { box.width += dx; originX = originalBox.x; }
    if (handleType.includes('l')) { box.width -= dx; box.x += dx; originX = originalBox.x + originalBox.width; }
    if (handleType.includes('b')) { box.height += dy; originY = originalBox.y; }
    if (handleType.includes('t')) { box.height -= dy; box.y += dy; originY = originalBox.y + originalBox.height; }

    if (Math.abs(originalBox.width) > 0.001) scaleX = box.width / originalBox.width;
    if (Math.abs(originalBox.height) > 0.001) scaleY = box.height / originalBox.height;

    activeLayer.strokes.forEach((stroke: Stroke) => {
        if (canvasState.selectedStrokes.has(stroke.id)) {
            const transformFn = (p: Point) => ({ 
                x: originX + (p.x - originX) * scaleX, 
                y: originY + (p.y - originY) * scaleY 
            });

            if (stroke.points && stroke.points.length > 0) { 
                stroke.points = stroke.points.map(transformFn); 
            } else if (stroke.x !== undefined && stroke.y !== undefined) {
                const newCoords = transformFn({ x: stroke.x, y: stroke.y });
                stroke.x = newCoords.x; 
                stroke.y = newCoords.y;
                if (stroke.width) stroke.width *= scaleX;
                if (stroke.height) stroke.height *= scaleY;
            }
            if (stroke.lineWidth) stroke.lineWidth *= Math.min(Math.abs(scaleX), Math.abs(scaleY));
            if(stroke.gpuData){ stroke.gpuData.vertexBuffer.destroy(); stroke.gpuData.indexBuffer.destroy(); stroke.gpuData = null; }
        }
    });
}
