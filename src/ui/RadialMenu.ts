import { $ } from '../utils/dom';
import { polarToCartesian, createWedgePath } from '../utils/math';
import { undo, redo } from '../canvas/history';
import { centerCanvasContent } from '../canvas/animation';
import { canvasState, brushSettings } from '../core/store';
import { setActiveTool } from '../canvas/tools';

export function initRadialToolbar() {
    const radialToolbar = $('#radial-toolbar');
    if (!radialToolbar) return;

    const tools = [
        { id: 'pen', icon: 'edit-3', name: 'Pen' }, 
        { id: 'highlighter', icon: 'edit', name: 'Highlighter' },
        { id: 'eraser', icon: 'trash', name: 'Eraser' }, 
        { id: 'lasso', icon: 'crop', name: 'Lasso' },
        { id: 'center-content', icon: 'compass', name: 'Find Content' }, 
        { id: 'undo', icon: 'corner-up-left', name: 'Undo' },
        { id: 'redo', icon: 'corner-up-right', name: 'Redo' }, 
        { id: 'laser', icon: 'radio', name: 'Laser Pointer' },
    ];
    const settingsTools = [
        { id: 'size-setting', icon: 'git-commit', name: 'Size' },
        { id: 'opacity-setting', icon: 'droplet', name: 'Opacity' },
        { id: 'smoothness-setting', icon: 'wind', name: 'Smoothness' },
    ];

    radialToolbar.querySelector('svg')?.remove();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute('viewBox', '0 0 200 200');

    const createRing = (toolsArray: { id: string, icon: string, name: string }[], innerR: number, outerR: number) => {
        const anglePerWedge = (2 * Math.PI) / toolsArray.length;
        toolsArray.forEach((tool, i) => {
            const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
            g.classList.add('tool-group'); 
            g.dataset.toolId = tool.id;
            
            const sa = i * anglePerWedge - (Math.PI / 2);
            const ea = (i + 1) * anglePerWedge - (Math.PI / 2);
            
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute('d', createWedgePath(100, 100, innerR, outerR, sa, ea));
            path.classList.add('tool-wedge');
            
            const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
            title.textContent = tool.name;
            g.append(title, path);
            
            const p1 = polarToCartesian(100, 100, innerR, sa);
            const p2 = polarToCartesian(100, 100, outerR, sa);
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute('x1', String(p1.x)); 
            line.setAttribute('y1', String(p1.y)); 
            line.setAttribute('x2', String(p2.x)); 
            line.setAttribute('y2', String(p2.y));
            line.classList.add('tool-separator');
            g.appendChild(line);
            
            const iconPos = polarToCartesian(100, 100, (innerR + outerR) / 2, (sa + ea) / 2);
            const tempDiv = document.createElement('div');
            const iconSize = (outerR - innerR) * 0.45;
            tempDiv.innerHTML = `<svg data-lucide="${tool.icon}" class="tool-icon" x="${iconPos.x - iconSize / 2}" y="${iconPos.y - iconSize / 2}" width="${iconSize}" height="${iconSize}"></svg>`;
            if (tempDiv.firstChild) g.appendChild(tempDiv.firstChild);
            svg.appendChild(g);
        });
    };

    const createSeparator = (r: number) => {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute('cx', '100'); 
        circle.setAttribute('cy', '100'); 
        circle.setAttribute('r', String(r)); 
        circle.classList.add('ring-separator');
        return circle;
    };

    createRing(tools, 62, 100);
    createRing(settingsTools, 24, 62);
    svg.append(createSeparator(62), createSeparator(24));
    radialToolbar.appendChild(svg);

    window.updateActiveWedge = () => {
        svg.querySelectorAll('.tool-wedge').forEach(p => p.classList.remove('active'));

        const activeToolWedge = svg.querySelector(`.tool-group[data-tool-id="${canvasState.activeTool}"] .tool-wedge`);
        if (activeToolWedge) activeToolWedge.classList.add('active');

        if (canvasState.activeSettingWedge) {
            const activeSettingWedgeEl = svg.querySelector(`.tool-group[data-tool-id="${canvasState.activeSettingWedge}"] .tool-wedge`);
            if (activeSettingWedgeEl) activeSettingWedgeEl.classList.add('active');
        }
    }

    svg.addEventListener('click', (e) => {
        const toolId = (e.target as HTMLElement)?.closest<HTMLElement>('.tool-group')?.dataset.toolId;
        if (!toolId) return;

        const settingsPopup = $('#settings-popup');

        if (toolId === 'undo') { undo(); return; }
        if (toolId === 'redo') { redo(); return; }
        if (toolId === 'center-content') { centerCanvasContent(); return; }

        if (toolId === 'size-setting' || toolId === 'opacity-setting' || toolId === 'smoothness-setting') {
            updateSettingsUI();

            const activeToolWedge = canvasState.activeTool;
            const settings = brushSettings[activeToolWedge];
            const hasSettings = settings?.hasOwnProperty('lineWidth') || settings?.hasOwnProperty('opacity') || settings?.hasOwnProperty('smoothness');

            if (hasSettings) {
                if (canvasState.activeSettingWedge === toolId) {
                    settingsPopup.classList.remove('flex'); 
                    settingsPopup.classList.add('hidden');
                    canvasState.activeSettingWedge = null;
                } else {
                    settingsPopup.classList.remove('hidden'); 
                    settingsPopup.classList.add('flex');
                    canvasState.activeSettingWedge = toolId;
                }
            } else {
                settingsPopup.classList.remove('flex'); 
                settingsPopup.classList.add('hidden');
                canvasState.activeSettingWedge = null;
            }
            window.updateActiveWedge?.();
            return;
        }

        settingsPopup.classList.remove('flex'); 
        settingsPopup.classList.add('hidden');
        canvasState.activeSettingWedge = null;
        setActiveTool(toolId);
    });

    window.updateActiveWedge?.(); 
    updateSettingsUI();

    $('#color-display').style.backgroundColor = brushSettings[canvasState.activeTool]?.color || '#FFFFFF';
    $('#color-display-wrapper').addEventListener('click', (e) => { 
        e.stopPropagation(); 
        $('#simple-color-picker').classList.toggle('hidden'); 
        $('#simple-color-picker').classList.toggle('grid'); 
    });

    // Handle outside clicks for Popups
    document.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement;
        const settingsPopup = $('#settings-popup');
        const layersPanel = $('#layers-panel');
        const radialColorPicker = $('#simple-color-picker');
        const selectionColorPicker = $('#selection-color-picker');

        const isRadialClick = target.closest('#radial-toolbar') ||
            target.closest('#simple-color-picker') ||
            target.closest('#settings-popup');

        if (settingsPopup && settingsPopup.classList.contains('flex') && !isRadialClick) {
            settingsPopup.classList.remove('flex'); 
            settingsPopup.classList.add('hidden');
            canvasState.activeSettingWedge = null;
            if(window.updateActiveWedge) window.updateActiveWedge(); 
        }

        if (layersPanel && layersPanel.classList.contains('flex') && !layersPanel.contains(target) && !target.closest('#layers-btn')) {
            layersPanel.classList.remove('flex'); 
            layersPanel.classList.add('hidden');
        }

        if (radialColorPicker && radialColorPicker.classList.contains('grid') && !isRadialClick) {
            radialColorPicker.classList.remove('grid'); 
            radialColorPicker.classList.add('hidden');
        }

        if (selectionColorPicker && selectionColorPicker.classList.contains('grid') && !selectionColorPicker.contains(target) && !target.closest('#selection-color-wrapper')) {
            selectionColorPicker.classList.remove('grid'); 
            selectionColorPicker.classList.add('hidden');
        }
    });

}

export function updateSettingsUI() {
    const tool = canvasState.activeTool;
    const settings = brushSettings[tool];
    const show = (el: HTMLElement, condition: boolean | undefined) => {
        if(el) el.style.display = condition ? 'flex' : 'none';
    };

    show($('#pen-size-setting'), settings?.hasOwnProperty('lineWidth'));
    show($('#opacity-setting'), settings?.hasOwnProperty('opacity'));
    show($('#smoothness-setting'), settings?.hasOwnProperty('smoothness'));

    if (!settings) return;

    if (settings.hasOwnProperty('lineWidth')) {
        const el = $('#pen-size-slider') as HTMLInputElement;
        if(el) el.value = String(settings.lineWidth);
        const valEl = $('#pen-size-value');
        if(valEl) valEl.textContent = String(settings.lineWidth);
    }
    if (settings.hasOwnProperty('opacity')) {
        const el = $('#opacity-slider') as HTMLInputElement;
        if(el) el.value = String(settings.opacity ?? '');
        const valEl = $('#opacity-value');
        if(valEl) valEl.textContent = String(settings.opacity ?? '');
    }
    if (settings.hasOwnProperty('smoothness')) {
        const el = $('#smoothness-slider') as HTMLInputElement;
        if(el) el.value = String(settings.smoothness ?? '');
        const valEl = $('#smoothness-value');
        if(valEl) valEl.textContent = String(settings.smoothness ?? '');
    }
    if (settings.hasOwnProperty('color')) {
        const el = $('#color-display');
        if(el) el.style.backgroundColor = settings.color || '#FFFFFF';
    }
}
