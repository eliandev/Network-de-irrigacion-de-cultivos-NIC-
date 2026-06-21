/**
 * NIC — Pantalla Ajustes (PRD 7.5).
 * Configuración general: conexión, notificaciones, unidades, idioma e
 * información del dispositivo. Lee/escribe preferencias con
 * settings.get()/settings.patch() y refleja el estado de red del store.
 *
 * Contrato de pantalla (lo siguen todas las pantallas):
 *   export function mount(root)  -> construye el DOM y se suscribe al store
 *   export function unmount()    -> limpia suscripciones y temporizadores
 */

import { store } from '../store.js';
import { settings } from '../settings.js';
import { ws } from '../ws-client.js';
import { CONN, LINK } from '../protocol.js';
import { toast, confirmDialog, escapeHtml } from '../ui.js';

let unsub = null;
let mounted = false;   // guard de vida para callbacks async

export function mount(root) {
  mounted = true;
  const cfg = settings.get();

  root.innerHTML = `
    <h1 class="screen-title">Ajustes</h1>
    <p class="screen-sub">Configuración general de la app.</p>

    <!-- 1) Conexión -->
    <div class="card">
      <div class="card__header"><span class="card__title">Conexión</span></div>
      <div class="field">
        <label for="set-host">Host / IP del dispositivo</label>
        <input type="text" id="set-host" inputmode="url" autocomplete="off"
               spellcheck="false" placeholder="riego.local"
               value="${escapeHtml(cfg.host || '')}" />
        <span class="hint">Déjalo vacío para usar la dirección desde la que se sirve la app.</span>
      </div>
      <div class="btn-row mt">
        <button type="button" class="btn btn--ghost" id="set-test">Probar conexión</button>
        <button type="button" class="btn btn--primary" id="set-save">Guardar</button>
      </div>
      <div class="kv mt">
        <span class="kv__k">URL WebSocket efectiva</span>
        <span class="kv__v small" id="set-wsurl">—</span>
      </div>
    </div>

    <!-- 2) Notificaciones -->
    <div class="card">
      <div class="card__header"><span class="card__title">Notificaciones</span></div>
      <label class="switch" for="set-notify-critical">
        <input type="checkbox" id="set-notify-critical" />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Alertas críticas de humedad</span>
      </label>
      <label class="switch mt" for="set-notify-connection">
        <input type="checkbox" id="set-notify-connection" />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Avisos de conexión</span>
      </label>
      <div class="field mt">
        <label for="set-critical-pct">Humedad crítica (%)</label>
        <input type="number" id="set-critical-pct" min="0" max="100" step="1"
               inputmode="numeric" value="${escapeHtml(String(cfg.criticalPct))}" />
        <span class="hint">Por debajo de este valor se considera estado crítico.</span>
      </div>
    </div>

    <!-- 3) Unidades e idioma -->
    <div class="card">
      <div class="card__header"><span class="card__title">Unidades e idioma</span></div>
      <div class="field">
        <label for="set-units">Unidad de humedad</label>
        <select id="set-units">
          <option value="pct" selected>%</option>
          <option value="c" disabled>°C (Próximamente)</option>
        </select>
      </div>
      <div class="field mt">
        <label for="set-lang">Idioma</label>
        <select id="set-lang">
          <option value="es" selected>Español</option>
          <option value="en" disabled>English (Próximamente)</option>
        </select>
      </div>
    </div>

    <!-- 4) Información del dispositivo -->
    <div class="card">
      <div class="card__header"><span class="card__title">Información del dispositivo</span></div>
      <div class="kv"><span class="kv__k">Versión de la app</span><span class="kv__v">NIC MVP 1.0</span></div>
      <div class="kv"><span class="kv__k">Estado de la red</span><span class="kv__v" id="set-info-net">—</span></div>
      <div class="kv"><span class="kv__k">URL WebSocket</span><span class="kv__v small" id="set-info-wsurl">—</span></div>
      <div class="kv"><span class="kv__k">Última telemetría</span><span class="kv__v" id="set-info-telemetry">—</span></div>
      <div class="kv"><span class="kv__k">ID del ESP</span><span class="kv__v">—</span></div>
      <p class="soon-note">El identificador del ESP no está disponible en el MVP.</p>
    </div>

    <!-- 5) Restaurar -->
    <div class="card">
      <div class="btn-row">
        <button type="button" class="btn btn--ghost btn--block" id="set-reset">Restaurar valores por defecto</button>
      </div>
    </div>
  `;

  // --- Referencias a controles editables ---
  const hostInput = root.querySelector('#set-host');
  const testBtn = root.querySelector('#set-test');
  const saveBtn = root.querySelector('#set-save');
  const notifyCritical = root.querySelector('#set-notify-critical');
  const notifyConnection = root.querySelector('#set-notify-connection');
  const criticalPct = root.querySelector('#set-critical-pct');
  const resetBtn = root.querySelector('#set-reset');

  // 1) Conexión: probar conexión con el host escrito actualmente.
  testBtn.addEventListener('click', async () => {
    const host = hostInput.value.trim();
    testBtn.disabled = true;
    const prevText = testBtn.textContent;
    testBtn.textContent = 'Probando…';
    try {
      const ok = await ws.test(host);
      toast(ok ? 'Conexión correcta' : 'No se pudo conectar', { type: ok ? 'ok' : 'error' });
    } catch {
      toast('No se pudo conectar', { type: 'error' });
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = prevText;
    }
  });

  // 1) Conexión: guardar host y reconectar de inmediato.
  saveBtn.addEventListener('click', () => {
    const host = hostInput.value.trim();
    settings.patch({ host });
    ws.reconnectNow();
    toast('Configuración guardada', { type: 'ok' });
    render(root);
  });

  // 2) Notificaciones: toggles.
  notifyCritical.addEventListener('change', () => {
    settings.patch({ notify: { critical: notifyCritical.checked } });
  });
  notifyConnection.addEventListener('change', () => {
    settings.patch({ notify: { connection: notifyConnection.checked } });
  });

  // 2) Humedad crítica (%): se persiste al salir del campo, acotado a 0..100.
  criticalPct.addEventListener('change', () => {
    let v = Math.round(Number(criticalPct.value));
    if (!Number.isFinite(v)) v = settings.get().criticalPct;
    v = Math.max(0, Math.min(100, v));
    criticalPct.value = String(v);
    settings.patch({ criticalPct: v });
  });

  // 5) Restaurar valores por defecto (acción destructiva, pide confirmación).
  resetBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Restaurar ajustes',
      message: '¿Restaurar todos los ajustes a sus valores por defecto?',
      confirmText: 'Restaurar',
      cancelText: 'Cancelar',
      danger: true,
    });
    if (!ok) return;
    settings.reset();
    toast('Ajustes restaurados', { type: 'ok' });
    if (!mounted) return; // se navegó fuera mientras el diálogo estaba abierto
    syncInputs(root);
    render(root);
  });

  // Suscripción al store para reflejar el estado de red en vivo.
  unsub = store.subscribe(() => render(root));
  syncInputs(root);
  render(root);
}

export function unmount() {
  mounted = false;
  if (unsub) { unsub(); unsub = null; }
}

/**
 * Vuelca los valores actuales de settings en los inputs.
 * Se llama al montar y tras restaurar, no en cada render (para no pisar
 * lo que el usuario está escribiendo cuando cambia el estado de red).
 */
function syncInputs(root) {
  const cfg = settings.get();
  root.querySelector('#set-host').value = cfg.host || '';
  root.querySelector('#set-notify-critical').checked = !!cfg.notify.critical;
  root.querySelector('#set-notify-connection').checked = !!cfg.notify.connection;
  root.querySelector('#set-critical-pct').value = String(cfg.criticalPct);
}

/** Texto en español para el estado de conexión del store. */
function connectionText(state) {
  switch (state.connection) {
    case CONN.CONNECTED:
      return state.link === LINK.LOST ? 'Conectado (enlace con el riego perdido)' : 'Conectado';
    case CONN.CONNECTING:
      return 'Conectando…';
    case CONN.RECONNECTING:
      return 'Reconectando…';
    case CONN.DISCONNECTED:
      return 'Sin conexión';
    default:
      return 'Desconocido';
  }
}

function render(root) {
  const state = store.getState();
  const url = settings.wsUrl();

  // 1) URL WebSocket efectiva (bajo los botones de conexión).
  const wsUrlEl = root.querySelector('#set-wsurl');
  if (wsUrlEl) wsUrlEl.textContent = url;

  // 4) Información del dispositivo.
  const netEl = root.querySelector('#set-info-net');
  if (netEl) netEl.textContent = connectionText(state);

  const infoUrlEl = root.querySelector('#set-info-wsurl');
  if (infoUrlEl) infoUrlEl.textContent = url;

  const telEl = root.querySelector('#set-info-telemetry');
  if (telEl) telEl.textContent = state.lastTelemetryTs ? fmtTime(state.lastTelemetryTs) : '—';
}

/** Hora local legible (hh:mm:ss). */
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}
