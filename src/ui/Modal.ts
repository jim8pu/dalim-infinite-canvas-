import { $ } from '../utils/dom';

export const Modal = {
  _resolve: null as ((value: unknown) => void) | null,
  overlay: $('#custom-modal'),
  titleEl: $('#modal-title'),
  bodyEl: $('#modal-body'),
  actionsEl: $('#modal-actions'),

  confirm(title: string, message: string): Promise<boolean> {
      return new Promise(resolve => {
          this._resolve = resolve as (value: unknown) => void;
          this.titleEl.textContent = title;
          this.bodyEl.innerHTML = `<p>${message}</p>`;
          this.actionsEl.innerHTML = `
              <button class="modal-btn modal-btn-secondary" data-value="false">Cancel</button>
              <button class="modal-btn modal-btn-danger" data-value="true">Confirm</button>
          `;
          this._show();
      });
  },

  prompt(title: string, defaultValue: string = ''): Promise<string | null> {
      return new Promise(resolve => {
          this._resolve = resolve as (value: unknown) => void;
          this.titleEl.textContent = title;
          this.bodyEl.innerHTML = `<input type="text" id="modal-input" class="modal-input" value="${defaultValue}">`;
          this.actionsEl.innerHTML = `
              <button class="modal-btn modal-btn-secondary" data-value="null">Cancel</button>
              <button class="modal-btn modal-btn-primary" data-value="submit">OK</button>
          `;
          this._show();
          setTimeout(() => $<HTMLInputElement>('#modal-input')?.focus(), 50);
      });
  },

  _show() { 
      this.overlay.classList.remove('opacity-0', 'pointer-events-none'); 
      this.overlay.classList.add('opacity-100', 'pointer-events-auto'); 
      this.overlay.onclick = this._handleClick.bind(this); 
  },

  _hide() { 
      this.overlay.classList.remove('opacity-100', 'pointer-events-auto'); 
      this.overlay.classList.add('opacity-0', 'pointer-events-none'); 
      this.overlay.onclick = null; 
  },

  _handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const button = target.closest<HTMLElement>('.modal-btn');
      if (target === this.overlay) { 
          this._resolve?.(null); 
          this._hide(); 
      }
      else if (button) {
          const value = button.dataset.value;
          if (value === 'null') this._resolve?.(null);
          else if (value === 'submit') this._resolve?.($<HTMLInputElement>('#modal-input')?.value);
          else this._resolve?.(value === 'true');
          this._hide();
      }
  }
};
