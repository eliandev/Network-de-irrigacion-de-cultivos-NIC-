/**
 * NIC — Store central reactivo (sin dependencias).
 * Patron pub/sub minimalista: un unico objeto de estado + suscripciones.
 * Las pantallas se suscriben y se re-renderizan ante los cambios.
 */

import { CONN, LINK } from './protocol.js';

/** @typedef {Object} Telemetry */
const initialState = {
  // Conexion
  connection: CONN.CONNECTING,   // estado del WebSocket
  link: LINK.UNKNOWN,            // enlace serial ESP <-> Arduino
  reconnectAttempts: 0,
  lastTelemetryTs: 0,            // epoch(ms) de la ultima telemetria recibida
  demo: false,                   // true => datos simulados en navegador (sin hardware)

  // Telemetria (ultimo valor conocido)
  telemetry: null,               // { raw, pct, pump, mode, threshold, manualRemaining, ts }

  // Alertas activas / historial de alertas (las gestiona alerts.js)
  alerts: [],

  // UI: estado optimista mientras esperamos ack
  pending: {},                   // { [action]: true }
};

let state = { ...initialState };
const subscribers = new Set();

function notify() {
  for (const fn of subscribers) {
    try { fn(state); } catch (err) { console.error('[store] subscriber error', err); }
  }
}

export const store = {
  getState() {
    return state;
  },

  /** Mezcla un patch superficial en el estado y notifica. */
  set(patch) {
    state = { ...state, ...patch };
    notify();
  },

  /** Actualiza usando una funcion (acceso al estado previo). */
  update(fn) {
    const patch = fn(state);
    if (patch) this.set(patch);
  },

  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },

  // --- Helpers de dominio ---------------------------------------------------

  setConnection(connection) {
    if (state.connection !== connection) this.set({ connection });
  },

  setLink(link) {
    if (state.link !== link) this.set({ link });
  },

  setTelemetry(telemetry) {
    // Solo actualizamos lastTelemetryTs si hay telemetría real, para no indicar
    // "última lectura reciente" ante un mensaje vacío o malformado.
    if (telemetry) this.set({ telemetry, lastTelemetryTs: Date.now() });
    else this.set({ telemetry: null });
  },

  setPending(action, value) {
    this.set({ pending: { ...state.pending, [action]: value } });
  },

  setAlerts(alerts) {
    this.set({ alerts });
  },
};
