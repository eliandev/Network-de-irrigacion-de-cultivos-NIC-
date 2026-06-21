/**
 * NIC — Protocolo de mensajes (JSON sobre WebSocket).
 * Fuente unica de verdad para constantes, conversiones y (de)serializacion.
 * Coincide con el contrato definido en el PRD (seccion 6.4 / 6.5).
 */

// --- Constantes del hardware / dominio -------------------------------------
export const ADC_MAX = 1023;
export const DEFAULT_THRESHOLD_ADC = 721;   // umbral de riego automatico (PRD)
export const DEFAULT_MANUAL_MIN = 20;       // duracion por defecto del riego manual
export const DEFAULT_CRITICAL_PCT = 15;     // humedad critica por defecto (%)

// Estados de la conexion WebSocket (cliente <-> ESP) — ver PRD 13.1
export const CONN = Object.freeze({
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
});

// Estado del enlace serial ESP <-> Arduino
export const LINK = Object.freeze({
  OK: 'ok',
  LOST: 'lost',
  UNKNOWN: 'unknown',
});

export const PUMP = Object.freeze({ ON: 'on', OFF: 'off' });
export const MODE = Object.freeze({ AUTO: 'auto', MANUAL: 'manual' });

// Acciones de comando admitidas (App -> ESP -> Arduino)
export const ACTIONS = Object.freeze({
  PUMP_ON: 'pump_on',
  PUMP_OFF: 'pump_off',
  SET_MODE: 'set_mode',
  SET_THRESHOLD: 'set_threshold',
});

// --- Conversiones ----------------------------------------------------------

/** Convierte la lectura ADC cruda del YL-69 (resistividad inversa) a % de humedad. */
export function rawToPct(raw) {
  const r = clampAdc(raw);
  return Math.round(((ADC_MAX - r) / ADC_MAX) * 100);
}

/** Convierte un umbral expresado en unidades ADC a su equivalente en % de humedad. */
export function thresholdAdcToPct(adc) {
  return rawToPct(adc);
}

/** Convierte un % de humedad a su unidad ADC equivalente (para el umbral). */
export function pctToThresholdAdc(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return Math.round(ADC_MAX - (p / 100) * ADC_MAX);
}

export function clampAdc(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(ADC_MAX, Math.round(n)));
}

/**
 * Clasifica el estado de humedad para la UI.
 * @returns {'optimo'|'bajo'|'critico'}
 *  - critico: humedad por debajo del umbral critico configurable.
 *  - bajo: el suelo esta seco segun el umbral de riego (raw > threshold).
 *  - optimo: por encima de ese umbral.
 */
export function humidityStatus(pct, criticalPct, thresholdAdc) {
  const critical = Number.isFinite(criticalPct) ? criticalPct : DEFAULT_CRITICAL_PCT;
  const lowPct = thresholdAdcToPct(thresholdAdc ?? DEFAULT_THRESHOLD_ADC);
  if (pct <= critical) return 'critico';
  if (pct <= lowPct) return 'bajo';
  return 'optimo';
}

export const HUMIDITY_LABEL = Object.freeze({
  optimo: 'Óptimo',
  bajo: 'Bajo',
  critico: 'Crítico',
});

// --- Builders de comandos --------------------------------------------------

export function cmdPumpOn(durationS) {
  return { type: 'command', action: ACTIONS.PUMP_ON, duration_s: Math.round(durationS) };
}
export function cmdPumpOff() {
  return { type: 'command', action: ACTIONS.PUMP_OFF };
}
export function cmdSetMode(mode) {
  return { type: 'command', action: ACTIONS.SET_MODE, value: mode };
}
export function cmdSetThreshold(adc) {
  return { type: 'command', action: ACTIONS.SET_THRESHOLD, value: clampAdc(adc) };
}

// --- Parseo / validacion de mensajes entrantes -----------------------------

/**
 * Parsea con seguridad un mensaje entrante.
 * @returns {object|null} objeto del mensaje o null si es invalido.
 */
export function parseMessage(data) {
  let obj;
  try {
    obj = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;
  return obj;
}

/** Normaliza un mensaje de telemetria a la forma interna del store. */
export function normalizeTelemetry(msg) {
  const raw = clampAdc(msg.humidity_raw);
  const pct = Number.isFinite(msg.humidity_pct) ? Math.round(msg.humidity_pct) : rawToPct(raw);
  return {
    raw,
    pct,
    pump: msg.pump === PUMP.ON ? PUMP.ON : PUMP.OFF,
    mode: msg.mode === MODE.MANUAL ? MODE.MANUAL : MODE.AUTO,
    threshold: clampAdc(msg.threshold ?? DEFAULT_THRESHOLD_ADC),
    manualRemaining: Math.max(0, Math.round(Number(msg.manual_remaining_s) || 0)),
    ts: Number(msg.ts) || Math.floor(Date.now() / 1000),
  };
}
