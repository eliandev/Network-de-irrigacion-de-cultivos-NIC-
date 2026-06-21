/**
 * NIC — Pantalla Monitoreo.
 * Detalle de los datos del sensor: lectura en vivo, historial (sparkline)
 * y estado del enlace con el Arduino (PRD 7.2).
 *
 * Contrato de pantalla (igual que dashboard.js):
 *   export function mount(root)  -> construye el DOM y se suscribe al store
 *   export function unmount()    -> limpia suscripciones y temporizadores
 */

import { store } from '../store.js';
import { settings } from '../settings.js';
import {
  CONN, LINK,
  humidityStatus, HUMIDITY_LABEL,
} from '../protocol.js';
import { history } from '../history.js';
import { toast, escapeHtml } from '../ui.js';

let unsub = null;       // suscripcion al store
let timer = null;       // refresco periodico desde IndexedDB
let series = [];        // serie local de muestras { ts, pct, raw }
let lastTs = 0;         // ts (epoch ms) del ultimo punto agregado a la serie
let mounted = false;    // guard de vida: evita render() sobre un DOM ya desmontado

// Ventana de historial mostrada en la sparkline (1 hora) y refresco periodico.
const WINDOW_MS = 60 * 60 * 1000;
const REFRESH_MS = 15 * 1000;
const MAX_POINTS = 240;   // limite defensivo para la serie en memoria

export function mount(root) {
  mounted = true;
  root.innerHTML = `
    <h1 class="screen-title">Monitoreo</h1>
    <p class="screen-sub">Detalle de los datos del sensor de humedad.</p>

    <div class="card">
      <div class="card__header">
        <span class="card__title">Lectura en vivo</span>
        <span id="mon-hum-chip"></span>
      </div>
      <div id="mon-live"></div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__title">Historial de humedad</span>
        <span class="small muted">Última hora</span>
      </div>
      <div id="mon-chart"></div>
      <div id="mon-axis"></div>
      <div class="btn-row mt">
        <button type="button" class="btn btn--danger btn--small" id="mon-clear">Limpiar historial</button>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__title">Conexión con el Arduino</span>
        <span id="mon-conn-chip"></span>
      </div>
      <div id="mon-conn"></div>
    </div>
  `;

  // Boton: limpiar historial (IndexedDB + serie local).
  root.querySelector('#mon-clear').addEventListener('click', async () => {
    try {
      await history.clear();
      if (!mounted) return;            // la pantalla pudo desmontarse mientras tanto
      series = [];
      lastTs = 0;
      render(root);
      toast('Historial borrado.', { type: 'ok' });
    } catch (err) {
      console.warn('[monitoreo] no se pudo limpiar el historial', err);
    }
  });

  // Carga inicial del historial (async) y primer render.
  loadFromHistory(root);

  // Refresco periodico desde IndexedDB (se limpia en unmount).
  timer = setInterval(() => loadFromHistory(root), REFRESH_MS);

  // Suscripcion al store: ante telemetria nueva, agregamos punto y redibujamos.
  unsub = store.subscribe(() => {
    appendFromTelemetry();
    render(root);
  });

  render(root);
}

export function unmount() {
  mounted = false;
  if (unsub) { unsub(); unsub = null; }
  if (timer) { clearInterval(timer); timer = null; }
  series = [];
  lastTs = 0;
}

/** Lee las muestras recientes de IndexedDB y reemplaza la serie local. */
async function loadFromHistory(root) {
  try {
    const rows = await history.recent(WINDOW_MS);
    if (!mounted) return;              // resolvió tras unmount: no toques el DOM
    // history.recent() ya devuelve ordenado por ts (keyPath asc).
    series = (rows || []).slice(-MAX_POINTS);
    lastTs = series.length ? series[series.length - 1].ts : 0;
    render(root);
  } catch (err) {
    console.warn('[monitoreo] no se pudo leer el historial', err);
  }
}

/** Agrega a la serie local el ultimo punto de telemetria si es nuevo. */
function appendFromTelemetry() {
  const t = store.getState().telemetry;
  if (!t) return;
  // La telemetria trae ts en segundos; lo normalizamos a ms para comparar.
  const tsMs = t.ts ? t.ts * 1000 : Date.now();
  if (tsMs <= lastTs) return;   // evita duplicados al re-renderizar
  series.push({ ts: tsMs, pct: t.pct, raw: t.raw });
  if (series.length > MAX_POINTS) series = series.slice(-MAX_POINTS);
  lastTs = tsMs;
}

/** Deriva el estado del enlace con el Arduino a partir de connection + link. */
function connState(state) {
  switch (state.connection) {
    case CONN.CONNECTED:
      // El WebSocket vive, pero el enlace serial ESP<->Arduino puede estar caido.
      if (state.link === LINK.LOST) {
        return { mod: 'error', label: 'Error de enlace', text: 'Error de enlace con el Arduino' };
      }
      return { mod: 'ok', label: 'Conectado', text: 'Conectado con el Arduino' };
    case CONN.RECONNECTING:
      return { mod: 'warn', label: 'Reconectando', text: 'Reconectando con el dispositivo…' };
    case CONN.CONNECTING:
      return { mod: 'warn', label: 'Conectando', text: 'Estableciendo conexión…' };
    case CONN.DISCONNECTED:
    default:
      return { mod: 'error', label: 'Sin conexión', text: 'Sin conexión con el dispositivo' };
  }
}

function render(root) {
  const state = store.getState();
  const cfg = settings.get();
  const t = state.telemetry;
  const connected = state.connection === CONN.CONNECTED;

  // --- Lectura en vivo: stat grande de humedad + ADC crudo + chip de estado ---
  const liveEl = root.querySelector('#mon-live');
  const chipEl = root.querySelector('#mon-hum-chip');
  if (t) {
    const st = humidityStatus(t.pct, cfg.criticalPct, t.threshold);
    const chipMod = st === 'critico' ? 'error' : st === 'bajo' ? 'warn' : 'ok';
    chipEl.innerHTML = `<span class="chip chip--${chipMod}">${escapeHtml(HUMIDITY_LABEL[st])}</span>`;
    liveEl.innerHTML = `
      <div class="stat">
        <span class="stat__value">${t.pct}%</span>
        <span class="stat__label">Humedad del suelo</span>
      </div>
      <div class="kv mt"><span class="kv__k">ADC crudo</span><span class="kv__v">${t.raw} / 1023</span></div>`;
  } else {
    chipEl.innerHTML = '';
    liveEl.innerHTML = `<p class="empty-state">Esperando lectura del sensor…</p>`;
  }

  // --- Historial: sparkline SVG + ejes minimos ---
  const chartEl = root.querySelector('#mon-chart');
  const axisEl = root.querySelector('#mon-axis');
  chartEl.innerHTML = sparkSvg(series);
  axisEl.innerHTML = axisLabels(series);

  // --- Estado de conexion con el Arduino ---
  const conn = connState(state);
  const connChipEl = root.querySelector('#mon-conn-chip');
  const connEl = root.querySelector('#mon-conn');
  // No comunicamos el estado solo por color: incluimos texto e icono.
  const icon = conn.mod === 'ok' ? '●' : conn.mod === 'warn' ? '◐' : '○';
  connChipEl.innerHTML = `<span class="chip chip--${conn.mod}"><span aria-hidden="true">${icon}</span> ${escapeHtml(conn.label)}</span>`;
  connEl.innerHTML = `
    <div class="kv"><span class="kv__k">Estado</span><span class="kv__v">${escapeHtml(conn.text)}</span></div>
    ${state.reconnectAttempts > 0
      ? `<div class="kv"><span class="kv__k">Intentos de reconexión</span><span class="kv__v">${state.reconnectAttempts}</span></div>`
      : ''}
    ${state.lastTelemetryTs > 0
      ? `<div class="kv"><span class="kv__k">Última lectura</span><span class="kv__v">${fmtTime(state.lastTelemetryTs)}</span></div>`
      : ''}`;

  // Atenuar contenido si no hay conexion (ultimo valor conocido).
  if (liveEl.closest('.card')) {
    liveEl.closest('.card').style.opacity = (!connected && t) ? '0.6' : '';
  }
}

/**
 * Genera una sparkline SVG inline con el % de humedad de la serie.
 * Responsiva via viewBox; maneja 0, 1 o N puntos sin romper.
 */
function sparkSvg(pts) {
  if (!pts || pts.length === 0) {
    return `<p class="empty-state">Aún no hay lecturas registradas.</p>`;
  }

  // Lienzo en coordenadas del viewBox (la clase .spark fija width:100%).
  const W = 300;
  const H = 120;
  const padX = 4;
  const padY = 8;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;

  // El eje Y representa humedad fija 0..100% para una lectura estable.
  const yFor = (pct) => {
    const clamped = Math.max(0, Math.min(100, pct));
    return padY + innerH * (1 - clamped / 100);
  };

  // Con un solo punto dibujamos una marca centrada; con N, una polilinea.
  let body;
  if (pts.length === 1) {
    const y = yFor(pts[0].pct);
    body = `<circle cx="${(W / 2).toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="var(--brand-blue)"></circle>`;
  } else {
    const stepX = innerW / (pts.length - 1);
    const coords = pts.map((p, i) => `${(padX + i * stepX).toFixed(1)},${yFor(p.pct).toFixed(1)}`);
    const line = coords.join(' ');
    // Area de relleno: bajamos al borde inferior y cerramos.
    const area = `${padX.toFixed(1)},${(H - padY).toFixed(1)} ${line} ${(W - padX).toFixed(1)},${(H - padY).toFixed(1)}`;
    const last = pts[pts.length - 1];
    body = `
      <polygon points="${area}" fill="var(--brand-blue)" fill-opacity="0.12"></polygon>
      <polyline points="${line}" fill="none" stroke="var(--brand-blue)" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round"></polyline>
      <circle cx="${(W - padX).toFixed(1)}" cy="${yFor(last.pct).toFixed(1)}" r="3" fill="var(--brand-blue)"></circle>`;
  }

  return `
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
         role="img" aria-label="Gráfica de humedad de las últimas lecturas">
      ${body}
    </svg>`;
}

/** Etiquetas minimas debajo de la grafica: min / max / ultima. */
function axisLabels(pts) {
  if (!pts || pts.length === 0) return '';
  const vals = pts.map((p) => p.pct);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const last = vals[vals.length - 1];
  return `
    <div class="kv"><span class="kv__k">Mínimo</span><span class="kv__v">${min}%</span></div>
    <div class="kv"><span class="kv__k">Máximo</span><span class="kv__v">${max}%</span></div>
    <div class="kv"><span class="kv__k">Última</span><span class="kv__v">${last}%</span></div>`;
}

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
