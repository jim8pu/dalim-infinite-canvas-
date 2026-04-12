import { $, $$ } from '../utils/dom';
import { KanbanCard, KanbanColumn } from '../core/types';
import { getUniqueId } from '../utils/math';
import { getAppData, saveData, getSessionHistory, setCurrentOpenCardId, createDefaultCanvasState, findCardById } from '../core/store';
import { Modal } from './Modal';
import { initIcons } from '../utils/dom';
import { switchView } from './View.ts';

export function renderRevisionsBoard() {
    const view = $('#revisions-view');
    if (!view) return;
    
    const scrollLeft = view.querySelector('.board-columns')?.scrollLeft;
    const appData = getAppData();

    view.innerHTML = `
        <div class="flex flex-col w-full h-full">
            <div class="flex justify-center items-center px-6 py-4 shrink-0 relative text-center">
                <h1 class="text-base font-semibold m-0">${appData.revisions.title}</h1>
                <button class="add-column-btn absolute right-6 top-1/2 -translate-y-1/2 bg-panel border border-border text-primary px-4 py-2 rounded-lg cursor-pointer transition-all duration-200 font-medium hover:bg-[#27272a]">+ Add Column</button>
            </div>
            <div class="board-columns flex gap-4 grow px-6 pb-6 overflow-x-auto touch-pan-x" style="-webkit-overflow-scrolling: touch;">
                ${appData.revisions.columns.map(col => `
                    <div class="board-column flex flex-col shrink-0 w-[320px] bg-column border border-border rounded-xl h-full box-border transition-transform duration-200" data-col-id="${col.id}">
                        <div class="column-header flex justify-between items-center p-1.5 px-2 font-semibold cursor-grab relative select-none border-b border-border touch-none transition-opacity duration-200 active:cursor-grabbing">
                            <span class="grow pl-2">${col.title}</span>
                            <div class="relative">
                                <button class="column-menu-btn bg-none border-none text-secondary cursor-pointer p-1 rounded-md flex items-center justify-center hover:bg-white/10 hover:text-primary"><i data-lucide="more-horizontal" class="w-5 h-5"></i></button>
                                <div class="column-menu-popup absolute top-full right-0 bg-panel border border-border rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.4)] z-10 flex flex-col p-1 w-[120px] scale-95 opacity-0 pointer-events-none transition-all duration-100">
                                    <button class="rename-column-btn bg-none border-none text-primary p-2 text-left text-sm rounded-md cursor-pointer flex items-center gap-2 hover:bg-white/10 w-full"><i data-lucide="edit-2" class="w-4 h-4"></i>Rename</button>
                                    <button class="delete-column-btn bg-none border-none text-red p-2 text-left text-sm rounded-md cursor-pointer flex items-center gap-2 hover:bg-white/10 w-full"><i data-lucide="trash" class="w-4 h-4"></i>Delete</button>
                                </div>
                            </div>
                        </div>
                        <div class="column-cards grow p-2 overflow-y-auto min-h-[100px] touch-pan-y" style="-webkit-overflow-scrolling: touch;">${col.cards.map(renderCard).join('')}</div>
                        <div class="column-footer text-center p-3 text-secondary border-t border-border rounded-b-[11px] cursor-pointer transition-all duration-200 hover:text-primary hover:bg-white/5" data-col-id="${col.id}">+ Create Canvas</div>
                    </div>
                `).join('')}
            </div>
        </div>`;

    if (scrollLeft) view.querySelector<HTMLElement>('.board-columns')!.scrollLeft = scrollLeft;

    addBoardEventListeners();
    initIcons();
}

function renderCard(card: KanbanCard) {
    return `<div class="card group relative bg-panel border border-border rounded-lg p-4 mb-2 cursor-grab select-none touch-none transition-transform duration-200 hover:border-purple active:cursor-grabbing active:border-pink" data-card-id="${card.id}">
                <h3 class="m-0 mb-1 text-base font-medium">${card.title}</h3>
                <div class="hidden absolute top-2 right-2 bg-panel border border-border rounded-md overflow-hidden group-hover:flex items-center">
                    <div class="open-canvas action-btn text-secondary p-1 flex items-center justify-center cursor-pointer hover:bg-white/10 hover:text-primary" title="Open in Canvas"><i data-lucide="arrow-up-right" class="w-4 h-4"></i></div>
                    <div class="rename-card action-btn text-secondary p-1 flex items-center justify-center cursor-pointer hover:bg-white/10 hover:text-primary" title="Rename Card"><i data-lucide="edit-2" class="w-4 h-4"></i></div>
                    <div class="delete-card action-btn text-secondary p-1 flex items-center justify-center cursor-pointer hover:bg-white/10 hover:text-red" title="Delete Card"><i data-lucide="x" class="w-4 h-4"></i></div>
                </div>
            </div>`;
}

function getDragAfterElement(container: HTMLElement, coordinate: number, selector: string): Element | null {
    const isHorizontal = container.classList.contains('board-columns');
    const draggableElements = [...container.querySelectorAll(selector)];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = isHorizontal ? coordinate - box.left - box.width / 2 : coordinate - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset, element: child };
        return closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null as Element | null }).element;
}

function addBoardEventListeners() {
    const view = $('#revisions-view');
    if (!view || view.dataset.listenersAttached) return;

    interface DragState {
        type?: 'card' | 'column';
        element?: HTMLElement;
        ghost?: HTMLElement;
        offsetX?: number;
        offsetY?: number;
        longPressTimeout?: ReturnType<typeof setTimeout>;
    }
    let dragState: DragState = {};
    const appData = getAppData();
    const sessionHistory = getSessionHistory();

    view.addEventListener('click', async (e: Event) => {
        const target = e.target as HTMLElement;
        const menuBtn = target.closest<HTMLElement>('.column-menu-btn');
        if (menuBtn) {
            const popup = menuBtn.nextElementSibling as HTMLElement;
            const isVisible = popup.classList.contains('opacity-100');
            $$('.column-menu-popup').forEach(p => { 
                p.classList.remove('opacity-100', 'pointer-events-auto', 'scale-100'); 
                p.classList.add('opacity-0', 'pointer-events-none', 'scale-95'); 
            });
            if (!isVisible) { 
                popup.classList.remove('opacity-0', 'pointer-events-none', 'scale-95'); 
                popup.classList.add('opacity-100', 'pointer-events-auto', 'scale-100'); 
            }
            return;
        }
        if (!target.closest('.column-menu-popup')) {
            $$('.column-menu-popup').forEach(p => { 
                p.classList.remove('opacity-100', 'pointer-events-auto', 'scale-100'); 
                p.classList.add('opacity-0', 'pointer-events-none', 'scale-95'); 
            });
        }

        const cardElement = target.closest<HTMLElement>('.card');
        if (cardElement && !target.closest('.action-btn')) {
            const isShowing = cardElement.classList.contains('show-actions');
            $$('.card.show-actions').forEach(c => c.classList.remove('show-actions'));
            if (!isShowing) cardElement.classList.add('show-actions');
            return;
        }
        if (!cardElement) {
            $$('.card.show-actions').forEach(c => c.classList.remove('show-actions'));
        }

        const addColumnBtn = target.closest<HTMLElement>('.add-column-btn');
        const deleteColumnBtn = target.closest<HTMLElement>('.delete-column-btn');
        const renameColumnBtn = target.closest<HTMLElement>('.rename-column-btn');
        const columnFooter = target.closest<HTMLElement>('.column-footer');
        const deleteCardBtn = target.closest<HTMLElement>('.delete-card');
        const renameCardBtn = target.closest<HTMLElement>('.rename-card');
        const openCanvasBtn = target.closest<HTMLElement>('.open-canvas');

        if (addColumnBtn) {
            const title = await Modal.prompt('Enter new column name:');
            if (title?.trim()) {
                appData.revisions.columns.push({ id: getUniqueId(), title: title.trim(), cards: [] });
                saveData(); renderRevisionsBoard();
            }
        } else if (deleteColumnBtn) {
            const colId = parseFloat(deleteColumnBtn.closest<HTMLElement>('.board-column')!.dataset.colId!);
            const column = appData.revisions.columns.find(c => c.id === colId);
            if (column && await Modal.confirm('Delete Column?', `Are you sure you want to delete "${column.title}" and all its cards?`)) {
                appData.revisions.columns = appData.revisions.columns.filter(c => c.id !== colId);
                saveData(); renderRevisionsBoard();
            }
        } else if (renameColumnBtn) {
            const colId = parseFloat(renameColumnBtn.closest<HTMLElement>('.board-column')!.dataset.colId!);
            const column = appData.revisions.columns.find(c => c.id === colId);
            const newTitle = column ? await Modal.prompt('Enter new column name:', column.title) : null;
            if (column && newTitle?.trim()) {
                column.title = newTitle.trim();
                saveData(); renderRevisionsBoard();
            }
        } else if (columnFooter) {
            const title = await Modal.prompt('Enter card name:');
            if (title?.trim()) {
                const colId = parseFloat(columnFooter.dataset.colId!);
                const column = appData.revisions.columns.find(c => c.id === colId);
                if (column) {
                    const newCard = { id: getUniqueId(), title: title.trim(), canvasState: createDefaultCanvasState() };
                    column.cards.push(newCard);
                    sessionHistory[newCard.id] = { history: [], historyIndex: -1 };
                    saveData(); renderRevisionsBoard();
                }
            }
        } else if (deleteCardBtn) {
            if (await Modal.confirm('Delete Card?', 'This action cannot be undone.')) {
                const cardId = parseFloat(deleteCardBtn.closest<HTMLElement>('.card')!.dataset.cardId!);
                appData.revisions.columns.forEach(c => { c.cards = c.cards.filter(crd => crd.id !== cardId) });
                delete sessionHistory[cardId];
                saveData(); renderRevisionsBoard();
            }
        } else if (renameCardBtn) {
            const cardId = parseFloat(renameCardBtn.closest<HTMLElement>('.card')!.dataset.cardId!);
            let cardRef: KanbanCard | null = null;
            appData.revisions.columns.forEach(c => c.cards.forEach(crd => { if (crd.id === cardId) cardRef = crd; }));

            if (cardRef) {
                const newTitle = await Modal.prompt('Enter new card name:', (cardRef as KanbanCard).title);
                if (newTitle?.trim()) {
                    (cardRef as KanbanCard).title = newTitle.trim();
                    saveData(); renderRevisionsBoard();
                }
            }
        } else if (openCanvasBtn) {
            setCurrentOpenCardId(parseFloat(openCanvasBtn.closest<HTMLElement>('.card')!.dataset.cardId!));
            switchView('canvas');
        }
    });

    const moveDrag = (e: MouseEvent | TouchEvent) => {
        if (!dragState.ghost) return;
        e.preventDefault();
        const isTouchEvent = e.type.includes('touch');
        const point = isTouchEvent ? (e as TouchEvent).touches[0] : (e as MouseEvent);
        
        dragState.ghost.style.left = `${point.clientX - (dragState.offsetX || 0)}px`;
        if (dragState.type === 'card') {
            dragState.ghost.style.top = `${point.clientY - (dragState.offsetY || 0)}px`;
        } else {
            const headerRect = dragState.element?.querySelector('.column-header')?.getBoundingClientRect();
            if (headerRect) dragState.ghost.style.top = `${headerRect.top}px`;
        }
        
        dragState.ghost.style.visibility = 'hidden';
        const elementUnder = document.elementFromPoint(point.clientX, point.clientY);
        dragState.ghost.style.visibility = 'visible';
        
        $('.card-placeholder')?.remove();
        
        if (dragState.type === 'card') {
            const cardList = elementUnder?.closest('.column-cards') as HTMLElement | null;
            if (cardList) {
                const placeholder = document.createElement('div');
                placeholder.className = 'card-placeholder';
                const afterElement = getDragAfterElement(cardList, point.clientY, '.card:not(.is-dragging)');
                cardList.insertBefore(placeholder, afterElement);
            }
        } else if (dragState.type === 'column') {
            const columnList = dragState.element?.parentElement;
            if (columnList && dragState.element) {
                const afterElement = getDragAfterElement(columnList, point.clientX, '.board-column:not(.is-dragging-column)');
                columnList.insertBefore(dragState.element, afterElement);
            }
        }
    };

    const endDrag = () => {
        clearTimeout(dragState.longPressTimeout);
        if (!dragState.element) return;

        dragState.ghost?.remove();
        const placeholder = $('.card-placeholder');

        if (dragState.type === 'column') {
            const newOrderedColumns: KanbanColumn[] = [];
            const columnList = dragState.element?.parentElement;
            if (columnList) {
                columnList.querySelectorAll<HTMLElement>('.board-column').forEach(c => {
                    const colId = parseFloat(c.dataset.colId || '0');
                    const foundCol = appData.revisions.columns.find(col => col.id === colId);
                    if (foundCol) newOrderedColumns.push(foundCol);
                });
                appData.revisions.columns = newOrderedColumns;
            }
        } else if (placeholder && placeholder.parentElement) {
            const cardId = parseFloat(dragState.element?.dataset.cardId || '0');
            const targetColId = parseFloat((placeholder.closest('.board-column') as HTMLElement)?.dataset.colId || '0');
            const { card: cardData, fromColumn } = findCardById(cardId);
            const targetCol = appData.revisions.columns.find(c => c.id === targetColId);

            if (cardData && targetCol && fromColumn) {
                fromColumn.cards = fromColumn.cards.filter(c => c.id !== cardId);
                const newIndex = Array.from(placeholder.parentElement.children).indexOf(placeholder);
                targetCol.cards.splice(newIndex, 0, cardData);
            }
        }

        saveData();
        renderRevisionsBoard();

        dragState = {};
        window.removeEventListener('mousemove', moveDrag);
        window.removeEventListener('mouseup', endDrag);
        window.removeEventListener('touchmove', moveDrag as EventListener);
        window.removeEventListener('touchend', endDrag);
        window.removeEventListener('touchcancel', endDrag);
    };

    const startDrag = (e: MouseEvent | TouchEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('.action-btn') || target.closest('.column-menu-btn')) return;
        
        const isTouchEvent = e.type === 'touchstart';
        const point = isTouchEvent ? (e as TouchEvent).touches[0] : (e as MouseEvent);
        const pointTarget = point.target as HTMLElement;
        
        const targetCard = pointTarget?.closest<HTMLElement>('.card');
        const targetColumnHeader = pointTarget?.closest<HTMLElement>('.column-header');
        
        if (!targetCard && !targetColumnHeader) return;
        
        dragState.element = targetCard || targetColumnHeader?.closest<HTMLElement>('.board-column') || undefined;
        dragState.type = targetCard ? 'card' : 'column';
        
        const startAction = () => {
            if (!dragState.element) return;
            const rect = dragState.element.getBoundingClientRect();
            
            if (dragState.type === 'card') {
                dragState.offsetX = point.clientX - rect.left;
                dragState.offsetY = point.clientY - rect.top;
                dragState.ghost = dragState.element.cloneNode(true) as HTMLElement;
                dragState.ghost.style.height = `${rect.height}px`;
            } else {
                const header = dragState.element.querySelector('.column-header') as HTMLElement | null;
                if (!header) return;
                const headerRect = header.getBoundingClientRect();
                dragState.offsetX = point.clientX - headerRect.left;
                dragState.offsetY = point.clientY - headerRect.top;
                dragState.ghost = header.cloneNode(true) as HTMLElement;
            }
            
            dragState.ghost.classList.add('ghost');
            dragState.ghost.style.width = `${rect.width}px`;
            document.body.appendChild(dragState.ghost);
            
            moveDrag(e);
            dragState.element.classList.add(dragState.type === 'card' ? 'is-dragging' : 'is-dragging-column');
            
            if (isTouchEvent) {
                window.addEventListener('touchmove', moveDrag as EventListener, { passive: false });
                window.addEventListener('touchend', endDrag);
                window.addEventListener('touchcancel', endDrag);
            } else {
                window.addEventListener('mousemove', moveDrag as EventListener);
                window.addEventListener('mouseup', endDrag);
            }
        };
        
        if (isTouchEvent) {
            dragState.longPressTimeout = setTimeout(startAction, 200);
        } else { 
            e.preventDefault(); 
            startAction(); 
        }
    };

    view.addEventListener('mousedown', startDrag);
    view.addEventListener('touchstart', startDrag, { passive: true });
    view.addEventListener('touchend', () => clearTimeout(dragState.longPressTimeout));
    view.addEventListener('touchcancel', () => clearTimeout(dragState.longPressTimeout));

    view.dataset.listenersAttached = 'true';
}
