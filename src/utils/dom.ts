import { createIcons, icons as lucideIcons } from 'lucide';

/** Helper to grab a single element with type assertion */
export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => 
  document.querySelector<T>(selector) as T;

/** Helper to grab a nodelist of elements with type assertion */
export const $$ = <T extends HTMLElement = HTMLElement>(selector: string): NodeListOf<T> => 
  document.querySelectorAll<T>(selector);

/** Triggers Lucide icons replacement on the DOM */
export function initIcons() {
  createIcons({ icons: lucideIcons, nameAttr: 'data-lucide' });
}
