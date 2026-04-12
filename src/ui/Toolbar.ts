import { $ } from '../utils/dom';
import { canvasState, getActiveLayer, findStrokeAndLayer } from '../core/store';

export function showSelectionToolbar() {
    const selectionToolbar = $('#selection-toolbar');
    if (!selectionToolbar) return;

    const activeLayer = getActiveLayer();
    if (activeLayer && canvasState.selectedStrokes.size > 0) {
        const firstSelectedId = canvasState.selectedStrokes.values().next().value;
        if (firstSelectedId !== undefined) {
            const { stroke: firstSelectedStroke } = findStrokeAndLayer(firstSelectedId);
            if (firstSelectedStroke && firstSelectedStroke.color) {
                $('#selection-color-display').style.backgroundColor = firstSelectedStroke.color;
            } else {
                $('#selection-color-display').style.backgroundColor = '#a0a0a0'; // Replaces var(--text-secondary)
            }
        }
    }
    selectionToolbar.classList.remove('opacity-0', 'pointer-events-none');
    selectionToolbar.classList.add('opacity-100', 'pointer-events-auto');
}

export function hideSelectionToolbar() {
    const selectionToolbar = $('#selection-toolbar');
    if (!selectionToolbar) return;
    selectionToolbar.classList.remove('opacity-100', 'pointer-events-auto');
    selectionToolbar.classList.add('opacity-0', 'pointer-events-none');
    
    const colorPicker = $('#selection-color-picker');
    if (colorPicker) {
        colorPicker.classList.remove('grid');
        colorPicker.classList.add('hidden');
    }
}
