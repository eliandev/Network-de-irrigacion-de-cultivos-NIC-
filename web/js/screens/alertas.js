/**
 * NIC — Pantalla Alertas (PRD 7.4).
 * Proposito: avisar de eventos importantes (humedad critica, perdida de
 * conexion, enlace con el Arduino) tanto en-app como por notificaciones del
 * navegador (cuando el usuario lo permite).
 *
 * Contrato de pantalla (lo siguen todas las pantallas):
 *   export function mount(root)  -> construye el DOM y se suscribe al store
 *   export function unmount()    -> limpia suscripciones y temporizadores
 */

import { store } from '../store.js';
import { alerts } from '../alerts.js';
import { confirmDialog, escapeHtml } from '../ui.js';
import { icon } from '../icons.js';

let unsub = null;
let mounted = false;   // guard de vida para callbacks async

export function mount(root) {
  mounted = true;
  root.innerHTML = `
    <h1 class="screen-title">Alertas</h1>
    <p class="screen-sub">Avisos sobre el estado de tu sistema de riego.</p>

    <div class="card">
      <div class="card__header">
        <span class="card__title">Notificaciones del navegador</span>
        <span id="al-perm-chip"></span>
      </div>
      <p class="soon-note">
        Las notificaciones funcionan con la aplicación abierta. Recibir avisos
        con la app cerrada llegará en una próxima fase (limitación del MVP).
      </p>
      <div class="btn-row mt">
        <button type="button" class="btn btn--primary" id="al-enable" hidden>
          ${icon('bell', { size: 16 })} Activar notificaciones
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__title">Historial de alertas</span>
        <span id="al-count" class="chip"></span>
      </div>
      <div class="btn-row mt">
        <button type="button" class="btn btn--ghost btn--small" id="al-mark-read">
          ${icon('check', { size: 16 })} Marcar como leídas
        </button>
        <button type="button" class="btn btn--danger btn--small" id="al-clear">
          ${icon('trash', { size: 16 })} Limpiar
        </button>
      </div>
      <div id="al-list" class="mt"></div>
    </div>

    <div class="card is-soon">
      <div class="card__header">
        <span class="card__title">${icon('waves', { size: 18 })} Nivel de agua y hardware avanzado</span>
        <span class="badge-soon">Próximamente</span>
      </div>
      <p class="soon-note">
        Las alertas de nivel de agua del depósito y de sensores de hardware
        avanzado llegarán cuando ese equipo esté disponible.
      </p>
    </div>
  `;

  // Boton: activar notificaciones del navegador.
  root.querySelector('#al-enable').addEventListener('click', async () => {
    try {
      await alerts.requestPermission();
      if (!mounted) return; // pudo desmontarse mientras el navegador preguntaba
      // requestPermission no toca el store; re-renderizamos para reflejar el chip.
      render(root);
    } catch (err) {
      console.warn('[alertas] no se pudo solicitar permiso', err);
    }
  });

  // Accion: marcar todas como leidas.
  root.querySelector('#al-mark-read').addEventListener('click', () => {
    alerts.markAllRead(); // dispara notify() del store -> re-render
  });

  // Accion: limpiar todo (con confirmacion).
  root.querySelector('#al-clear').addEventListener('click', async () => {
    const state = store.getState();
    if (state.alerts.length === 0) return;
    const ok = await confirmDialog({
      title: 'Limpiar alertas',
      message: 'Se eliminarán todas las alertas del historial. Esta acción no se puede deshacer.',
      confirmText: 'Limpiar',
      cancelText: 'Cancelar',
      danger: true,
    });
    if (ok) alerts.clearAll();
  });

  // Al visitar la pantalla, marcamos todo como leido una sola vez para que el
  // badge de la pestaña Alertas vuelva a cero. No se hace en render().
  alerts.markAllRead();

  unsub = store.subscribe(() => render(root));
  render(root);
}

export function unmount() {
  mounted = false;
  if (unsub) { unsub(); unsub = null; }
}

function render(root) {
  const state = store.getState();
  const list = state.alerts || [];

  // --- Chip de permiso de notificaciones + visibilidad del boton ---
  const perm = alerts.permission(); // 'granted' | 'denied' | 'default' | 'unsupported'
  const chipEl = root.querySelector('#al-perm-chip');
  const enableBtn = root.querySelector('#al-enable');
  const pd = permDescriptor(perm);
  chipEl.innerHTML = `<span class="chip ${pd.chip}">${icon(pd.icon, { size: 14 })} ${escapeHtml(pd.label)}</span>`;
  // El boton solo tiene sentido cuando aun se puede pedir permiso.
  enableBtn.hidden = !(perm === 'default' || perm === 'denied');

  // --- Contador del historial ---
  const countEl = root.querySelector('#al-count');
  countEl.textContent = `${list.length} ${list.length === 1 ? 'alerta' : 'alertas'}`;

  // --- Lista de alertas ---
  const listEl = root.querySelector('#al-list');
  if (list.length === 0) {
    listEl.innerHTML = `<p class="empty-state">Todo en orden, sin alertas por ahora.</p>`;
  } else {
    listEl.innerHTML = `<div class="list">${list.map(alertRow).join('')}</div>`;
  }
}

/** Devuelve la presentacion (chip + icono + texto) del estado del permiso. */
function permDescriptor(perm) {
  switch (perm) {
    case 'granted':
      return { chip: 'chip--ok', icon: 'check-circle', label: 'Activadas' };
    case 'denied':
      return { chip: 'chip--error', icon: 'bell-off', label: 'Bloqueadas en el navegador' };
    case 'unsupported':
      return { chip: 'chip--warn', icon: 'ban', label: 'No disponibles en este navegador' };
    case 'default':
    default:
      return { chip: 'chip--info', icon: 'bell', label: 'Sin activar' };
  }
}

/** Renderiza una fila de alerta del historial. */
function alertRow(a) {
  const severity = a.severity === 'critico' ? 'critico' : 'aviso';
  const ic = severity === 'critico'
    ? icon('octagon-alert', { size: 20 })
    : icon('triangle-alert', { size: 20 });
  const unread = !a.read ? ' is-unread' : '';
  return `
    <div class="alert-item alert-item--${severity}${unread}">
      <span class="alert-item__icon">${ic}</span>
      <div class="alert-item__body">
        <div class="alert-item__title">${escapeHtml(a.title)}</div>
        <div class="alert-item__msg">${escapeHtml(a.message)}</div>
        <div class="alert-item__time">${fmtTime(a.ts)}</div>
      </div>
    </div>`;
}

/** Hora local legible (es) a partir de un epoch(ms). */
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString('es', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}
