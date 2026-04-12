import { $, $$ } from '../utils/dom';
import { setCurrentOpenCardId } from '../core/store';
import { renderRevisionsBoard } from './Kanban';
import { initCanvas } from '../canvas/canvas';

export function switchView(viewName: string) {
    $$('.view').forEach(view => view.classList.add('hidden'));
    const targetView = $(`#${viewName}-view`);
    if(targetView) targetView.classList.remove('hidden');
    
    if (viewName === 'canvas') {
        initCanvas();
    } else { 
        setCurrentOpenCardId(null); 
        renderRevisionsBoard(); 
    }
}
