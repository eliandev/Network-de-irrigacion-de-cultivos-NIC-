/**
 * NIC — Pantalla Control (PRD 7.3).
 * Propósito: operar y configurar el riego.
 *
 * Es la pantalla más delicada: maneja comandos al dispositivo con estado
 * optimista, espera de ack, reversión visual ante fallo y un slider de umbral
 * que NO debe re-renderizarse mientras el usuario lo manipula.
 *
 * Contrato de pantalla (igual que dashboard.js):
 *   export function mount(root)  -> construye el DOM y se suscribe al store
 *   export function unmount()    -> limpia suscripciones y temporizadores
 */

import { store } from '../store.js';
import { settings } from '../settings.js';
import { ws } from '../ws-client.js';
import {
  CONN, PUMP, MODE,
  ADC_MAX, DEFAULT_THRESHOLD_ADC,
  cmdPumpOn, cmdPumpOff, cmdSetMode, cmdSetThreshold,
  thresholdAdcToPct, clampAdc,
} from '../protocol.js';
import { toast, confirmDialog, escapeHtml } from '../ui.js';
import { icon } from '../icons.js';

let unsub = null;
let timer = null;          // setInterval de 1s solo para animar el countdown
let rootRef = null;        // referencia al contenedor para el tick del countdown

// --- Estado local de la pantalla (no vive en el store) ---------------------
// Duración (en segundos) del último pump_on que iniciamos: sirve para calcular
// el % de la barra de progreso del riego manual. Fallback al máximo conocido.
let lastManualDurationS = 0;
let maxRemainingSeen = 0;
// Bandera: el usuario está arrastrando el slider del umbral -> no re-render del slider.
let interacting = false;
// Valor ADC mostrado en el slider mientras se interactúa (optimista).
let sliderAdc = null;
// Cuenta regresiva: restante mostrado (optimista) y ts de la telemetría ya aplicada.
let displayRemaining = 0;
let cdTelemetryTs = 0;

export function mount(root) {
  rootRef = root;
  const cfg = settings.get();
  const defMin = clampMinutes(cfg.manualDefaultMin || 20);

  root.innerHTML = `
    <h1 class="screen-title">Control</h1>
    <p class="screen-sub">Opera y configura el riego de tu cultivo.</p>

    <!-- Aviso de conexión (se muestra/oculta en render) -->
    <div id="ctrl-conn-warn"></div>

    <!-- 1) Riego manual ON/OFF + duración -->
    <div class="card">
      <div class="card__header">
        <span class="card__title">${icon('droplet', { size: 18 })} Riego manual</span>
        <span id="ctrl-pump-chip"></span>
      </div>

      <div class="field">
        <label for="ctrl-manual-min">Duración (minutos)</label>
        <input type="number" id="ctrl-manual-min" inputmode="numeric"
               min="1" max="60" step="1" value="${defMin}" />
        <span class="hint">Entre 1 y 60 minutos.</span>
      </div>

      <div class="btn-row mt">
        <button type="button" class="btn btn--primary btn--block" id="ctrl-pump-on">Activar riego</button>
        <button type="button" class="btn btn--danger btn--block" id="ctrl-pump-off">Detener riego</button>
      </div>

      <!-- 2) Cuenta regresiva del riego manual -->
      <div id="ctrl-countdown" class="mt"></div>
    </div>

    <!-- 3) Modo de operación -->
    <div class="card">
      <div class="card__header"><span class="card__title">Modo de operación</span></div>
      <div class="segmented" id="ctrl-mode" role="group" aria-label="Modo de operación">
        <button type="button" data-mode="auto" aria-pressed="false">Automático</button>
        <button type="button" data-mode="manual" aria-pressed="false">Manual</button>
      </div>
      <p class="soon-note" id="ctrl-mode-note"></p>
    </div>

    <!-- 4) Umbral de humedad -->
    <div class="card">
      <div class="card__header"><span class="card__title">Umbral de riego</span></div>
      <div class="range-field">
        <label for="ctrl-threshold">Nivel de humedad para regar</label>
        <input type="range" id="ctrl-threshold"
               min="0" max="${ADC_MAX}" step="1" value="${DEFAULT_THRESHOLD_ADC}" />
        <div class="kv">
          <span class="kv__k">Valor del umbral</span>
          <span class="kv__v" id="ctrl-threshold-val">—</span>
        </div>
      </div>
      <p class="hint mt">El umbral se guarda en el dispositivo (EEPROM).</p>
    </div>

    <!-- 5) Programación de horarios (próximamente) -->
    <div class="card is-soon">
      <div class="card__header">
        <span class="card__title">${icon('clock', { size: 18 })} Programación de horarios</span>
        <span class="badge-soon">Próximamente</span>
      </div>
      <p class="soon-note">Podrás programar riegos por hora y día en una próxima fase.</p>
      <div class="btn-row mt">
        <button type="button" class="btn btn--ghost btn--block" disabled aria-disabled="true">Crear horario</button>
      </div>
    </div>
  `;

  // --- Listeners ------------------------------------------------------------

  // 1) Riego manual ON
  root.querySelector('#ctrl-pump-on').addEventListener('click', onPumpOn);
  // Botón OFF (sin confirmación)
  root.querySelector('#ctrl-pump-off').addEventListener('click', onPumpOff);

  // 3) Cambio de modo (delegación en el contenedor segmented)
  root.querySelector('#ctrl-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || btn.disabled) return;
    onSetMode(btn.dataset.mode);
  });

  // 1b) Duración: valida al salir del campo (feedback inmediato, igual que Ajustes).
  root.querySelector('#ctrl-manual-min').addEventListener('change', (e) => {
    e.target.value = clampMinutes(e.target.value);
  });

  // 4) Umbral: mientras arrastra (input) actualizamos solo la etiqueta y marcamos
  // "interacting" para que render() NO pise el slider. Al soltar (change) enviamos.
  const slider = root.querySelector('#ctrl-threshold');
  const stopInteracting = () => { interacting = false; };
  slider.addEventListener('pointerdown', () => { interacting = true; });
  slider.addEventListener('input', () => {
    interacting = true;
    sliderAdc = clampAdc(slider.value);
    paintThresholdLabel(sliderAdc);
  });
  slider.addEventListener('change', () => {
    onSetThreshold(clampAdc(slider.value));
  });
  // Liberar la bandera ante CUALQUIER final del gesto, incluidas cancelaciones
  // táctiles: sin pointercancel/touchcancel, "interacting" podría quedar atascado
  // en true y el slider dejaría de sincronizarse con la telemetría.
  slider.addEventListener('pointerup', stopInteracting);
  slider.addEventListener('pointercancel', stopInteracting);
  slider.addEventListener('lostpointercapture', stopInteracting);
  slider.addEventListener('touchcancel', stopInteracting);
  slider.addEventListener('blur', stopInteracting);

  // setInterval de 1s solo para animar el countdown entre telemetrías.
  timer = setInterval(tickCountdown, 1000);

  unsub = store.subscribe(() => render(root));
  render(root);
}

export function unmount() {
  if (unsub) { unsub(); unsub = null; }
  if (timer) { clearInterval(timer); timer = null; }
  rootRef = null;
  interacting = false;
  sliderAdc = null;
  displayRemaining = 0;
  cdTelemetryTs = 0;
}

// --- Acciones de comando ----------------------------------------------------

async function onPumpOn() {
  if (store.getState().connection !== CONN.CONNECTED) return;

  const input = rootRef.querySelector('#ctrl-manual-min');
  const min = clampMinutes(input.value);
  input.value = min; // normaliza visualmente

  const ok = await confirmDialog({
    title: 'Activar riego manual',
    message: `Se regará durante ${min} ${min === 1 ? 'minuto' : 'minutos'}. ¿Quieres continuar?`,
    confirmText: 'Regar',
    danger: false,
  });
  if (!ok) return;

  // La conexión pudo caerse mientras el diálogo estaba abierto: revalidar.
  if (store.getState().connection !== CONN.CONNECTED) {
    toast('Sin conexión con el dispositivo', { type: 'error' });
    return;
  }

  const btn = rootRef.querySelector('#ctrl-pump-on');
  const durationS = min * 60;

  // Estado optimista: deshabilita el botón mientras está pendiente.
  btn.disabled = true;
  btn.textContent = 'Activando…';

  try {
    await ws.sendCommand(cmdPumpOn(durationS));
    // Solo al confirmarse: guarda la duración para el % de la barra de progreso.
    lastManualDurationS = durationS;
    maxRemainingSeen = Math.max(maxRemainingSeen, durationS);
    toast('Riego manual activado', { type: 'ok' });
  } catch (err) {
    showCommandError(err);
  } finally {
    // render() reconstruye el estado correcto de los botones.
    render(rootRef);
  }
}

async function onPumpOff() {
  const state = store.getState();
  if (state.connection !== CONN.CONNECTED) return;

  const btn = rootRef.querySelector('#ctrl-pump-off');
  btn.disabled = true;
  btn.textContent = 'Deteniendo…';

  try {
    await ws.sendCommand(cmdPumpOff());
    lastManualDurationS = 0;
    toast('Riego detenido', { type: 'ok' });
  } catch (err) {
    showCommandError(err);
  } finally {
    render(rootRef);
  }
}

async function onSetMode(mode) {
  const state = store.getState();
  if (state.connection !== CONN.CONNECTED) return;
  if (mode !== MODE.AUTO && mode !== MODE.MANUAL) return;

  // Optimista: pinta el botón elegido como activo de inmediato.
  paintMode(mode);

  // Deshabilita el control mientras esperamos ack.
  setSegmentedDisabled(true);

  try {
    await ws.sendCommand(cmdSetMode(mode));
    toast(mode === MODE.AUTO ? 'Modo automático activado' : 'Modo manual activado', { type: 'ok' });
  } catch (err) {
    showCommandError(err);
  } finally {
    // render() devuelve el modo al valor real de la telemetría (revierte si falló).
    render(rootRef);
  }
}

async function onSetThreshold(adc) {
  const state = store.getState();
  if (state.connection !== CONN.CONNECTED) {
    interacting = false;
    sliderAdc = null;
    render(rootRef);
    return;
  }

  const value = clampAdc(adc);
  sliderAdc = value;

  try {
    await ws.sendCommand(cmdSetThreshold(value));
    toast(`Umbral guardado (${value} ADC · ${thresholdAdcToPct(value)}%)`, { type: 'ok' });
  } catch (err) {
    showCommandError(err);
    // Falló: revertimos al valor de la telemetría en el próximo render.
    sliderAdc = null;
  } finally {
    // NO tocar "interacting" aquí: lo gestionan los eventos del puntero. Si el
    // usuario volvió a arrastrar mientras esperábamos el ack, forzarlo a false
    // haría saltar el slider bajo el dedo (condición de carrera).
    render(rootRef);
  }
}

// --- Render -----------------------------------------------------------------

function render(root) {
  const state = store.getState();
  const t = state.telemetry;
  const connected = state.connection === CONN.CONNECTED;
  const pending = state.pending || {};

  // --- Aviso de conexión ----------------------------------------------------
  const warnEl = root.querySelector('#ctrl-conn-warn');
  if (!connected) {
    warnEl.innerHTML = `
      <div class="card">
        <div class="kv">
          <span class="kv__k">${icon('triangle-alert', { size: 15 })} Sin conexión con el dispositivo</span>
          <span class="kv__v"><span class="chip chip--warn">Controles bloqueados</span></span>
        </div>
        <p class="soon-note">Los controles se reactivarán al recuperar la conexión.</p>
      </div>`;
  } else {
    warnEl.innerHTML = '';
  }

  // --- 1) Riego manual: chip + estado de botones ----------------------------
  const pumpOn = !!(t && t.pump === PUMP.ON);
  const chipEl = root.querySelector('#ctrl-pump-chip');
  chipEl.innerHTML = t
    ? (pumpOn
        ? `<span class="chip chip--ok">${icon('power', { size: 15 })} Encendida</span>`
        : `<span class="chip">${icon('power', { size: 15 })} Apagada</span>`)
    : '';

  const minInput = root.querySelector('#ctrl-manual-min');
  const btnOn = root.querySelector('#ctrl-pump-on');
  const btnOff = root.querySelector('#ctrl-pump-off');

  // pump_on/pump_off comparten el ciclo de pending por acción.
  const pumpPending = !!pending.pump_on || !!pending.pump_off;

  minInput.disabled = !connected || pumpPending;

  // Botón Activar: deshabilitado si no hay conexión, si hay comando pendiente
  // o si la bomba ya está encendida.
  btnOn.disabled = !connected || pumpPending || pumpOn;
  if (!pending.pump_on) btnOn.textContent = 'Activar riego';

  // Botón Detener: solo tiene sentido si la bomba está encendida.
  btnOff.disabled = !connected || pumpPending || !pumpOn;
  if (!pending.pump_off) btnOff.textContent = 'Detener riego';

  // --- 2) Cuenta regresiva del riego manual ---------------------------------
  renderCountdown(root, t);

  // --- 3) Modo de operación -------------------------------------------------
  const modePending = !!pending.set_mode;
  setSegmentedDisabled(!connected || modePending);
  // Mientras hay un cambio pendiente conservamos lo pintado optimista.
  if (!modePending) {
    paintMode(t ? t.mode : null);
  }
  const noteEl = root.querySelector('#ctrl-mode-note');
  if (t && t.mode === MODE.AUTO) {
    noteEl.textContent = 'El dispositivo riega solo cuando la humedad baja del umbral.';
  } else if (t && t.mode === MODE.MANUAL) {
    noteEl.textContent = 'El riego automático está desactivado; controla la bomba manualmente.';
  } else {
    noteEl.textContent = '';
  }

  // --- 4) Umbral de humedad -------------------------------------------------
  const slider = root.querySelector('#ctrl-threshold');
  const thresholdPending = !!pending.set_threshold;
  slider.disabled = !connected || thresholdPending;

  // CUIDADO: no pisar el slider mientras el usuario lo arrastra.
  if (!interacting) {
    const adc = (sliderAdc != null)
      ? sliderAdc
      : (t && Number.isFinite(t.threshold) ? t.threshold : DEFAULT_THRESHOLD_ADC);
    // Solo escribimos en el DOM si cambió, para no resetear el foco innecesariamente.
    if (String(slider.value) !== String(adc)) slider.value = adc;
    paintThresholdLabel(adc);
  }
}

function renderCountdown(root, t) {
  const el = root.querySelector('#ctrl-countdown');
  const remaining = t ? t.manualRemaining : 0;

  if (!remaining || remaining <= 0) {
    displayRemaining = 0;
    cdTelemetryTs = t ? t.ts : 0;
    el.innerHTML = '';
    return;
  }

  // Sincroniza el restante mostrado SOLO cuando llega telemetría nueva (ts distinto).
  // Así los re-render por otros cambios del store (pending, alertas…) no reinician
  // la animación del tick y se evita el "jitter" del contador.
  if (t && t.ts !== cdTelemetryTs) {
    cdTelemetryTs = t.ts;
    displayRemaining = remaining;
  }
  // Recuerda el máximo visto para el cálculo del % cuando no sabemos la duración.
  maxRemainingSeen = Math.max(maxRemainingSeen, remaining);

  // Base del cálculo: duración del último pump_on; si no, el máximo conocido.
  const base = lastManualDurationS > 0 ? lastManualDurationS : maxRemainingSeen;
  const pct = base > 0 ? clampPct(Math.round((displayRemaining / base) * 100)) : 0;

  el.innerHTML = `
    <div class="kv"><span class="kv__k">Riego manual restante</span>
      <span class="kv__v countdown" id="ctrl-cd-value">${fmtMMSS(displayRemaining)}</span></div>
    <div class="progress" role="progressbar" aria-label="Tiempo de riego restante"
         aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
      <div class="progress__bar" id="ctrl-cd-bar" style="width:${pct}%;"></div>
    </div>`;
}

/**
 * Tick de 1s SOLO para animar el countdown entre telemetrías (suavizado visual).
 * NO es la fuente de verdad: el backend manda manualRemaining en cada telemetría
 * y renderCountdown() la reaplica. Aquí decrementamos una variable (no el DOM) para
 * que un cambio de locale/formato no pueda detener el contador.
 */
function tickCountdown() {
  if (!rootRef) return;
  if (store.getState().connection !== CONN.CONNECTED) return;
  if (displayRemaining <= 0) return;
  const valueEl = rootRef.querySelector('#ctrl-cd-value');
  const barEl = rootRef.querySelector('#ctrl-cd-bar');
  if (!valueEl || !barEl) return;

  displayRemaining = Math.max(0, displayRemaining - 1);
  valueEl.textContent = fmtMMSS(displayRemaining);

  const base = lastManualDurationS > 0 ? lastManualDurationS : maxRemainingSeen;
  if (base > 0) barEl.style.width = clampPct(Math.round((displayRemaining / base) * 100)) + '%';
}

// --- Helpers de pintado -----------------------------------------------------

function paintMode(mode) {
  if (!rootRef) return;
  const btns = rootRef.querySelectorAll('#ctrl-mode button[data-mode]');
  btns.forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function setSegmentedDisabled(disabled) {
  if (!rootRef) return;
  rootRef.querySelectorAll('#ctrl-mode button[data-mode]').forEach((b) => {
    b.disabled = disabled;
    b.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  });
}

function paintThresholdLabel(adc) {
  if (!rootRef) return;
  const el = rootRef.querySelector('#ctrl-threshold-val');
  if (!el) return;
  const a = clampAdc(adc);
  el.textContent = `${a} ADC · ${thresholdAdcToPct(a)}%`;
}

// --- Utilidades --------------------------------------------------------------

/** Asegura un entero de minutos en el rango 1..60. */
function clampMinutes(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(60, n));
}

/** Mapea el error de sendCommand a un mensaje claro en español. */
function commandErrorMsg(err) {
  const code = err && err.message ? err.message : '';
  switch (code) {
    case 'ACK_TIMEOUT': return 'El dispositivo no respondió a tiempo';
    case 'SIN_CONEXION': return 'Sin conexión con el dispositivo';
    case 'ACK_NOK': return 'El dispositivo rechazó el comando';
    default: return 'No se pudo completar la operación';
  }
}

/**
 * Muestra el error de un comando, salvo SUPERSEDED: ese código significa que el
 * propio usuario envió otro comando más reciente de la misma acción, que SÍ
 * continúa; mostrar un error ahí sería engañoso.
 */
function showCommandError(err) {
  if (err && err.message === 'SUPERSEDED') return;
  toast(commandErrorMsg(err), { type: 'error' });
}

function clampPct(p) { return Math.max(0, Math.min(100, p)); }

function fmtMMSS(s) {
  const total = Math.max(0, Math.round(s));
  const m = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${m}:${ss}`;
}
