import { loadData } from './core/store';
import { switchView } from './ui/View';
import { initIcons } from './utils/dom';

document.addEventListener('DOMContentLoaded', () => {
    'use strict';
    
    // Initialise lucide icons
    initIcons();
    
    // Load persisted app data from local storage
    loadData();
    
    // Enter the app at the revision board
    switchView('revisions');
});
