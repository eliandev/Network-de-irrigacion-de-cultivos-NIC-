/**
 * NIC — Clima por ubicación (Open-Meteo, sin API key).
 * ---------------------------------------------------------------------------
 * Obtiene el clima actual según la ubicación del usuario:
 *   - GPS del navegador (navigator.geolocation) — requiere CONTEXTO SEGURO
 *     (https:// o localhost). Servida desde el ESP por http:// quedará bloqueada.
 *   - Respaldo: ubicación manual por nombre de ciudad (geocodificación) o
 *     coordenadas, que SIEMPRE funciona.
 *
 * APIs (gratuitas, sin clave, con CORS):
 *   - Clima:        https://api.open-meteo.com/v1/forecast
 *   - Geocodificación: https://geocoding-api.open-meteo.com/v1/search
 *
 * Nota: requiere Internet. El resto de la app funciona solo en la red local;
 * esta es la única función que sale a Internet.
 */

import { settings } from './settings.js';

const CACHE_KEY = 'nic.weather.cache.v1';
const REFRESH_MS = 15 * 60 * 1000;   // refresco automático cada 15 min

// Estado interno + suscriptores (patrón igual a settings.js / store.js).
let state = {
  status: 'idle',   // 'idle' | 'no-location' | 'loading' | 'ready' | 'error'
  data: null,       // { tempC, feelsC, humidity, windKmh, code, desc, icon, label, time }
  error: null,
  fetchedAt: 0,
};
const listeners = new Set();
let refreshTimer = null;

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error('[weather] subscriber', e); }
  }
}

// --- Mapa de códigos WMO -> descripción (es) + nombre de ícono outlined -----
// El campo "icon" es la CLAVE de un ícono SVG (ver icons.js), no un emoji.
const WMO = {
  0: { desc: 'Despejado', icon: 'sun' },
  1: { desc: 'Mayormente despejado', icon: 'cloud-sun' },
  2: { desc: 'Parcialmente nublado', icon: 'cloud-sun' },
  3: { desc: 'Nublado', icon: 'cloud' },
  45: { desc: 'Niebla', icon: 'cloud-fog' },
  48: { desc: 'Niebla con escarcha', icon: 'cloud-fog' },
  51: { desc: 'Llovizna ligera', icon: 'cloud-drizzle' },
  53: { desc: 'Llovizna', icon: 'cloud-drizzle' },
  55: { desc: 'Llovizna intensa', icon: 'cloud-drizzle' },
  56: { desc: 'Llovizna helada', icon: 'cloud-drizzle' },
  57: { desc: 'Llovizna helada intensa', icon: 'cloud-drizzle' },
  61: { desc: 'Lluvia ligera', icon: 'cloud-rain' },
  63: { desc: 'Lluvia', icon: 'cloud-rain' },
  65: { desc: 'Lluvia intensa', icon: 'cloud-rain' },
  66: { desc: 'Lluvia helada', icon: 'cloud-rain' },
  67: { desc: 'Lluvia helada intensa', icon: 'cloud-rain' },
  71: { desc: 'Nieve ligera', icon: 'cloud-snow' },
  73: { desc: 'Nieve', icon: 'cloud-snow' },
  75: { desc: 'Nieve intensa', icon: 'cloud-snow' },
  77: { desc: 'Granos de nieve', icon: 'cloud-snow' },
  80: { desc: 'Chubascos ligeros', icon: 'cloud-rain' },
  81: { desc: 'Chubascos', icon: 'cloud-rain' },
  82: { desc: 'Chubascos violentos', icon: 'cloud-lightning' },
  85: { desc: 'Chubascos de nieve', icon: 'cloud-snow' },
  86: { desc: 'Chubascos de nieve intensos', icon: 'cloud-snow' },
  95: { desc: 'Tormenta', icon: 'cloud-lightning' },
  96: { desc: 'Tormenta con granizo', icon: 'cloud-lightning' },
  99: { desc: 'Tormenta con granizo intenso', icon: 'cloud-lightning' },
};
function describe(code) {
  return WMO[code] || { desc: 'Condición desconocida', icon: 'thermometer' };
}

// --- Caché en localStorage --------------------------------------------------
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveCache(payload) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch { /* noop */ }
}

// --- Llamadas de red --------------------------------------------------------

/** Geolocaliza con el GPS del navegador (requiere contexto seguro). */
function geolocate() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('GEO_UNSUPPORTED')); return; }
    if (!window.isSecureContext) { reject(new Error('GEO_INSECURE')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { timeout: 10000, maximumAge: 10 * 60 * 1000, enableHighAccuracy: false }
    );
  });
}

/**
 * Geocodificación inversa: coordenadas -> nombre de lugar legible.
 * Usa BigDataCloud (gratis, sin API key, con CORS). Best-effort: si falla,
 * el llamador conserva una etiqueta genérica.
 * @returns {Promise<string>} p. ej. "San Salvador, El Salvador" (o '' si no hay)
 */
async function reverseGeocode(lat, lon) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=es`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('REVGEO_HTTP_' + res.status);
    const j = await res.json();
    const place = j.city || j.locality || j.principalSubdivision || '';
    return [place, j.countryName].filter(Boolean).join(', ');
  } finally {
    clearTimeout(timer);
  }
}

/** Busca una ciudad por nombre -> { lat, lon, label }. */
async function geocode(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=es&format=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('GEOCODE_HTTP_' + res.status);
  const j = await res.json();
  if (!j.results || !j.results.length) throw new Error('NOT_FOUND');
  const r = j.results[0];
  const label = [r.name, r.admin1, r.country].filter(Boolean).slice(0, 2).join(', ');
  return { lat: r.latitude, lon: r.longitude, label };
}

/** Obtiene el clima actual para unas coordenadas. */
async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m'
    + '&timezone=auto';
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('WEATHER_HTTP_' + res.status);
  const j = await res.json();
  const c = j.current || {};
  const w = describe(c.weather_code);
  return {
    tempC: Math.round(c.temperature_2m),
    feelsC: Math.round(c.apparent_temperature),
    humidity: Math.round(c.relative_humidity_2m),
    windKmh: Math.round(c.wind_speed_10m),
    code: c.weather_code,
    desc: w.desc,
    icon: w.icon,
    time: c.time,
  };
}

// --- Mensajes legibles ------------------------------------------------------
function geoErrorMessage(err) {
  const code = err && (err.message || err.code);
  if (code === 'GEO_UNSUPPORTED') return 'Tu navegador no soporta geolocalización.';
  if (code === 'GEO_INSECURE') return 'El GPS requiere https o localhost. Escribe tu ciudad como alternativa.';
  if (err && err.code === 1) return 'Permiso de ubicación denegado. Escribe tu ciudad como alternativa.';
  if (err && err.code === 2) return 'No se pudo determinar tu ubicación.';
  if (err && err.code === 3) return 'La ubicación tardó demasiado.';
  return 'No se pudo obtener tu ubicación.';
}

// --- API pública ------------------------------------------------------------
export const weather = {
  getState() { return state; },

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /** Inicializa: carga caché y, si está habilitado, refresca y programa el timer. */
  init() {
    const cache = loadCache();
    if (cache && cache.data) { state.data = cache.data; state.fetchedAt = cache.fetchedAt || 0; }

    const cfg = settings.get().weather || {};
    if (cfg.enabled && cfg.lat != null && cfg.lon != null) {
      setState({ status: state.data ? 'ready' : 'loading' });
      if (!state.fetchedAt || Date.now() - state.fetchedAt > REFRESH_MS) this.refresh();
      this._startTimer();
    } else if (cfg.enabled) {
      setState({ status: 'no-location' });
    } else {
      setState({ status: 'idle' });
    }
  },

  /** Refresca el clima usando la ubicación guardada. */
  async refresh() {
    const cfg = settings.get().weather || {};
    if (!cfg.enabled) { setState({ status: 'idle' }); return; }
    if (cfg.lat == null || cfg.lon == null) { setState({ status: 'no-location' }); return; }

    setState({ status: 'loading', error: null });
    try {
      const data = await fetchWeather(cfg.lat, cfg.lon);
      data.label = cfg.label || 'Mi ubicación';
      saveCache({ data, fetchedAt: Date.now() });
      setState({ status: 'ready', data, fetchedAt: Date.now(), error: null });
    } catch (err) {
      console.warn('[weather] fallo al obtener el clima', err);
      // Conservamos el último dato (si existe) y marcamos error de actualización.
      setState({ status: 'error', error: 'No se pudo obtener el clima. ¿Hay Internet?' });
    }
  },

  /** Usa el GPS del navegador, resuelve la ciudad, guarda la ubicación y refresca. */
  async useMyLocation() {
    try {
      const { lat, lon } = await geolocate();
      // Best-effort: traducir las coordenadas a un nombre de ciudad legible.
      let label = 'Mi ubicación';
      try {
        const resolved = await reverseGeocode(lat, lon);
        if (resolved) label = resolved;
      } catch (e) {
        console.warn('[weather] geocodificación inversa fallida', e);
      }
      settings.patch({ weather: { enabled: true, source: 'geo', lat, lon, label } });
      await this.refresh();
      this._startTimer();
      return { ok: true, label };
    } catch (err) {
      return { ok: false, message: geoErrorMessage(err) };
    }
  },

  /** Busca una ciudad por nombre, la guarda como ubicación y refresca. */
  async setCity(name) {
    const q = String(name || '').trim();
    if (!q) return { ok: false, message: 'Escribe el nombre de una ciudad.' };
    try {
      const { lat, lon, label } = await geocode(q);
      settings.patch({ weather: { enabled: true, source: 'manual', lat, lon, label } });
      await this.refresh();
      this._startTimer();
      return { ok: true, label };
    } catch (err) {
      const msg = (err && err.message) === 'NOT_FOUND'
        ? `No se encontró "${q}".`
        : 'No se pudo buscar la ciudad. ¿Hay Internet?';
      return { ok: false, message: msg };
    }
  },

  /** Desactiva el clima y limpia el refresco. */
  disable() {
    settings.patch({ weather: { enabled: false } });
    this._stopTimer();
    setState({ status: 'idle', error: null });
  },

  _startTimer() {
    this._stopTimer();
    refreshTimer = setInterval(() => {
      if ((settings.get().weather || {}).enabled) this.refresh();
    }, REFRESH_MS);
  },
  _stopTimer() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  },
};
