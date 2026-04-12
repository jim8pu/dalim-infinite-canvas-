import { $ } from '../utils/dom';
import { getRenderer, initRenderer } from '../renderer/RendererInstance';
import { handleCanvasPointerDown, handleCanvasPointerMove, handleCanvasPointerUp, handleWheel } from './events';
import { switchView } from '../ui/View';
import { setActiveTool } from './tools';
import { initRadialToolbar } from '../ui/RadialMenu';
import { initColorPickers } from '../ui/ColorPicker';
import { renderLayersPanel, addLayersEventListeners } from '../ui/LayersPanel';
import { brushSettings, canvasState, viewState, getActiveCardCanvasState, requestRedraw, getActiveLayer, saveData } from '../core/store';
import { Modal } from '../ui/Modal';
import { ZoomFloor, transitionFloor } from './zoom';
import { FLOOR_BASE } from '../core/constants';
import { animateView } from './animation';
import { hideSelectionToolbar } from '../ui/Toolbar';
import { addHistoryAction } from './history';

export function checkFloorTransitions() {
    while (viewState.targetScale >= FLOOR_BASE) {
        transitionFloor(viewState, 'up');
    }
    while (viewState.targetScale < 1.0 && viewState.currentFloor.parent) {
        transitionFloor(viewState, 'down');
    }
    if (!viewState.currentFloor.parent) {
        viewState.targetScale = Math.max(0.01, viewState.targetScale);
    }
}

export async function initCanvas() {
    const container = $('#canvas-view');
    const canvas = $<HTMLCanvasElement>('#canvas');
    if (!container || !canvas) return;

    let renderer = getRenderer();
    if (!renderer) {
        try {
            renderer = initRenderer(canvas);
            await renderer.init();
        } catch (err) {
            console.error("Failed to initialize WebGPU:", err);
            Modal.confirm("Rendering Error", "Could not initialize WebGPU. Your browser might not support it, or it might be disabled. The canvas will not work.")
                .then(() => { });
            return;
        }
    }

    renderer.resize(container.clientWidth, container.clientHeight);

    if (!canvas.dataset.initialized) {
        canvas.addEventListener('pointerdown', handleCanvasPointerDown);
        canvas.addEventListener('pointermove', handleCanvasPointerMove);
        canvas.addEventListener('pointerup', handleCanvasPointerUp);
        canvas.addEventListener('pointercancel', handleCanvasPointerUp);
        canvas.addEventListener('pointerleave', handleCanvasPointerUp);
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.addEventListener('wheel', handleWheel, { passive: false });

        $('#back-to-revisions-btn')?.addEventListener('click', () => switchView('revisions'));
        $('#pan-tool-btn')?.addEventListener('click', () => setActiveTool(canvasState.activeTool === 'pan' ? 'pen' : 'pan'));

        $('#layers-btn')?.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            $('#layers-panel')?.classList.toggle('hidden'); 
            $('#layers-panel')?.classList.toggle('flex'); 
        });

        type GenericBrush = { lineWidth?: number; opacity?: number; smoothness?: number; color?: string };
        
        $('#pen-size-slider')?.addEventListener('input', (e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            (brushSettings as Record<string, GenericBrush>)[canvasState.activeTool].lineWidth = +val;
            const sizeVal = $('#pen-size-value');
            if(sizeVal) sizeVal.textContent = val;
        });
        $('#opacity-slider')?.addEventListener('input', (e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            (brushSettings as Record<string, GenericBrush>)[canvasState.activeTool].opacity = +val;
            const opacityVal = $('#opacity-value');
            if(opacityVal) opacityVal.textContent = val;
        });
        $('#smoothness-slider')?.addEventListener('input', (e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            (brushSettings as Record<string, GenericBrush>)[canvasState.activeTool].smoothness = +val;
            const smoothVal = $('#smoothness-value');
            if(smoothVal) smoothVal.textContent = val;
        });

        document.querySelectorAll<HTMLElement>('.zoom-btn').forEach(btn => btn.addEventListener('click', () => {
            const zoomFactor = btn.dataset.zoom === 'in' ? 1.4 : 1 / 1.4;
            const center = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
            const oldScale = viewState.targetScale;
            const newTargetScale = Math.max(0.01, oldScale * zoomFactor);
            const worldPos = { x: (center.x - viewState.targetPanOffset.x) / oldScale, y: (center.y - viewState.targetPanOffset.y) / oldScale };
            
            viewState.targetPanOffset = { x: center.x - worldPos.x * newTargetScale, y: center.y - worldPos.y * newTargetScale };
            viewState.targetScale = newTargetScale;
            
            checkFloorTransitions();
            requestRedraw();
        }));

        window.addEventListener('resize', () => {
            const newWidth = container.clientWidth;
            const newHeight = container.clientHeight;
            if (renderer) renderer.resize(newWidth, newHeight);
            requestRedraw();
        });

        initColorPickers();

        $('#selection-delete-btn')?.addEventListener('click', () => {
            const activeLayer = getActiveLayer();
            if (!activeLayer || canvasState.selectedStrokes.size === 0) return;

            const strokesToDelete = JSON.parse(JSON.stringify(
                activeLayer.strokes.filter(s => canvasState.selectedStrokes.has(s.id))
            ));

            if (strokesToDelete.length > 0) {
                addHistoryAction({ type: 'REMOVE', strokes: strokesToDelete, layerId: activeLayer.id });
                
                // Cleanup GPU buffers before removal
                activeLayer.strokes.forEach(s => { 
                    if (canvasState.selectedStrokes.has(s.id) && s.gpuData) { 
                        s.gpuData.vertexBuffer.destroy(); 
                        s.gpuData.indexBuffer.destroy(); 
                    } 
                });

                activeLayer.strokes = activeLayer.strokes.filter(s => !canvasState.selectedStrokes.has(s.id));

                canvasState.selectedStrokes.clear();
                canvasState.selectionBox = null;
                hideSelectionToolbar();
                saveData();
                requestRedraw();
            }
        });

        addLayersEventListeners();
        initRadialToolbar();

        animateView();
        canvas.dataset.initialized = 'true';
    }

    const canvasData = getActiveCardCanvasState();
    if (canvasData) {
        viewState.scale = canvasData.scale || 1;
        viewState.panOffset = canvasData.panOffset || { x: 0, y: 0 };
        viewState.targetScale = viewState.scale;
        viewState.targetPanOffset = { ...viewState.panOffset };
        
        // Restore floor tree
        if (canvasData.floorTree) {
            const rootFloor = ZoomFloor.fromJSON(canvasData.floorTree);
            const targetIndex = canvasData.currentFloorIndex || 0;
            let floor = rootFloor;
            while (floor && floor.index < targetIndex && floor.child) floor = floor.child;
            viewState.currentFloor = floor || new ZoomFloor(0);
        } else {
            viewState.currentFloor = new ZoomFloor(0);
        }
        
        const totalZoom = Math.pow(FLOOR_BASE, viewState.currentFloor.index) * viewState.scale;
        const zoomDisplay = $('#zoom-level-display');
        if(zoomDisplay) {
            if (totalZoom >= 1e6) {
                zoomDisplay.textContent = `${(totalZoom / 1e6).toFixed(1)}M%`;
            } else if (totalZoom >= 1e4) {
                zoomDisplay.textContent = `${(totalZoom / 1e3).toFixed(1)}K%`;
            } else {
                zoomDisplay.textContent = `${Math.round(totalZoom * 100)}%`;
            }
        }
        renderLayersPanel();
    }
    setActiveTool('pen');
    requestRedraw();
}
