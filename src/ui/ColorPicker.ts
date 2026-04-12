import { $ } from '../utils/dom';
import { Stroke } from '../core/types';
import { COLOR_PALETTE } from '../core/constants';
import { brushSettings, getActiveLayer, requestRedraw, saveData, canvasState } from '../core/store';
import { storePreModificationState, preModificationStrokes, addHistoryAction } from '../canvas/history.ts';

export function initColorPickers() {
  const simpleColorPicker = $('#simple-color-picker');
  const selectionColorPicker = $('#selection-color-picker');

  const createSwatches = () => COLOR_PALETTE.map(c => 
    `<div class="color-swatch flex shrink-0 w-8 h-8 rounded-full cursor-pointer transition-all duration-200 hover:scale-110 active:scale-95 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]" style="background-color: ${c}" data-color="${c}"></div>`
  ).join('');

  simpleColorPicker.innerHTML = createSwatches();
  simpleColorPicker.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const color = target.closest<HTMLElement>('.color-swatch')?.dataset.color;
      if (color && brushSettings[canvasState.activeTool]?.hasOwnProperty('color')) {
          brushSettings[canvasState.activeTool].color = color;
          $('#color-display').style.backgroundColor = color;
          simpleColorPicker.classList.add('hidden'); 
          simpleColorPicker.classList.remove('grid');
      }
  });

  selectionColorPicker.innerHTML = createSwatches();
  selectionColorPicker.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const color = target.closest<HTMLElement>('.color-swatch')?.dataset.color;
      if (!color) return;

      const activeLayer = getActiveLayer();
      if (!activeLayer || canvasState.selectedStrokes.size === 0) return;

      storePreModificationState();

      activeLayer.strokes.forEach((stroke: Stroke) => {
          if (canvasState.selectedStrokes.has(stroke.id) && stroke.hasOwnProperty('color')) {
              stroke.color = color;
              if (stroke.gpuData) {
                  stroke.gpuData.vertexBuffer.destroy();
                  stroke.gpuData.indexBuffer.destroy();
                  stroke.gpuData = null; // Invalidate GPU buffers
              }
          }
      });

      const postModificationStrokes = JSON.parse(JSON.stringify(
          activeLayer.strokes.filter((s: Stroke) => canvasState.selectedStrokes.has(s.id))
      ));

      if (preModificationStrokes && JSON.stringify(preModificationStrokes) !== JSON.stringify(postModificationStrokes)) {
          addHistoryAction({ type: 'MODIFY', before: preModificationStrokes, after: postModificationStrokes, layerId: activeLayer.id });
      }

      $('#selection-color-display').style.backgroundColor = color;
      selectionColorPicker.classList.add('hidden'); 
      selectionColorPicker.classList.remove('grid');
      
      saveData();
      requestRedraw();
  });
}
