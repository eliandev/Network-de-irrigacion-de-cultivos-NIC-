/**
 * NIC — Generacion de alertas y notificaciones.
 * Las alertas se derivan en el cliente a partir de la telemetria y del estado
 * de conexion (PRD seccion 7.4 / 13.2). Se emiten en-app y, si el usuario lo
 * permite, como notificacion del navegador.
 */

import { store } from './store.js';
import { settings } from './settings.js';
import { CONN, LINK } from './protocol.js';

const MAX_ALERTS = 50;
let counter = 0;

// Estado de borde (para no repetir la misma alerta mientras la condicion dura).
const active = { critical: false, connection: false, arduino: false };

function pushAlert({ kind, severity, title, message }) {
  counter += 1;
  const alert = {
    id: `a${counter}-${Date.now()}`,
    kind,
    severity,           // 'critico' | 'aviso'
    title,
    message,
    ts: Date.now(),
    read: false,
  };
  const next = [alert, ...store.getState().alerts].slice(0, MAX_ALERTS);
  store.setAlerts(next);
  return alert;
}

function notify(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      // eslint-disable-next-line no-new
      new Notification(title, { body, tag: 'nic-alert', badge: 'assets/logo.svg', icon: 'assets/logo.svg' });
    }
  } catch (err) {
    console.warn('[alerts] notificacion fallida', err);
  }
}

function evaluate(state) {
  const cfg = settings.get();
  const t = state.telemetry;

  // 1) Humedad critica
  if (t) {
    const isCritical = t.pct <= cfg.criticalPct;
    if (isCritical && !active.critical) {
      active.critical = true;
      const a = pushAlert({
        kind: 'humidity_critical',
        severity: 'critico',
        title: 'Humedad crítica',
        message: `La humedad del suelo es ${t.pct}% (umbral crítico ${cfg.criticalPct}%).`,
      });
      if (cfg.notify.critical) notify(a.title, a.message);
    } else if (!isCritical && t.pct > cfg.criticalPct + 3) {
      active.critical = false; // histeresis para no re-disparar al oscilar
    }
  }

  // 2) Perdida de conexion (WebSocket)
  const lostConn = state.connection === CONN.DISCONNECTED;
  if (lostConn && !active.connection) {
    active.connection = true;
    const a = pushAlert({
      kind: 'connection_lost',
      severity: 'critico',
      title: 'Sin conexión',
      message: 'Se perdió la conexión con el dispositivo NIC.',
    });
    if (cfg.notify.connection) notify(a.title, a.message);
  } else if (!lostConn && state.connection === CONN.CONNECTED) {
    active.connection = false;
  }

  // 3) Enlace con el Arduino perdido (ESP conectado pero Arduino no responde)
  const arduinoLost = state.connection === CONN.CONNECTED && state.link === LINK.LOST;
  if (arduinoLost && !active.arduino) {
    active.arduino = true;
    const a = pushAlert({
      kind: 'arduino_lost',
      severity: 'critico',
      title: 'Enlace con el Arduino perdido',
      message: 'El ESP no recibe respuesta del Arduino. El riego automático sigue activo por seguridad.',
    });
    if (cfg.notify.connection) notify(a.title, a.message);
  } else if (state.link === LINK.OK || state.connection !== CONN.CONNECTED) {
    // Limpiamos el borde tanto al recuperar el enlace como al perder el socket
    // (evita alertas redundantes y arduino_lost "pegado" tras reconectar).
    active.arduino = false;
  }
}

export const alerts = {
  /** Comienza a evaluar alertas ante cada cambio del store. */
  init() {
    store.subscribe(evaluate);
  },

  /** Solicita permiso de notificaciones del navegador. */
  async requestPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    try { return await Notification.requestPermission(); }
    catch { return Notification.permission; }
  },

  permission() {
    return ('Notification' in window) ? Notification.permission : 'unsupported';
  },

  markAllRead() {
    const next = store.getState().alerts.map((a) => ({ ...a, read: true }));
    store.setAlerts(next);
  },

  clearAll() {
    store.setAlerts([]);
  },
};
