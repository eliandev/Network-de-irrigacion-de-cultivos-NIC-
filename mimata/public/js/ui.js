/**
 * MiMata — Utilidades de interfaz: toasts y diálogo de confirmación.
 * Sin dependencias; inyecta los contenedores en <body>.
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
 * Crea las regiones de toasts al arrancar: una región live que ya existe vacía
 * se anuncia de forma fiable; una creada junto con su primer mensaje, no.
 */
export function initUi() { ensureHosts(); }

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
  requestAnimationFrame(() => el.classList.add('toast--show'));
  const remove = () => {
    el.classList.remove('toast--show');
    setTimeout(() => el.remove(), 250);
  };
  setTimeout(remove, duration);
  el.addEventListener('click', remove);
}

/**
 * Diálogo de confirmación modal (<dialog> nativo: atrapa el foco, vuelve inerte
 * el fondo y cierra con Escape). Resuelve true/false.
 * @param {{title:string, message:string, confirmText?:string, cancelText?:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  ensureHosts();
  const { title, message, confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false } = opts;
  if (typeof HTMLDialogElement !== 'function') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  const opener = document.activeElement;
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    dlg.setAttribute('aria-describedby', 'dlg-msg');
    dlg.innerHTML = `
      <h2 id="dlg-title" class="modal__title">${escapeHtml(title)}</h2>
      <p id="dlg-msg" class="modal__msg">${escapeHtml(message)}</p>
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" data-action="cancel">${escapeHtml(cancelText)}</button>
        <button type="button" class="btn ${danger ? 'btn--danger-solid' : 'btn--primary'}" data-action="ok">${escapeHtml(confirmText)}</button>
      </div>`;
    dialogHost.appendChild(dlg);

    // Resuelve en el momento (no espera al evento 'close', que el navegador
    // entrega de forma asíncrona); 'close' queda para Escape y otros cierres.
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
      resolve(value);
    };
    dlg.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'ok') { finish(true); return; }
      if (action === 'cancel') { finish(false); return; }
      // Clic en el fondo (::backdrop): el target es el <dialog>, fuera de su caja.
      if (e.target === dlg) {
        const r = dlg.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) finish(false);
      }
    });
    dlg.addEventListener('close', () => finish(false));

    dlg.showModal();
    // En acciones destructivas el foco va a "Cancelar" (evita borrar con Enter por accidente).
    dlg.querySelector(danger ? '[data-action="cancel"]' : '[data-action="ok"]').focus();
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
