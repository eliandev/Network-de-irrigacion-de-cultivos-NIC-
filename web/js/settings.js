/**
 * NIC — Preferencias del usuario, persistidas en localStorage.
 * Conexion (host/IP), notificaciones, unidades, idioma, humedad critica, etc.
 */

import { DEFAULT_CRITICAL_PCT, DEFAULT_MANUAL_MIN } from './protocol.js';

const KEY = 'nic.settings.v1';

const DEFAULTS = Object.freeze({
  host: '',                 // host/IP manual; vacio => usar el origen actual (location.host)
  notify: { critical: true, connection: true },
  units: 'pct',             // 'pct' (futuro: 'c' para temperatura)
  lang: 'es',
  criticalPct: DEFAULT_CRITICAL_PCT,
  manualDefaultMin: DEFAULT_MANUAL_MIN,
  // Origen de los datos: 'auto' (real en LAN, demo fuera), 'on' (siempre demo), 'off' (siempre real).
  demoMode: 'auto',
  // Clima por ubicacion (Open-Meteo). Requiere Internet; opcional.
  weather: {
    enabled: false,
    source: '',             // 'geo' | 'manual' (informativo)
    lat: null,
    lon: null,
    label: '',              // etiqueta legible de la ubicacion
  },
});

const listeners = new Set();
let current = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      notify: { ...DEFAULTS.notify, ...(parsed.notify || {}) },
      weather: { ...DEFAULTS.weather, ...(parsed.weather || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(current)); }
  catch (err) { console.warn('[settings] no se pudo guardar', err); }
  for (const fn of listeners) {
    try { fn(current); } catch (e) { console.error(e); }
  }
}

export const settings = {
  get() { return current; },

  /** Mezcla y persiste un patch de preferencias (mezcla profunda en notify y weather). */
  patch(p) {
    current = {
      ...current,
      ...p,
      notify: { ...current.notify, ...(p.notify || {}) },
      weather: { ...current.weather, ...(p.weather || {}) },
    };
    persist();
    return current;
  },

  reset() {
    current = structuredClone(DEFAULTS);
    persist();
    return current;
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * Construye la URL del WebSocket.
   * Si hay host manual configurado se usa; si no, el origen actual
   * (asi la PWA servida desde el ESP apunta al propio ESP).
   */
  wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = (current.host || '').trim();
    if (host) {
      // Permitir que el usuario escriba "riego.local", "192.168.1.50" o con puerto.
      const clean = host.replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
      return `${proto}//${clean}/ws`;
    }
    return `${proto}//${location.host}/ws`;
  },
};
