/**
 * NIC — Pantalla Inicio (Dashboard).
 * Responde de un vistazo: "¿está todo bien?" (PRD 7.1).
 *
 * Contrato de pantalla (lo siguen todas las pantallas):
 *   export function mount(root)  -> construye el DOM y se suscribe al store
 *   export function unmount()    -> limpia suscripciones y temporizadores
 */

import { store } from '../store.js';
import { settings } from '../settings.js';
import {
  CONN, LINK, PUMP, MODE,
  humidityStatus, HUMIDITY_LABEL,
} from '../protocol.js';
import { escapeHtml } from '../ui.js';

let unsub = null;

export function mount(root) {
  root.innerHTML = `
    <h1 class="screen-title">Inicio</h1>
    <div id="dash-hero"></div>

    <div class="card">
      <div class="card__header"><span class="card__title">Humedad del suelo</span><span id="dash-hum-chip"></span></div>
      <div id="dash-gauge"></div>
    </div>

    <div class="card">
      <div class="card__header"><span class="card__title">Estado del riego</span></div>
      <div id="dash-riego"></div>
      <div class="btn-row mt">
        <button type="button" class="btn btn--primary btn--block" id="dash-manual">💧 Riego manual</button>
      </div>
    </div>

    <div class="grid-2">
      ${soonCard('💦', 'Nivel de agua')}
      ${soonCard('🌤️', 'Clima')}
    </div>
    <div class="card is-soon">
      <div class="card__header"><span class="card__title">Próximo riego</span><span class="badge-soon">Próximamente</span></div>
      <p class="soon-note">La programación de horarios llegará en una próxima fase.</p>
    </div>

    <div class="card">
      <div class="card__header"><span class="card__title">Alertas recientes</span>
        <button type="button" class="btn btn--small btn--ghost" id="dash-go-alerts">Ver todas</button>
      </div>
      <div id="dash-alerts"></div>
    </div>
  `;

  root.querySelector('#dash-manual').addEventListener('click', () => { location.hash = '#/control'; });
  root.querySelector('#dash-go-alerts').addEventListener('click', () => { location.hash = '#/alertas'; });

  unsub = store.subscribe(() => render(root));
  render(root);
}

export function unmount() {
  if (unsub) { unsub(); unsub = null; }
}

function soonCard(icon, title) {
  return `
    <div class="card is-soon">
      <div class="card__header"><span class="card__title">${icon} ${escapeHtml(title)}</span></div>
      <span class="badge-soon">Próximamente</span>
    </div>`;
}

function systemState(state) {
  if (state.connection === CONN.DISCONNECTED || (state.connection === CONN.CONNECTED && state.link === LINK.LOST)) {
    return { badge: 'ERROR', mod: 'error', text: 'Sistema con problemas de conexión' };
  }
  if (state.connection === CONN.CONNECTED && state.telemetry) {
    return { badge: 'ACTIVO', mod: 'ok', text: 'El sistema está operando con normalidad' };
  }
  return { badge: 'EN ESPERA', mod: 'warn', text: 'Conectando con el dispositivo…' };
}

function render(root) {
  const state = store.getState();
  const cfg = settings.get();
  const t = state.telemetry;
  const connected = state.connection === CONN.CONNECTED;

  // --- Hero: estado del sistema ---
  const sys = systemState(state);
  const heroEl = root.querySelector('#dash-hero');
  heroEl.innerHTML = `
    <div class="card hero">
      <div class="hero__state">
        <span class="hero__badge">${sys.badge}</span>
      </div>
      <div class="hero__big">${sys.text}</div>
      <div class="hero__row">
        <div class="hero__metric"><b>${t ? t.pct + '%' : '—'}</b><span>Humedad</span></div>
        <div class="hero__metric"><b>${t ? (t.pump === PUMP.ON ? 'Encendida' : 'Apagada') : '—'}</b><span>Bomba</span></div>
        <div class="hero__metric"><b>${t ? (t.mode === MODE.AUTO ? 'Automático' : 'Manual') : '—'}</b><span>Modo</span></div>
      </div>
    </div>`;

  // --- Humedad: gauge + chip de estado ---
  const gaugeEl = root.querySelector('#dash-gauge');
  const chipEl = root.querySelector('#dash-hum-chip');
  if (t) {
    const st = humidityStatus(t.pct, cfg.criticalPct, t.threshold);
    const ring = st === 'critico' ? 'var(--error)' : st === 'bajo' ? 'var(--warn)' : 'var(--brand-green)';
    const chipMod = st === 'critico' ? 'error' : st === 'bajo' ? 'warn' : 'ok';
    chipEl.innerHTML = `<span class="chip chip--${chipMod}">${HUMIDITY_LABEL[st]}</span>`;
    gaugeEl.innerHTML = `
      <div class="gauge" style="--pct:${t.pct}; --ring-color:${ring};">
        <div class="gauge__inner">
          <div><span class="gauge__value">${t.pct}</span><span class="gauge__unit">%</span></div>
          <div class="gauge__label">ADC ${t.raw} / 1023</div>
        </div>
      </div>`;
  } else {
    chipEl.innerHTML = '';
    gaugeEl.innerHTML = `<p class="empty-state">Esperando lectura del sensor…</p>`;
  }

  // --- Estado del riego ---
  const riegoEl = root.querySelector('#dash-riego');
  if (t) {
    const pumpChip = t.pump === PUMP.ON
      ? '<span class="chip chip--ok"><span aria-hidden="true">●</span> Encendida</span>'
      : '<span class="chip"><span aria-hidden="true">○</span> Apagada</span>';
    const modeChip = t.mode === MODE.AUTO
      ? '<span class="chip chip--info">Automático</span>'
      : '<span class="chip chip--warn">Manual</span>';
    riegoEl.innerHTML = `
      <div class="kv"><span class="kv__k">Bomba</span><span class="kv__v">${pumpChip}</span></div>
      <div class="kv"><span class="kv__k">Modo</span><span class="kv__v">${modeChip}</span></div>
      ${t.manualRemaining > 0
        ? `<div class="kv"><span class="kv__k">Riego manual restante</span><span class="kv__v">${fmtMMSS(t.manualRemaining)}</span></div>`
        : ''}`;
  } else {
    riegoEl.innerHTML = `<p class="empty-state">Sin datos del riego.</p>`;
  }

  // --- Alertas recientes ---
  const alertsEl = root.querySelector('#dash-alerts');
  const recent = state.alerts.slice(0, 3);
  if (recent.length === 0) {
    alertsEl.innerHTML = `<p class="empty-state">Sin alertas recientes 🎉</p>`;
  } else {
    alertsEl.innerHTML = `<div class="list">${recent.map(alertRow).join('')}</div>`;
  }

  // Atenuar contenido si no hay conexion (ultimo valor conocido).
  root.querySelectorAll('.card:not(.hero)').forEach((c) => {
    c.style.opacity = (!connected && t) ? '0.6' : '';
  });

  // El acceso directo a riego manual no debe invitar a actuar sin conexion.
  const manualBtn = root.querySelector('#dash-manual');
  if (manualBtn) {
    manualBtn.disabled = !connected;
    manualBtn.setAttribute('aria-disabled', !connected ? 'true' : 'false');
  }
}

function alertRow(a) {
  const icon = a.severity === 'critico' ? '⛔' : '⚠️';
  return `
    <div class="alert-item alert-item--${a.severity}">
      <span class="alert-item__icon" aria-hidden="true">${icon}</span>
      <div class="alert-item__body">
        <div class="alert-item__title">${escapeHtml(a.title)}</div>
        <div class="alert-item__time">${fmtTime(a.ts)}</div>
      </div>
    </div>`;
}

function fmtMMSS(s) {
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}
function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
