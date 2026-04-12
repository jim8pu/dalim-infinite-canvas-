import { canvasState, getActiveCardCanvasState, requestRedraw, isRedrawRequested, clearRedrawRequest, viewState } from '../core/store';
import { getStrokeBounds } from '../utils/math';
import { lerp } from '../utils/math';
import { FLOOR_BASE } from '../core/constants';
import { $ } from '../utils/dom';

// Wait, WebGPURenderer is imported here. We have to be careful with initialization.
// We will expose a method to pass the renderer instance or we will store the renderer globally.
import { getRenderer } from '../renderer/RendererInstance.ts'; 

export function animateView() {
    let needsRedraw = isRedrawRequested();
    clearRedrawRequest();

    const panDist = Math.hypot(viewState.targetPanOffset.x - viewState.panOffset.x, viewState.targetPanOffset.y - viewState.panOffset.y);
    const scaleDist = Math.abs(viewState.targetScale - viewState.scale);

    if (panDist > 0.01 || scaleDist > 0.0001) {
        viewState.panOffset.x = lerp(viewState.panOffset.x, viewState.targetPanOffset.x, 0.25);
        viewState.panOffset.y = lerp(viewState.panOffset.y, viewState.targetPanOffset.y, 0.25);
        viewState.scale = lerp(viewState.scale, viewState.targetScale, 0.25);
        
        const totalZoom = Math.pow(FLOOR_BASE, viewState.currentFloor.index) * viewState.scale;
        
        const zoomDisplay = $('#zoom-level-display');
        if (zoomDisplay) {
            if (totalZoom >= 1e9) {
                zoomDisplay.textContent = `${(totalZoom / 1e9).toFixed(1)}B%`;
            } else if (totalZoom >= 1e6) {
                zoomDisplay.textContent = `${(totalZoom / 1e6).toFixed(1)}M%`;
            } else if (totalZoom >= 1e4) {
                zoomDisplay.textContent = `${(totalZoom / 1e3).toFixed(1)}K%`;
            } else {
                zoomDisplay.textContent = `${Math.round(totalZoom * 100)}%`;
            }
        }
        needsRedraw = true;
    }

    if (canvasState.activeTool === 'laser' && (canvasState.laserPoints.length > 0 || canvasState.isDrawing)) {
        needsRedraw = true;
        const now = Date.now();
        const fadeDuration = 500;
        canvasState.laserPoints = canvasState.laserPoints.filter(p => now - p.time < fadeDuration);
    }

    const renderer = getRenderer();
    if (needsRedraw && renderer) {
        const canvasData = getActiveCardCanvasState();
        const layers = (canvasData && canvasData.layers) ? canvasData.layers : [];

        renderer.render(
            viewState,
            layers,
            canvasState.laserPoints,
            canvasState.isLassoing ? canvasState.lassoPoints : [],
            canvasState.selectionBox,
            canvasState.tempShape
        );
    }

    requestAnimationFrame(animateView);
}

export function centerCanvasContent() {
    const canvasData = getActiveCardCanvasState();
    if (!canvasData) return;
    
    const allStrokes = canvasData.layers.flatMap(l => l.isVisible ? l.strokes : []);
    if (allStrokes.length === 0) return;

    const bounds = allStrokes.reduce((acc, s) => {
        const b = getStrokeBounds(s);
        return { 
            minX: Math.min(acc.minX, b.minX), 
            minY: Math.min(acc.minY, b.minY), 
            maxX: Math.max(acc.maxX, b.maxX), 
            maxY: Math.max(acc.maxY, b.maxY) 
        };
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

    const contentWidth = bounds.maxX - bounds.minX;
    const contentHeight = bounds.maxY - bounds.minY;
    if (contentWidth < 1 || contentHeight < 1) return;

    const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
    if(!canvas) return;

    const scaleX = canvas.clientWidth / (contentWidth + 100);
    const scaleY = canvas.clientHeight / (contentHeight + 100);
    viewState.targetScale = Math.min(scaleX, scaleY, 2);
    viewState.targetPanOffset.x = canvas.clientWidth / 2 - (bounds.minX + contentWidth / 2) * viewState.targetScale;
    viewState.targetPanOffset.y = canvas.clientHeight / 2 - (bounds.minY + contentHeight / 2) * viewState.targetScale;

    requestRedraw();
}
