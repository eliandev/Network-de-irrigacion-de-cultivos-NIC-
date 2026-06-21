/**
 * NIC — Utilidades de interfaz compartidas: toasts y dialogo de confirmacion.
 * Sin dependencias; inyecta los contenedores en <body> la primera vez.
 */

let toastHost = null;
let dialogHost = null;

function ensureHosts() {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.id = 'toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    toastHost.setAttribute('aria-atomic', 'true');
    document.body.appendChild(toastHost);
  }
  if (!dialogHost) {
    dialogHost = document.createElement('div');
    dialogHost.id = 'dialog-host';
    document.body.appendChild(dialogHost);
  }
}

/**
 * Muestra un toast transitorio.
 * @param {string} message
 * @param {{type?: 'info'|'ok'|'error', duration?: number}} [opts]
 */
export function toast(message, opts = {}) {
  ensureHosts();
  const { type = 'info', duration = 3000 } = opts;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  toastHost.appendChild(el);
  // Forzar reflow para la transicion de entrada.
  requestAnimationFrame(() => el.classList.add('toast--show'));
  const remove = () => {
    el.classList.remove('toast--show');
    setTimeout(() => el.remove(), 250);
  };
  setTimeout(remove, duration);
  el.addEventListener('click', remove);
}

/**
 * Dialogo de confirmacion accesible. Resuelve true/false.
 * @param {{title:string, message:string, confirmText?:string, cancelText?:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  ensureHosts();
  const { title, message, confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false } = opts;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-msg">
        <h2 id="dlg-title" class="modal__title">${escapeHtml(title)}</h2>
        <p id="dlg-msg" class="modal__msg">${escapeHtml(message)}</p>
        <div class="modal__actions">
          <button type="button" class="btn btn--ghost" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-action="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    dialogHost.appendChild(overlay);

    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'ok') close(true);
      if (action === 'cancel') close(false);
    });
    document.addEventListener('keydown', onKey);
    // Foco en el boton principal.
    overlay.querySelector('[data-action="ok"]').focus();
  });
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
