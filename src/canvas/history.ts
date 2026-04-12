import { HistoryAction, Stroke } from '../core/types';
import { canvasState, getSessionHistory, getCurrentOpenCardId, getActiveCardCanvasState, getActiveLayer, requestRedraw } from '../core/store';
// Note: We need a dynamic import or function to hide selection toolbar to prevent circular dependencies.
// We will export a hook system or handle it safely. 
// For now, let's assume `hideSelectionToolbar` will be explicitly passed or located in UI.
import { hideSelectionToolbar } from '../ui/Toolbar';

export let preModificationStrokes: Stroke[] | null = null;

export function getActiveCardHistory() {
  const currentOpenCardId = getCurrentOpenCardId();
  const sessionHistory = getSessionHistory();
  return (currentOpenCardId && sessionHistory[currentOpenCardId]) ? sessionHistory[currentOpenCardId] : null;
}

export function storePreModificationState() {
  const activeLayer = getActiveLayer(); 
  if (!activeLayer) return;

  if (canvasState.selectedStrokes.size > 0) {
      preModificationStrokes = JSON.parse(JSON.stringify(
          activeLayer.strokes.filter((s: Stroke) => canvasState.selectedStrokes.has(s.id))
      ));
  } else {
      preModificationStrokes = null;
  }
}
export function clearPreModificationState() {
  preModificationStrokes = null;
}
export function addHistoryAction(action: HistoryAction) {
  const cardHistory = getActiveCardHistory(); 
  if (!cardHistory) return;

  cardHistory.history.splice(cardHistory.historyIndex + 1);
  cardHistory.history.push(action);
  cardHistory.historyIndex++;
  
  if (cardHistory.history.length > 100) {
      cardHistory.history.shift();
      cardHistory.historyIndex--;
  }
}

export function undo() {
  const canvasData = getActiveCardCanvasState();
  const cardHistory = getActiveCardHistory();
  
  if (!canvasData || !cardHistory || cardHistory.historyIndex < 0) return;

  const actionToUndo = cardHistory.history[cardHistory.historyIndex];
  const layer = canvasData.layers.find(l => l.id === actionToUndo.layerId);
  if (!layer) return;

  switch (actionToUndo.type) {
      case 'ADD':
          const addedIds = new Set(actionToUndo.strokes?.map((s: Stroke) => s.id) || []);
          layer.strokes.forEach((s: Stroke) => { 
              if (addedIds.has(s.id) && s.gpuData) { 
                  s.gpuData.vertexBuffer.destroy(); 
                  s.gpuData.indexBuffer.destroy(); 
              } 
          });
          layer.strokes = layer.strokes.filter((s: Stroke) => !addedIds.has(s.id));
          break;
      case 'REMOVE':
          layer.strokes.push(...JSON.parse(JSON.stringify(actionToUndo.strokes)));
          break;
      case 'MODIFY':
          const modifiedIds = new Set(actionToUndo.before?.map((s: Stroke) => s.id) || []);
          layer.strokes.forEach((s: Stroke) => { 
              if (modifiedIds.has(s.id) && s.gpuData) { 
                  s.gpuData.vertexBuffer.destroy(); 
                  s.gpuData.indexBuffer.destroy(); 
              } 
          });
          layer.strokes = layer.strokes.filter((s: Stroke) => !modifiedIds.has(s.id));
          layer.strokes.push(...JSON.parse(JSON.stringify(actionToUndo.before)));
          break;
  }

  cardHistory.historyIndex--;
  canvasState.selectedStrokes.clear();
  canvasState.selectionBox = null;
  
  hideSelectionToolbar?.();
  requestRedraw();
}

export function redo() {
  const canvasData = getActiveCardCanvasState();
  const cardHistory = getActiveCardHistory();
  
  if (!canvasData || !cardHistory || cardHistory.historyIndex >= cardHistory.history.length - 1) return;

  const actionToRedo = cardHistory.history[cardHistory.historyIndex + 1];
  const layer = canvasData.layers.find(l => l.id === actionToRedo.layerId);
  if (!layer) return;

  switch (actionToRedo.type) {
      case 'ADD':
          layer.strokes.push(...JSON.parse(JSON.stringify(actionToRedo.strokes)));
          break;
      case 'REMOVE':
          const removedIds = new Set(actionToRedo.strokes?.map((s: Stroke) => s.id) || []);
          layer.strokes.forEach((s: Stroke) => { 
              if (removedIds.has(s.id) && s.gpuData) { 
                  s.gpuData.vertexBuffer.destroy(); 
                  s.gpuData.indexBuffer.destroy(); 
              } 
          });
          layer.strokes = layer.strokes.filter((s: Stroke) => !removedIds.has(s.id));
          break;
      case 'MODIFY':
          const modifiedIds = new Set(actionToRedo.after?.map((s: Stroke) => s.id) || []);
          layer.strokes.forEach((s: Stroke) => { 
              if (modifiedIds.has(s.id) && s.gpuData) { 
                  s.gpuData.vertexBuffer.destroy(); 
                  s.gpuData.indexBuffer.destroy(); 
              } 
          });
          layer.strokes = layer.strokes.filter((s: Stroke) => !modifiedIds.has(s.id));
          layer.strokes.push(...JSON.parse(JSON.stringify(actionToRedo.after)));
          break;
  }

  cardHistory.historyIndex++;
  canvasState.selectedStrokes.clear();
  canvasState.selectionBox = null;
  
  hideSelectionToolbar?.();
  requestRedraw();
}
