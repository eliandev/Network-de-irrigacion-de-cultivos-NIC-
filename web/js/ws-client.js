/**
 * NIC — Cliente WebSocket.
 * Gestiona la conexion con el ESP8266: reconexion con backoff exponencial,
 * keepalive (ping/pong), confirmacion de comandos (ack) con timeout y la
 * maquina de estados de conexion del PRD (seccion 13.1).
 */

import { store } from './store.js';
import { settings } from './settings.js';
import {
  CONN, LINK, parseMessage, normalizeTelemetry,
} from './protocol.js';

// Parametros de tiempo
const PING_INTERVAL_MS = 5000;     // keepalive a nivel de app
const STALE_MS = 8000;             // sin mensajes => enlace degradado
const ACK_TIMEOUT_MS = 5000;       // espera maxima de un ack
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 10000;      // PRD: reconexion <= 10 s
const MAX_ATTEMPTS = 8;            // tras esto => SinConexion (Reintentar manual)

class WSClient {
  constructor() {
    this.socket = null;
    this.attempts = 0;
    this.intentionalClose = false;
    this.pingTimer = null;
    this.staleTimer = null;
    this.reconnectTimer = null;
    this.pending = new Map();       // action -> { resolve, reject, timer }
    this.listeners = { error: new Set(), event: new Set() };
  }

  // --- API publica ----------------------------------------------------------

  connect() {
    this.intentionalClose = false;
    this._clearReconnect();
    this._open();
  }

  /** Reintento manual desde "Sin conexion". */
  retry() {
    this.attempts = 0;
    this.connect();
  }

  /** Cierra y reabre (p. ej. al cambiar el host en Ajustes). */
  reconnectNow() {
    this.attempts = 0;
    this._teardownSocket();
    this.connect();
  }

  disconnect() {
    this.intentionalClose = true;
    this._clearTimers();
    this._teardownSocket();
    store.setConnection(CONN.DISCONNECTED);
    store.setLink(LINK.UNKNOWN);
  }

  /**
   * Envia un comando y espera su ack.
   * @returns {Promise<void>} resuelve con el ack, rechaza por timeout/desconexion.
   */
  sendCommand(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new Error('SIN_CONEXION'));
        return;
      }
      const action = cmd.action;
      // Si ya habia un comando igual pendiente, lo damos por superado.
      if (this.pending.has(action)) {
        const prev = this.pending.get(action);
        clearTimeout(prev.timer);
        prev.reject(new Error('SUPERSEDED'));
      }
      try {
        this.socket.send(JSON.stringify(cmd));
      } catch (err) {
        reject(err);
        return;
      }
      store.setPending(action, true);
      const timer = setTimeout(() => {
        this.pending.delete(action);
        store.setPending(action, false);
        this._emitError({ code: 'ACK_TIMEOUT', message: `Sin confirmacion de "${action}"` });
        reject(new Error('ACK_TIMEOUT'));
      }, ACK_TIMEOUT_MS);
      this.pending.set(action, { resolve, reject, timer });
    });
  }

  /** Prueba una conexion a un host dado sin afectar la conexion actual. */
  test(host, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let url;
      try {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const clean = String(host || '').trim().replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
        url = clean ? `${proto}//${clean}/ws` : settings.wsUrl();
      } catch {
        resolve(false); return;
      }
      let done = false;
      let probe;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { probe && probe.close(); } catch { /* noop */ }
        resolve(ok);
      };
      try { probe = new WebSocket(url); } catch { resolve(false); return; }
      const t = setTimeout(() => finish(false), timeoutMs);
      probe.onopen = () => { clearTimeout(t); finish(true); };
      probe.onerror = () => { clearTimeout(t); finish(false); };
    });
  }

  isOpen() {
    return this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  onError(fn) { this.listeners.error.add(fn); return () => this.listeners.error.delete(fn); }
  onEvent(fn) { this.listeners.event.add(fn); return () => this.listeners.event.delete(fn); }

  // --- Interno --------------------------------------------------------------

  _open() {
    let url;
    try { url = settings.wsUrl(); }
    catch { url = `ws://${location.host}/ws`; }

    store.setConnection(this.attempts > 0 ? CONN.RECONNECTING : CONN.CONNECTING);

    let sock;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.socket = sock;

    sock.onopen = () => {
      this.attempts = 0;
      store.set({ reconnectAttempts: 0 });
      store.setConnection(CONN.CONNECTED);
      this._startPing();
      this._bumpStale();
      this._emitEvent({ type: 'open' });
    };

    sock.onmessage = (ev) => {
      this._bumpStale();
      const msg = parseMessage(ev.data);
      if (!msg) return;
      this._route(msg);
    };

    sock.onclose = () => {
      this._clearTimers();
      this._rejectAllPending('SIN_CONEXION');
      // El enlace con el Arduino ya no es observable si el socket cae.
      store.setLink(LINK.UNKNOWN);
      if (this.intentionalClose) {
        store.setConnection(CONN.DISCONNECTED);
        return;
      }
      this._scheduleReconnect();
    };

    sock.onerror = () => {
      // onclose se disparara a continuacion; aqui solo notificamos.
      this._emitError({ code: 'WS_ERROR', message: 'Error de WebSocket' });
    };
  }

  _route(msg) {
    switch (msg.type) {
      case 'telemetry': {
        const t = normalizeTelemetry(msg);
        store.setTelemetry(t);
        // Recibir telemetria implica enlace con el Arduino salvo aviso contrario.
        if (store.getState().link === LINK.UNKNOWN) store.setLink(LINK.OK);
        break;
      }
      case 'ack': {
        const p = this.pending.get(msg.action);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.action);
          store.setPending(msg.action, false);
          if (msg.ok === false) p.reject(new Error('ACK_NOK'));
          else p.resolve(msg);
        } else {
          // ack sin comando pendiente: posible desajuste de contrato con el
          // firmware (nombre de 'action' distinto al enviado). Lo registramos
          // para detectarlo en pruebas; el comando habría caído en ACK_TIMEOUT.
          console.warn('[ws] ack huérfano (sin pending):', msg.action);
        }
        break;
      }
      case 'status': {
        store.setLink(msg.link === 'arduino_ok' ? LINK.OK : LINK.LOST);
        break;
      }
      case 'error': {
        this._emitError({ code: msg.code || 'ERROR', message: msg.message || 'Error del dispositivo' });
        break;
      }
      case 'pong':
        break; // keepalive ok
      default:
        break;
    }
    this._emitEvent(msg);
  }

  _startPing() {
    this._clearPing();
    this.pingTimer = setInterval(() => {
      if (this.isOpen()) {
        try { this.socket.send(JSON.stringify({ type: 'ping' })); } catch { /* noop */ }
      }
    }, PING_INTERVAL_MS);
  }

  _bumpStale() {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      // Demasiado tiempo sin mensajes: forzamos reconexion.
      if (this.isOpen()) {
        try { this.socket.close(); } catch { /* noop */ }
      }
    }, STALE_MS);
  }

  _scheduleReconnect() {
    this.attempts += 1;
    store.set({ reconnectAttempts: this.attempts });
    if (this.attempts > MAX_ATTEMPTS) {
      store.setConnection(CONN.DISCONNECTED);
      this._emitError({ code: 'MAX_RETRIES', message: 'No se pudo reconectar. Reintenta manualmente.' });
      return;
    }
    store.setConnection(CONN.RECONNECTING);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.attempts - 1));
    this._clearReconnect();
    this.reconnectTimer = setTimeout(() => this._open(), delay);
  }

  _teardownSocket() {
    if (this.socket) {
      try {
        this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
        this.socket.close();
      } catch { /* noop */ }
      this.socket = null;
    }
  }

  _rejectAllPending(reason) {
    for (const [action, p] of this.pending) {
      clearTimeout(p.timer);
      store.setPending(action, false);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  _clearPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }
  _clearReconnect() { if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; } }
  _clearTimers() {
    this._clearPing();
    clearTimeout(this.staleTimer); this.staleTimer = null;
  }

  _emitError(err) {
    console.warn('[ws] error', err);
    for (const fn of this.listeners.error) { try { fn(err); } catch (e) { console.error(e); } }
  }
  _emitEvent(msg) {
    for (const fn of this.listeners.event) { try { fn(msg); } catch (e) { console.error(e); } }
  }
}

export const ws = new WSClient();
