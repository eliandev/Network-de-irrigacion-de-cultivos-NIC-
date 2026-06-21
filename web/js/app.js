/**
 * NIC — Bootstrap de la aplicacion y router.
 * Inicializa el nucleo (store, ws, alertas, historial), registra el service
 * worker, gestiona el shell (pill de conexion + banner) y la navegacion por
 * pestañas con montaje/desmontaje de pantallas.
 */

import { store } from './store.js';
import { ws } from './ws-client.js';
import { settings } from './settings.js';
import { alerts } from './alerts.js';
import { history } from './history.js';
import { weather } from './weather.js';
import { toast } from './ui.js';
import { CONN, LINK } from './protocol.js';

import * as dashboard from './screens/dashboard.js';
import * as monitoreo from './screens/monitoreo.js';
import * as control from './screens/control.js';
import * as alertasScreen from './screens/alertas.js';
import * as ajustes from './screens/ajustes.js';

const ROUTES = {
  inicio: { mod: dashboard, title: 'Inicio' },
  monitoreo: { mod: monitoreo, title: 'Monitoreo' },
  control: { mod: control, title: 'Control' },
  alertas: { mod: alertasScreen, title: 'Alertas' },
  ajustes: { mod: ajustes, title: 'Ajustes' },
};
const DEFAULT_ROUTE = 'inicio';

let currentMod = null;
let viewEl = null;

// --- Router -----------------------------------------------------------------

function routeName() {
  const hash = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES[hash] ? hash : DEFAULT_ROUTE;
}

function navigate() {
  const name = routeName();
  const route = ROUTES[name];

  if (currentMod && typeof currentMod.unmount === 'function') {
    try { currentMod.unmount(); } catch (e) { console.error(e); }
  }
  viewEl.innerHTML = '';
  viewEl.scrollTop = 0;
  currentMod = route.mod;
  try {
    route.mod.mount(viewEl);
  } catch (e) {
    console.error('[router] error al montar', name, e);
    viewEl.innerHTML = '<div class="card"><p>Ocurrió un error al cargar esta pantalla.</p></div>';
  }
  updateNavActive(name);
  document.title = `NIC — ${route.title}`;
}

function updateNavActive(name) {
  document.querySelectorAll('[data-route]').forEach((btn) => {
    const active = btn.dataset.route === name;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

// --- Shell: pill de conexion + banner --------------------------------------

function connDescriptor(state) {
  switch (state.connection) {
    case CONN.CONNECTED:
      return state.link === LINK.LOST
        ? { label: 'Sin enlace Arduino', mod: 'warn', dot: 'warn' }
        : { label: 'Conectado', mod: 'ok', dot: 'ok' };
    case CONN.CONNECTING:
      return { label: 'Conectando…', mod: 'warn', dot: 'warn' };
    case CONN.RECONNECTING:
      return { label: 'Reconectando…', mod: 'warn', dot: 'warn' };
    case CONN.DISCONNECTED:
    default:
      return { label: 'Sin conexión', mod: 'error', dot: 'error' };
  }
}

function renderShell(state) {
  const pill = document.getElementById('conn-pill');
  if (pill) {
    const d = connDescriptor(state);
    pill.className = `conn-pill conn-pill--${d.mod}`;
    pill.innerHTML = `<span class="dot dot--${d.dot}" aria-hidden="true"></span><span>${d.label}</span>`;
  }

  // Indicador de modo demostración (datos simulados en el navegador).
  const demoBadge = document.getElementById('demo-badge');
  if (demoBadge) demoBadge.hidden = !state.demo;

  const banner = document.getElementById('offline-banner');
  if (banner) {
    if (state.connection === CONN.DISCONNECTED) {
      banner.hidden = false;
      banner.dataset.kind = 'down';
      banner.querySelector('.banner__text').textContent = 'Sin conexión con el dispositivo NIC.';
      banner.querySelector('.banner__action').hidden = false;
    } else if (state.connection === CONN.RECONNECTING) {
      banner.hidden = false;
      banner.dataset.kind = 'reconnecting';
      const n = state.reconnectAttempts || 1;
      banner.querySelector('.banner__text').textContent = `Reconectando… (intento ${n})`;
      banner.querySelector('.banner__action').hidden = true;
    } else {
      banner.hidden = true;
    }
  }

  // Badge de alertas sin leer en la pestaña Alertas.
  const unread = state.alerts.filter((a) => !a.read).length;
  const badge = document.getElementById('alerts-badge');
  if (badge) {
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
  }
}

// --- Historial: registrar cada telemetria ----------------------------------

let lastTs = 0;
function recordHistory(state) {
  const t = state.telemetry;
  if (t && t.ts !== lastTs) {
    lastTs = t.ts;
    history.record(t.pct, t.raw);
  }
}

// --- Service worker (PWA) ---------------------------------------------------

function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch((err) => {
        console.warn('[pwa] SW no registrado', err);
      });
    });
  }
}

// --- Arranque ---------------------------------------------------------------

function boot() {
  viewEl = document.getElementById('view');

  // Suscripciones de shell e historial.
  store.subscribe(renderShell);
  store.subscribe(recordHistory);

  // Errores del WS -> toast (sin saturar ni duplicar).
  ws.onError((err) => {
    // ACK_TIMEOUT lo maneja la pantalla que envió el comando (evita doble toast);
    // WS_ERROR es ruido (le sigue un onclose con su propio manejo).
    if (err.code === 'ACK_TIMEOUT' || err.code === 'WS_ERROR') return;
    if (err.code === 'MAX_RETRIES') {
      toast('No se pudo reconectar. Reintenta manualmente.', { type: 'error', duration: 5000 });
      return;
    }
    // Errores originados en el dispositivo (p. ej. ARDUINO_TIMEOUT, BAD_VALUE).
    if (err.message) toast(err.message, { type: 'error' });
  });

  // Alertas + reconexion del banner.
  alerts.init();

  // Clima por ubicacion (Internet, opcional; no bloquea el resto de la app).
  weather.init();
  const retryBtn = document.querySelector('#offline-banner .banner__action');
  if (retryBtn) retryBtn.addEventListener('click', () => ws.retry());

  // Navegacion por pestañas (delegada + hashchange).
  document.querySelectorAll('[data-route]').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.route}`; });
  });
  window.addEventListener('hashchange', navigate);

  // Reaplicar idioma/lang.
  document.documentElement.lang = settings.get().lang || 'es';

  // Estado inicial del shell + primera pantalla + conexion.
  renderShell(store.getState());
  navigate();
  ws.connect();

  registerSW();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Exponer para depuracion en consola.
window.NIC = { store, ws, settings, alerts, history, weather };
