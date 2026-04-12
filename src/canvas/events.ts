import { Point, TempShape, Stroke, LaserPoint } from '../core/types';
import { canvasState, getActiveLayer, requestRedraw, viewState, getActiveCardCanvasState, saveData, brushSettings } from '../core/store';
import { getUniqueId, isPointInBox } from '../utils/math';
import { checkFloorTransitions } from './canvas.ts';
import { eraseAt, applySmoothing, updateCursor, setActiveTool } from './tools';
import { getResizeHandleUnderCursor, resizeSelection, moveSelection, selectStrokesInLasso } from './selection';
import { hideSelectionToolbar } from '../ui/Toolbar';
import { storePreModificationState, addHistoryAction, preModificationStrokes, clearPreModificationState } from './history';

const activePointers = new Map<number, PointerEvent>();
let pinchState: { startDistance: number | null } = { startDistance: null };

function getCanvasPos(e: PointerEvent): Point {
    const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
    const rect = canvas!.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left - viewState.panOffset.x) / viewState.scale,
        y: (e.clientY - rect.top - viewState.panOffset.y) / viewState.scale
    };
}

export function handleCanvasPointerDown(e: PointerEvent) {
    const activeLayer = getActiveLayer();
    if (!activeLayer) return;

    const canvas = document.querySelector<HTMLCanvasElement>('#canvas');

    activePointers.set(e.pointerId, e);
    if (activePointers.size === 2) {
        canvasState.isDrawing = false;
        const pointers = Array.from(activePointers.values());
        pinchState.startDistance = Math.hypot(pointers[0].clientX - pointers[1].clientX, pointers[0].clientY - pointers[1].clientY);
        return;
    }
    if (activePointers.size > 2) return;

    canvasState.lastPos = getCanvasPos(e);
    canvasState.panStart = { x: e.clientX, y: e.clientY };

    if (canvasState.activeTool === 'pan' || e.button === 2 || (e.button === 0 && e.altKey)) {
        canvasState.isPanning = true;
        if(canvas) canvas.style.cursor = 'grabbing';
        return;
    }

    if (e.button === 1) {
        e.preventDefault();
        setActiveTool('lasso');
        canvasState.isLassoing = true;
        canvasState.lassoPoints = [canvasState.lastPos];
        return;
    }

    if (e.button === 0) {
        if (canvasState.selectionBox) {
            const handle = getResizeHandleUnderCursor(canvasState.lastPos);
            if (handle) {
                canvasState.isResizingSelection = true;
                canvasState.resizeHandle = handle;
                storePreModificationState();
                return;
            }
            if (isPointInBox(canvasState.lastPos, canvasState.selectionBox)) {
                canvasState.isMovingSelection = true;
                storePreModificationState();
                return;
            }
        }

        canvasState.selectedStrokes.clear();
        canvasState.selectionBox = null;
        hideSelectionToolbar();
        canvasState.isDrawing = true;

        const currentBrush = brushSettings[canvasState.activeTool] || {};
        const options = { id: getUniqueId(), ...currentBrush };

        switch (canvasState.activeTool) {
            case 'pen': case 'highlighter':
                const newStroke: Stroke = { 
                    ...options, 
                    type: canvasState.activeTool, 
                    floorIndex: viewState.currentFloor.index, 
                    worldWidth: options.lineWidth / viewState.scale, 
                    points: [canvasState.lastPos], 
                    rawPoints: [canvasState.lastPos], 
                    color: options.color || '#FFFFFF', 
                    opacity: options.opacity ?? 100 
                };
                activeLayer.strokes.push(newStroke);
                viewState.currentFloor._hasStrokes = true;
                break;
            case 'rectangle': case 'circle': case 'triangle':
                canvasState.tempShape = { 
                    ...options, 
                    type: canvasState.activeTool, 
                    floorIndex: viewState.currentFloor.index, 
                    x: canvasState.lastPos.x, 
                    y: canvasState.lastPos.y, 
                    width: 0, 
                    height: 0 
                } as TempShape;
                break;
            case 'eraser':
                eraseAt(canvasState.lastPos);
                break;
            case 'lasso':
                canvasState.isLassoing = true;
                canvasState.lassoPoints = [canvasState.lastPos];
                break;
            case 'laser':
                canvasState.laserPoints.push({ x: canvasState.lastPos.x, y: canvasState.lastPos.y, time: Date.now() });
                break;
        }
    }
    requestRedraw();
}

export function handleCanvasPointerMove(e: PointerEvent) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, e);

    const canvas = document.querySelector<HTMLCanvasElement>('#canvas');

    if (activePointers.size === 2) {
        const pointers = Array.from(activePointers.values());
        const p1 = pointers[0], p2 = pointers[1];
        const newDist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
        
        if (pinchState.startDistance === null) { pinchState.startDistance = newDist; return; }
        
        const rect = canvas!.getBoundingClientRect();
        const center = { x: (p1.clientX + p2.clientX) / 2 - rect.left, y: (p1.clientY + p2.clientY) / 2 - rect.top };
        
        const scaleMultiplier = newDist / pinchState.startDistance;
        const oldScale = viewState.targetScale;
        const newTargetScale = Math.max(0.01, oldScale * scaleMultiplier);
        
        const worldPos = { x: (center.x - viewState.targetPanOffset.x) / oldScale, y: (center.y - viewState.targetPanOffset.y) / oldScale };
        
        viewState.targetPanOffset = { x: center.x - worldPos.x * newTargetScale, y: center.y - worldPos.y * newTargetScale };
        viewState.targetScale = newTargetScale;
        
        checkFloorTransitions();
        pinchState.startDistance = newDist;
        requestRedraw();
        return;
    }

    if (activePointers.size !== 1) return;

    const pos = getCanvasPos(e);
    const activeLayer = getActiveLayer();

    const dx = pos.x - canvasState.lastPos.x;
    const dy = pos.y - canvasState.lastPos.y;
    canvasState.lastPos = pos;

    if (canvasState.isPanning) {
        viewState.targetPanOffset.x += e.clientX - canvasState.panStart.x;
        viewState.targetPanOffset.y += e.clientY - canvasState.panStart.y;
        canvasState.panStart = { x: e.clientX, y: e.clientY };
    } else if (canvasState.isResizingSelection) {
        resizeSelection(dx, dy);
    } else if (canvasState.isMovingSelection) {
        moveSelection(dx, dy);
    } else if (canvasState.isLassoing) {
        canvasState.lassoPoints.push(pos);
    } else if (canvasState.isDrawing && activeLayer) {
        switch (canvasState.activeTool) {
            case 'pen': case 'highlighter':
                const currentStroke = activeLayer.strokes[activeLayer.strokes.length - 1];
                if (currentStroke && currentStroke.rawPoints) {
                    currentStroke.rawPoints.push(pos);
                    const settings = brushSettings[canvasState.activeTool];
                    const smoothness = settings.smoothness ?? 0;
                    currentStroke.points = (smoothness > 1) ? applySmoothing(currentStroke.rawPoints, smoothness) : [...currentStroke.rawPoints];
                    if(currentStroke.gpuData){ currentStroke.gpuData.vertexBuffer.destroy(); currentStroke.gpuData.indexBuffer.destroy(); currentStroke.gpuData = null; }
                }
                break;
            case 'rectangle': case 'circle': case 'triangle':
                if (canvasState.tempShape) {
                    canvasState.tempShape.width = pos.x - canvasState.tempShape.x;
                    canvasState.tempShape.height = pos.y - canvasState.tempShape.y;
                }
                break;
            case 'eraser':
                eraseAt(pos);
                break;
            case 'laser':
                canvasState.laserPoints.push({ x: pos.x, y: pos.y, time: Date.now() } as LaserPoint);
                break;
        }
    }
    requestRedraw();
}

export function handleCanvasPointerUp(e: PointerEvent) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchState.startDistance = null;
    if (activePointers.size > 0) return;

    if (canvasState.isPanning) {
        const canvasData = getActiveCardCanvasState();
        if (canvasData) {
            canvasData.panOffset = { ...viewState.panOffset };
            canvasData.scale = viewState.scale;
            canvasData.floorTree = viewState.currentFloor.getRoot().toJSON();
            canvasData.currentFloorIndex = viewState.currentFloor.index;
            saveData();
        }
    }

    const activeLayer = getActiveLayer();
    if (!activeLayer) {
        canvasState.isDrawing = canvasState.isPanning = canvasState.isLassoing = false;
        canvasState.isMovingSelection = canvasState.isResizingSelection = false;
        updateCursor();
        return;
    }

    // --- HANDLE HISTORY ACTIONS ---
    if (canvasState.activeTool === 'eraser') {
        const erasedStrokes = activeLayer.strokes.filter((s: Stroke) => s.isErasing);
        if (erasedStrokes.length > 0) {
            const erasedStrokesCopy = JSON.parse(JSON.stringify(erasedStrokes.map((s: Stroke) => { delete s.isErasing; return s; })));
            activeLayer.strokes = activeLayer.strokes.filter((s: Stroke) => !s.isErasing);
            
            // Dispose GPU buffers
            erasedStrokes.forEach((s: Stroke) => { 
                if (s.gpuData) { 
                    s.gpuData.vertexBuffer.destroy(); 
                    s.gpuData.indexBuffer.destroy(); 
                } 
            });

            addHistoryAction({ type: 'REMOVE', strokes: erasedStrokesCopy, layerId: activeLayer.id });
            saveData();
        }
    }
    activeLayer.strokes.forEach((s: Stroke) => delete s.isErasing);

    if (canvasState.isDrawing && canvasState.tempShape) {
        if (Math.abs(canvasState.tempShape.width) > 2 || Math.abs(canvasState.tempShape.height) > 2) {
            const shapeToAdd = JSON.parse(JSON.stringify(canvasState.tempShape));
            activeLayer.strokes.push(shapeToAdd);
            viewState.currentFloor._hasStrokes = true;
            addHistoryAction({ type: 'ADD', strokes: [shapeToAdd], layerId: activeLayer.id });
            saveData();
        }
        if (canvasState.tempShape.gpuData) {
            canvasState.tempShape.gpuData.vertexBuffer.destroy();
            canvasState.tempShape.gpuData.indexBuffer.destroy();
        }
        canvasState.tempShape = null;
    }

    if (canvasState.isDrawing && (canvasState.activeTool === 'pen' || canvasState.activeTool === 'highlighter')) {
        const currentStroke = activeLayer.strokes[activeLayer.strokes.length - 1];
        if (currentStroke) {
            const strokeForHistory = JSON.parse(JSON.stringify(currentStroke));
            delete strokeForHistory.rawPoints;
            addHistoryAction({ type: 'ADD', strokes: [strokeForHistory], layerId: activeLayer.id });
            delete currentStroke.rawPoints;
            saveData();
        }
    }

    // Lasso selection logic happens via app loop, but we trigger it on pointer up directly later if needed.
    // The previous math was in function selectStrokesInLasso()
    if (canvasState.isLassoing) {
        selectStrokesInLasso();
    }

    if ((canvasState.isMovingSelection || canvasState.isResizingSelection) && preModificationStrokes) {
        const postModificationStrokes = JSON.parse(JSON.stringify(
            activeLayer.strokes.filter((s: Stroke) => canvasState.selectedStrokes.has(s.id))
        ));
        if (JSON.stringify(preModificationStrokes) !== JSON.stringify(postModificationStrokes)) {
            addHistoryAction({ type: 'MODIFY', before: preModificationStrokes, after: postModificationStrokes, layerId: activeLayer.id });
            saveData();
        }
        // To clear preModificationStrokes, we should ideally have a method like clearPreModificationState. 
        // For now, since it is exported, we modify it via setter if needed or just handle it if typescript allows.
        // Wait, preModificationStrokes is imported via static import...
        // TypeScript doesn't allow re-assigning imported bindings.
        // So we should export a clear function from history.ts! 
        // Let's use `clearPreModificationState()` instead!
        clearPreModificationState();
    }

    // --- RESET CANVAS STATE ---
    canvasState.isDrawing = canvasState.isPanning = canvasState.isLassoing = false;
    canvasState.isMovingSelection = canvasState.isResizingSelection = false;
    canvasState.resizeHandle = null;
    
    updateCursor();
    requestRedraw();
}

export function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (canvasState.isDrawing || canvasState.isMovingSelection || canvasState.isResizingSelection) return;

    if (e.ctrlKey) { // Zooming
        const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
        const rect = canvas!.getBoundingClientRect();
        const zoomIntensity = 0.005;
        const zoomFactor = Math.exp(-e.deltaY * zoomIntensity);
        const mousePoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        
        const oldScale = viewState.targetScale;
        const newTargetScale = Math.max(0.01, oldScale * zoomFactor);
        const worldPos = { x: (mousePoint.x - viewState.targetPanOffset.x) / oldScale, y: (mousePoint.y - viewState.targetPanOffset.y) / oldScale };
        
        viewState.targetPanOffset = { x: mousePoint.x - worldPos.x * newTargetScale, y: mousePoint.y - worldPos.y * newTargetScale };
        viewState.targetScale = newTargetScale;

        checkFloorTransitions();
    } else { // Panning
        viewState.targetPanOffset.x -= e.deltaX;
        viewState.targetPanOffset.y -= e.deltaY;
    }
    requestRedraw();
}
