/**
 * NIC — Historial de riegos (cliente).
 * Detecta cada riego observando las transiciones de la bomba en la telemetría
 * (ON -> OFF), estima el agua usada a partir del caudal configurado y persiste
 * los eventos en localStorage. Actualiza store.irrigation y notifica al regar.
 *
 * Funciona con el firmware actual (no requiere que el dispositivo lleve la
 * cuenta): "la app analiza la información", como plantea el informe.
 */

import { store } from './store.js';
import { settings } from './settings.js';
import { PUMP } from './protocol.js';

const KEY = 'nic.waterings.v1';
const MAX = 200;

let prevPump = null;   // ultimo estado de bomba observado
let startTs = 0;       // inicio del riego en curso
let startPct = null;   // humedad al iniciar

let summary = { count: 0, totalMl: 0, last: null, events: [] };

function recompute(events) {
  summary.events = events.slice(-MAX);
  summary.count = summary.events.length;
  summary.totalMl = summary.events.reduce((a, e) => a + (e.ml || 0), 0);
  summary.last = summary.events[summary.events.length - 1] || null;
  store.set({ irrigation: { ...summary } });
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(summary.events)); }
  catch (e) { console.warn('[irrigation] no se pudo guardar', e); }
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    recompute(raw ? JSON.parse(raw) : []);
  } catch { recompute([]); }
}

function notify(title, body) {
  try {
    if (('Notification' in window) && Notification.permission === 'granted') {
      // eslint-disable-next-line no-new
      new Notification(title, { body, tag: 'nic-riego', icon: 'assets/logo.svg' });
    }
  } catch { /* noop */ }
}

function fmtDur(s) {
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function onChange() {
  const t = store.getState().telemetry;
  if (!t) return;
  const pump = t.pump;

  // Primera observación: fija la referencia sin registrar nada.
  if (prevPump === null) {
    prevPump = pump;
    if (pump === PUMP.ON) { startTs = Date.now(); startPct = t.pct; }
    return;
  }

  // Sin transición de bomba -> nada. Importante para no re-procesar cuando
  // recompute() dispara store.set (evita recursión) ni en cambios ajenos.
  if (pump === prevPump) return;

  const wasOn = prevPump === PUMP.ON;
  prevPump = pump; // actualizar ANTES de cualquier store.set

  if (!wasOn && pump === PUMP.ON) {
    // Flanco de subida: comienza un riego.
    startTs = Date.now();
    startPct = t.pct;
  } else if (wasOn && pump !== PUMP.ON) {
    // Flanco de bajada: termina el riego -> registramos el evento.
    const endTs = Date.now();
    const durS = Math.max(1, Math.round((endTs - startTs) / 1000));
    const flow = settings.get().pumpFlowMlMin || 400;
    const ml = Math.round((durS / 60) * flow);
    const evt = {
      ts: endTs, durS, ml,
      pctBefore: startPct, pctAfter: t.pct, mode: t.mode,
    };
    recompute([...summary.events, evt]);
    persist();

    if (settings.get().notify.watering) {
      const before = startPct == null ? '—' : `${startPct}%`;
      const delta = startPct == null ? '' : ` (${t.pct - startPct >= 0 ? '+' : ''}${t.pct - startPct}%)`;
      notify('Riego realizado', `Duró ${fmtDur(durS)} · humedad ${before} → ${t.pct}%${delta} · ~${ml} ml`);
    }
    startPct = null;
  }
}

export const irrigation = {
  /** Carga el historial y empieza a observar los cambios de la bomba. */
  init() {
    load();
    store.subscribe(onChange);
  },

  getSummary() { return summary; },

  /** Borra todo el historial de riegos. */
  clear() {
    recompute([]);
    persist();
  },
};
