import { AppData, CanvasData, CanvasUIState, KanbanCard, KanbanColumn, Layer, Stroke } from './types';
import { ZoomFloor, TransitionViewState } from '../canvas/zoom';
import { getUniqueId } from '../utils/math';
import { Modal } from '../ui/Modal'; // Will build this soon

let appData: AppData = {} as AppData;
let sessionHistory: Record<number, { history: import('./types').HistoryAction[], historyIndex: number }> = {};
let currentOpenCardId: number | null = null;
let redrawRequested = false;

const defaultData: AppData = {
    revisions: {
        title: "Retrieval Scheduling",
        columns: [
            { id: getUniqueId(), title: 'Studying', cards: [] },
            { id: getUniqueId(), title: '1 Day Retrieval', cards: [] },
            { id: getUniqueId(), title: '1 Week Retrieval', cards: [] },
        ]
    }
};

export const canvasState: CanvasUIState = {
    isDrawing: false, isPanning: false, isLassoing: false,
    isMovingSelection: false, isResizingSelection: false,
    lastPos: { x: 0, y: 0 }, panStart: { x: 0, y: 0 },
    activeTool: 'pen',
    lassoPoints: [],
    laserPoints: [],
    selectedStrokes: new Set(),
    selectionBox: null,
    resizeHandle: null,
    tempShape: null,
    activeSettingWedge: null,
};

export const viewState: TransitionViewState = {
    scale: 1, panOffset: { x: 0, y: 0 },
    targetScale: 1, targetPanOffset: { x: 0, y: 0 },
    currentFloor: new ZoomFloor(0),
};

export const brushSettings: Record<string, import('./types').BrushSettings> = {
    pen: { color: '#F8FAFC', lineWidth: 5, opacity: 100, smoothness: 50 },
    highlighter: { color: '#FBBF24', lineWidth: 25, opacity: 30, smoothness: 70 },
    laser: { color: '#F43F5E', lineWidth: 5, opacity: 100, smoothness: 90 },
    rectangle: { color: '#F8FAFC', lineWidth: 4, opacity: 100, smoothness: 100 },
    circle: { color: '#F8FAFC', lineWidth: 4, opacity: 100, smoothness: 100 },
    triangle: { color: '#F8FAFC', lineWidth: 4, opacity: 100, smoothness: 100 },
    eraser: { lineWidth: 20 },
};

export function createDefaultCanvasState(): CanvasData {
    const firstLayerId = getUniqueId();
    return {
        layers: [{ id: firstLayerId, name: 'Layer 1', isVisible: true, strokes: [] }],
        activeLayerId: firstLayerId,
        panOffset: { x: 0, y: 0 },
        scale: 1,
        floorTree: new ZoomFloor(0).toJSON(),
        currentFloorIndex: 0
    };
}

export function saveData() {
    try {
        const replacer = (key: string, value: unknown) => {
            if (key === 'gpuData') return undefined;
            if (key === 'floor' && value instanceof ZoomFloor) return undefined;
            return value;
        };
        localStorage.setItem('advancedLearningAppData', JSON.stringify(appData, replacer));
    } catch (e: unknown) {
        console.error("An error occurred while saving data:", e);
        if (e && typeof e === 'object' && 'name' in e && (e as Error).name === 'QuotaExceededError') {
            Modal.confirm('Storage Full', 'Could not save your latest changes because the browser storage is full.').then(() => { });
        }
    }
}

export function loadData() {
    const savedData = localStorage.getItem('advancedLearningAppData');
    let parsedData;
    try {
        parsedData = savedData ? JSON.parse(savedData) : JSON.parse(JSON.stringify(defaultData));
    } catch (e) {
        console.error("Failed to parse saved data, resetting to default.", e);
        parsedData = JSON.parse(JSON.stringify(defaultData));
    }

    appData = { ...defaultData, ...parsedData };
    sessionHistory = {};

    if (!appData.revisions || !Array.isArray(appData.revisions.columns)) {
        appData.revisions = JSON.parse(JSON.stringify(defaultData.revisions));
    }

    appData.revisions.columns.forEach(col => {
        if (!Array.isArray(col.cards)) col.cards = [];
        col.cards.forEach(card => {
            if (!card.canvasState || typeof card.canvasState !== 'object') {
                card.canvasState = createDefaultCanvasState();
            } else {
                if (card.canvasState.strokes && !card.canvasState.layers) {
                    const firstLayerId = getUniqueId();
                    card.canvasState.layers = [{ id: firstLayerId, name: 'Layer 1', isVisible: true, strokes: card.canvasState.strokes || [] }];
                    card.canvasState.activeLayerId = firstLayerId;
                    delete card.canvasState.strokes;
                }

                if (!Array.isArray(card.canvasState.layers)) {
                    card.canvasState.layers = [];
                }

                card.canvasState.layers.forEach(layer => {
                    if (!layer || typeof layer !== 'object') return;
                    if (!layer.id) layer.id = getUniqueId();
                    if (typeof layer.name !== 'string') layer.name = 'Layer';
                    if (typeof layer.isVisible !== 'boolean') layer.isVisible = true;
                    if (!Array.isArray(layer.strokes)) layer.strokes = [];
                    layer.strokes = layer.strokes.filter((stroke: Stroke) => stroke && typeof stroke === 'object' && stroke.type);
                });

                if (card.canvasState.layers.length === 0) {
                    const firstLayerId = getUniqueId();
                    card.canvasState.layers.push({ id: firstLayerId, name: 'Layer 1', isVisible: true, strokes: [] });
                    card.canvasState.activeLayerId = firstLayerId;
                } else if (!card.canvasState.activeLayerId || !card.canvasState.layers.some(l => l.id === card.canvasState.activeLayerId)) {
                    card.canvasState.activeLayerId = card.canvasState.layers[0].id;
                }
            }
            sessionHistory[card.id] = { history: [], historyIndex: -1 };
        });
    });
}

export function getAppData() { return appData; }
export function getSessionHistory() { return sessionHistory; }

export function getCurrentOpenCardId() { return currentOpenCardId; }
export function setCurrentOpenCardId(id: number | null) { currentOpenCardId = id; }

export function requestRedraw() { redrawRequested = true; }
export function isRedrawRequested() { return redrawRequested; }
export function clearRedrawRequest() { redrawRequested = false; }

export function findCardById(cardId: number): { card: KanbanCard | null; fromColumn: KanbanColumn | null } {
    for (const col of appData.revisions.columns) {
        const card = col.cards.find(c => c.id === cardId);
        if (card) return { card, fromColumn: col };
    }
    return { card: null, fromColumn: null };
}

export function getActiveCardCanvasState(): CanvasData | null {
    if (!currentOpenCardId) return null;
    const { card } = findCardById(currentOpenCardId);
    return card ? card.canvasState : null;
}

export function getActiveLayer(): Layer | undefined | null {
    const canvasData = getActiveCardCanvasState();
    if (!canvasData || !canvasData.layers) return null;
    return canvasData.layers.find(l => l.id === canvasData.activeLayerId);
}

export function findStrokeAndLayer(strokeId: string | number) {
    const canvasData = getActiveCardCanvasState();
    if (!canvasData) return { stroke: null, layer: null };
    for (const layer of canvasData.layers) {
        const stroke = layer.strokes.find(s => s.id === strokeId);
        if (stroke) return { stroke, layer };
    }
    return { stroke: null as Stroke | null, layer: null as Layer | null };
}
