import { Point, Stroke } from '../core/types';
import { canvasState, brushSettings, getActiveLayer, requestRedraw } from '../core/store';
import { updateSettingsUI } from '../ui/RadialMenu.ts'; // we'll build this soon
import { $ } from '../utils/dom';

export function eraseAt(pos: Point) {
    const activeLayer = getActiveLayer(); 
    if (!activeLayer) return;

    const eraseRadius = brushSettings.eraser.lineWidth / 2;
    let changed = false;

    activeLayer.strokes.forEach((stroke: Stroke) => {
        // Quick bounds check
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        if (stroke.points && stroke.points.length > 0) {
            stroke.points.forEach((p: Point) => { 
                minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); 
                maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); 
            });
        } else {
            const sx = stroke.x || 0, sy = stroke.y || 0, sw = stroke.width || 0, sh = stroke.height || 0;
            minX = Math.min(sx, sx + sw); minY = Math.min(sy, sy + sh);
            maxX = Math.max(sx, sx + sw); maxY = Math.max(sy, sy + sh);
        }
        const padding = (stroke.lineWidth || 0) / 2;
        minX -= padding; minY -= padding; maxX += padding; maxY += padding;

        if (pos.x < minX - eraseRadius || pos.x > maxX + eraseRadius || 
            pos.y < minY - eraseRadius || pos.y > maxY + eraseRadius) return;

        const wasErasing = stroke.isErasing;
        stroke.isErasing = false;

        if (stroke.points && stroke.points.length > 0) {
            if (stroke.points.some((p: Point) => Math.hypot(p.x - pos.x, p.y - pos.y) < eraseRadius + ((stroke.lineWidth || 0) / 2))) {
                stroke.isErasing = true;
            }
        } else {
            if (pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY) {
                stroke.isErasing = true;
            }
        }

        if (wasErasing !== stroke.isErasing) {
            changed = true;
            if (stroke.gpuData) {
                stroke.gpuData.vertexBuffer.destroy();
                stroke.gpuData.indexBuffer.destroy();
                stroke.gpuData = null; // Invalidate GPU buffers
            }
        }
    });

    if (changed) requestRedraw();
}

export function applySmoothing(points: Point[], factor: number): Point[] {
    const normalizedFactor = ((factor - 1) / 99) * 0.95;
    if (normalizedFactor <= 0 || points.length < 3) return points;
    
    const smoothed = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const p0 = points[i - 1], p1 = points[i], p2 = points[i + 1];
        smoothed.push({
            x: p1.x * (1 - normalizedFactor) + (p0.x + p2.x) / 2 * normalizedFactor,
            y: p1.y * (1 - normalizedFactor) + (p0.y + p2.y) / 2 * normalizedFactor
        });
    }
    smoothed.push(points[points.length - 1]);
    
    const finalSmoothed = [smoothed[0]];
    for (let i = 1; i < smoothed.length - 1; i++) {
        const p1 = smoothed[i], p2 = smoothed[i + 1];
        finalSmoothed.push({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
    }
    finalSmoothed.push(smoothed[smoothed.length - 1]);
    
    return finalSmoothed;
}

export function updateCursor() {
    const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
    if (!canvas) return;

    if (canvasState.isPanning) canvas.style.cursor = 'grabbing';
    else if (canvasState.activeTool === 'laser') canvas.style.cursor = 'none';
    else if (canvasState.activeTool === 'pan') canvas.style.cursor = 'grab';
    else canvas.style.cursor = 'crosshair';
}

export function setActiveTool(newTool: string) {
    canvasState.activeTool = newTool;
    canvasState.activeSettingWedge = null;
    
    $('#settings-popup')?.classList.remove('flex');
    $('#settings-popup')?.classList.add('hidden');
    
    $('#pan-tool-btn')?.classList.toggle('active', newTool === 'pan');
    
    if (window.updateActiveWedge) window.updateActiveWedge();
    
    updateCursor();
    updateSettingsUI();
}
