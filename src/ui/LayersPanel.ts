import { $ } from '../utils/dom';
import { getUniqueId } from '../utils/math';
import { getActiveCardCanvasState, canvasState, requestRedraw, saveData } from '../core/store';
import { hideSelectionToolbar } from './Toolbar';
import { initIcons } from '../utils/dom';
import { Modal } from './Modal';
import { Stroke } from '../core/types';

export function renderLayersPanel() {
    const canvasData = getActiveCardCanvasState();
    const listEl = $('#layers-list');
    if (!canvasData || !listEl) return;

    listEl.innerHTML = canvasData.layers.map(layer => `
        <li class="layer-item flex items-center gap-2 p-2 rounded-md bg-column cursor-pointer border-2 transition-all duration-200 border-transparent hover:bg-white/5 ${layer.id === canvasData.activeLayerId ? 'bg-blue/15 border-blue active' : ''} ${!layer.isVisible ? 'opacity-50 hidden-layer' : ''}" data-layer-id="${layer.id}">
            <button class="bg-none border-none p-1 cursor-pointer layer-visibility" title="Toggle Visibility"><i data-lucide="${layer.isVisible ? 'eye' : 'eye-off'}" class="w-4 h-4 text-secondary hover:text-primary ${!layer.isVisible ? 'text-red hover:text-red' : ''}"></i></button>
            <span class="grow text-sm outline-none layer-name" contenteditable="true" spellcheck="false">${layer.name}</span>
            <button class="bg-none border-none p-1 cursor-pointer delete-layer-btn" title="Delete Layer"><i data-lucide="trash" class="w-4 h-4 text-secondary hover:text-red"></i></button>
        </li>
    `).join('');
    
    initIcons();
}

export function addLayersEventListeners() {
    const panel = $('#layers-panel');
    if (!panel) return;

    $('#add-layer-btn')?.addEventListener('click', () => {
        const canvasData = getActiveCardCanvasState();
        if (!canvasData) return;
        
        const newLayer = { id: getUniqueId(), name: `Layer ${canvasData.layers.length + 1}`, isVisible: true, strokes: [] };
        canvasData.layers.push(newLayer);
        canvasData.activeLayerId = newLayer.id;
        
        saveData();
        renderLayersPanel();
        requestRedraw();
    });

    panel.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const layerItem = target.closest<HTMLElement>('.layer-item');
        if (!layerItem) return;

        const layerId = parseFloat(layerItem.dataset.layerId || '0');
        const canvasData = getActiveCardCanvasState();
        if (!canvasData) return;

        if (target.closest('.delete-layer-btn')) {
            if (canvasData.layers.length <= 1) {
                Modal.confirm("Cannot Delete", "You must have at least one layer.").then(() => { });
                return;
            }
            if (await Modal.confirm("Delete Layer?", "Are you sure you want to delete this layer and all its content? This cannot be undone.")) {
                const layerToDelete = canvasData.layers.find(l => l.id === layerId);
                if (layerToDelete) {
                    layerToDelete.strokes.forEach((s: Stroke) => { 
                        if (s.gpuData) { 
                            s.gpuData.vertexBuffer.destroy(); 
                            s.gpuData.indexBuffer.destroy(); 
                        } 
                    });
                }
                
                canvasData.layers = canvasData.layers.filter(l => l.id !== layerId);
                if (canvasData.activeLayerId === layerId) {
                    canvasData.activeLayerId = canvasData.layers[canvasData.layers.length - 1].id;
                }
                
                saveData();
                renderLayersPanel();
                requestRedraw();
            }
        } else if (target.closest('.layer-visibility')) {
            const layer = canvasData.layers.find(l => l.id === layerId);
            if (layer) {
                layer.isVisible = !layer.isVisible;
                saveData();
                renderLayersPanel();
                requestRedraw();
            }
        } else if (!target.matches('.layer-name')) {
            canvasData.activeLayerId = layerId;
            canvasState.selectedStrokes.clear();
            canvasState.selectionBox = null;
            
            hideSelectionToolbar();
            saveData();
            renderLayersPanel();
            requestRedraw();
        }
    });

    panel.addEventListener('input', e => {
        const target = e.target as HTMLElement;
        const nameSpan = target.closest<HTMLElement>('.layer-name');
        if (nameSpan) {
            const layerItemEl = nameSpan.closest<HTMLElement>('.layer-item');
            const layerId = parseFloat(layerItemEl?.dataset.layerId || '0');
            const canvasData = getActiveCardCanvasState();
            if (!canvasData) return;
            
            const layer = canvasData.layers.find(l => l.id === layerId);
            if (layer) {
                layer.name = nameSpan.textContent || '';
                saveData();
            }
        }
    });
}
