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
import { weather } from '../weather.js';
import {
  CONN, LINK, PUMP, MODE,
  humidityStatus, HUMIDITY_LABEL,
} from '../protocol.js';
import { toast, escapeHtml } from '../ui.js';
import { icon } from '../icons.js';

let unsub = null;
let unsubWeather = null;

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
        <button type="button" class="btn btn--primary btn--block" id="dash-manual">${icon('droplet', { size: 18 })} Riego manual</button>
      </div>
    </div>

    <!-- Clima en vivo según la ubicación (Open-Meteo) -->
    <div id="dash-weather"></div>

    <div class="grid-2">
      ${soonCard('waves', 'Nivel de agua')}
      ${soonCard('clock', 'Próximo riego')}
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
  // El clima tiene su propio ciclo (red/Internet), independiente de la telemetría.
  unsubWeather = weather.subscribe(() => renderWeather(root));
  render(root);
  renderWeather(root);
}

export function unmount() {
  if (unsub) { unsub(); unsub = null; }
  if (unsubWeather) { unsubWeather(); unsubWeather = null; }
}

function soonCard(iconName, title) {
  return `
    <div class="card is-soon">
      <div class="card__header"><span class="card__title">${icon(iconName, { size: 18 })} ${escapeHtml(title)}</span></div>
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
      ? `<span class="chip chip--ok">${icon('power', { size: 15 })} Encendida</span>`
      : `<span class="chip">${icon('power', { size: 15 })} Apagada</span>`;
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
    alertsEl.innerHTML = `<p class="empty-state">Sin alertas recientes.</p>`;
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
  const ic = a.severity === 'critico'
    ? icon('octagon-alert', { size: 20 })
    : icon('triangle-alert', { size: 20 });
  return `
    <div class="alert-item alert-item--${a.severity}">
      <span class="alert-item__icon">${ic}</span>
      <div class="alert-item__body">
        <div class="alert-item__title">${escapeHtml(a.title)}</div>
        <div class="alert-item__time">${fmtTime(a.ts)}</div>
      </div>
    </div>`;
}

// --- Clima ------------------------------------------------------------------

function renderWeather(root) {
  const el = root.querySelector('#dash-weather');
  if (!el) return;
  const w = weather.getState();

  if (w.status === 'idle') {
    el.innerHTML = weatherPromptCard('Muestra el clima de tu ubicación.');
  } else if (w.status === 'no-location') {
    el.innerHTML = weatherPromptCard('Elige tu ubicación para ver el clima.');
  } else if (w.status === 'loading' && !w.data) {
    el.innerHTML = `
      <div class="card">
        <div class="card__header"><span class="card__title">${icon('cloud', { size: 18 })} Clima</span></div>
        <p class="empty-state">Cargando clima…</p>
      </div>`;
  } else if (w.status === 'error' && !w.data) {
    el.innerHTML = `
      <div class="card">
        <div class="card__header"><span class="card__title">${icon('cloud', { size: 18 })} Clima</span></div>
        <p class="empty-state">${escapeHtml(w.error || 'No se pudo obtener el clima.')}</p>
        <div class="btn-row mt">
          <button type="button" class="btn btn--primary btn--small" id="dash-weather-refresh">Reintentar</button>
          <button type="button" class="btn btn--ghost btn--small" id="dash-weather-settings">Cambiar ubicación</button>
        </div>
      </div>`;
  } else {
    // ready (o error/loading conservando el último dato)
    el.innerHTML = weatherDataCard(w);
  }
  bindWeatherActions(root);
}

function weatherPromptCard(text) {
  return `
    <div class="card">
      <div class="card__header"><span class="card__title">${icon('cloud', { size: 18 })} Clima</span></div>
      <p class="soon-note">${escapeHtml(text)}</p>
      <div class="btn-row mt">
        <button type="button" class="btn btn--primary btn--small" id="dash-weather-loc">${icon('map-pin', { size: 16 })} Usar mi ubicación</button>
        <button type="button" class="btn btn--ghost btn--small" id="dash-weather-settings">Configurar</button>
      </div>
    </div>`;
}

function weatherDataCard(w) {
  const d = w.data;
  const updating = w.status === 'loading';
  const stale = w.status === 'error';
  return `
    <div class="card">
      <div class="card__header">
        <span class="card__title">${icon('cloud', { size: 18 })} Clima</span>
        <span class="small muted">${escapeHtml(d.label || 'Mi ubicación')}</span>
      </div>
      <div class="weather">
        <div class="weather__main">
          <span class="weather__icon">${icon(d.icon, { size: 46, sw: 1.75 })}</span>
          <div>
            <div class="weather__temp">${d.tempC}°C</div>
            <div class="weather__desc">${escapeHtml(d.desc)}</div>
          </div>
        </div>
        <div class="weather__meta">
          <div class="kv"><span class="kv__k">Sensación</span><span class="kv__v">${d.feelsC}°C</span></div>
          <div class="kv"><span class="kv__k">Humedad del aire</span><span class="kv__v">${d.humidity}%</span></div>
          <div class="kv"><span class="kv__k">Viento</span><span class="kv__v">${d.windKmh} km/h</span></div>
        </div>
      </div>
      ${stale ? `<p class="soon-note">${icon('triangle-alert', { size: 14 })} ${escapeHtml(w.error || 'No se pudo actualizar.')}</p>` : ''}
      <div class="weather__foot">
        <span class="small muted">${updating ? 'Actualizando…' : 'Actualizado ' + fmtAgo(w.fetchedAt)}</span>
        <button type="button" class="btn btn--ghost btn--small" id="dash-weather-refresh">Actualizar</button>
      </div>
    </div>`;
}

function bindWeatherActions(root) {
  const loc = root.querySelector('#dash-weather-loc');
  if (loc) loc.addEventListener('click', async () => {
    loc.disabled = true;
    const res = await weather.useMyLocation();
    if (!res.ok) toast(res.message || 'No se pudo usar tu ubicación.', { type: 'error', duration: 4500 });
  });

  const refresh = root.querySelector('#dash-weather-refresh');
  if (refresh) refresh.addEventListener('click', () => weather.refresh());

  const settingsBtn = root.querySelector('#dash-weather-settings');
  if (settingsBtn) settingsBtn.addEventListener('click', () => { location.hash = '#/ajustes'; });
}

/** "hace instantes" / "hace N min" / "hace N h" a partir de un epoch(ms). */
function fmtAgo(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return 'hace instantes';
  const min = Math.round(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return `hace ${h} h`;
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
