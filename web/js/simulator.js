/**
 * NIC — Simulador del dispositivo (modo demostración).
 * ---------------------------------------------------------------------------
 * Implementa un "WebSocket falso" (FakeSocket) con la MISMA interfaz que el
 * WebSocket nativo (readyState, onopen/onmessage/onclose/onerror, send, close)
 * y replica en el navegador la lógica de lazo cerrado del Arduino que vive en
 * server/mock-esp8266.js: humedad como caminata aleatoria, riego automático por
 * umbral, riego manual con failsafe, y los mensajes telemetry/ack/status/error.
 *
 * ¿Por qué? Para que la PWA funcione como DEMO en hosting estático (Vercel,
 * GitHub Pages…), donde no hay ESP8266 ni servidor WebSocket. El cliente
 * (ws-client.js) usa FakeSocket en lugar de WebSocket cuando está en modo demo;
 * el resto del código no cambia, porque los mensajes son idénticos.
 */

const ADC_MAX = 1023;
const FAILSAFE_MAX_S = 3600;
const OPEN_DELAY_MS = 60;     // simula el establecimiento de conexión
const REPLY_DELAY_MS = 20;    // latencia simulada: el ack llega DESPUÉS del send

export class FakeSocket {
  constructor() {
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    this.sim = { raw: 600, threshold: 721, mode: 'auto', manualUntil: 0 };
    this._tickTimer = null;
    this._openTimer = setTimeout(() => this._open(), OPEN_DELAY_MS);
  }

  _open() {
    this.readyState = 1; // OPEN
    if (this.onopen) this.onopen({});
    this._emit({ type: 'status', link: 'arduino_ok' });
    this._emit(this._telemetry());
    this._tickTimer = setInterval(() => this._tick(), 1000);
  }

  _emit(obj) {
    if (this.readyState === 1 && this.onmessage) {
      this.onmessage({ data: JSON.stringify(obj) });
    }
  }

  _pumpState(now) {
    if (this.sim.manualUntil > now) return 'on';
    if (this.sim.mode === 'auto') return this.sim.raw > this.sim.threshold ? 'on' : 'off';
    return 'off';
  }

  _telemetry() {
    const now = Date.now();
    const pump = this._pumpState(now);
    const manualRemaining = this.sim.manualUntil > now
      ? Math.ceil((this.sim.manualUntil - now) / 1000)
      : 0;
    return {
      type: 'telemetry',
      humidity_raw: this.sim.raw,
      humidity_pct: Math.round(((ADC_MAX - this.sim.raw) / ADC_MAX) * 100),
      pump,
      mode: this.sim.mode,
      threshold: this.sim.threshold,
      manual_remaining_s: manualRemaining,
      ts: Math.floor(now / 1000),
    };
  }

  _tick() {
    const now = Date.now();
    const pumping = this._pumpState(now) === 'on';
    const noise = (Math.random() - 0.5) * 6;
    if (pumping) this.sim.raw -= 22 + Math.random() * 20;  // regando => más húmedo
    else this.sim.raw += 2 + Math.random() * 8;            // secándose
    this.sim.raw = Math.max(0, Math.min(ADC_MAX, Math.round(this.sim.raw + noise)));
    if (this.sim.manualUntil && this.sim.manualUntil <= now) this.sim.manualUntil = 0; // failsafe
    this._emit(this._telemetry());
  }

  // --- Interfaz tipo WebSocket ---------------------------------------------
  send(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    // Respondemos de forma asíncrona para imitar la latencia de red: así el
    // ack llega DESPUÉS de que ws-client registre el comando pendiente.
    setTimeout(() => this._handle(msg), REPLY_DELAY_MS);
  }

  _handle(msg) {
    if (this.readyState !== 1) return;
    if (msg.type === 'ping') { this._emit({ type: 'pong', ts: Math.floor(Date.now() / 1000) }); return; }
    if (msg.type !== 'command') return;

    const now = Date.now();
    switch (msg.action) {
      case 'pump_on': {
        const dur = Math.max(1, Math.min(FAILSAFE_MAX_S, Number(msg.duration_s) || 1200));
        this.sim.manualUntil = now + dur * 1000;
        this._ack('pump_on');
        break;
      }
      case 'pump_off':
        this.sim.manualUntil = 0;
        this._ack('pump_off');
        break;
      case 'set_mode':
        if (msg.value === 'auto' || msg.value === 'manual') {
          this.sim.mode = msg.value;
          if (msg.value === 'auto') this.sim.manualUntil = 0;
          this._ack('set_mode');
        } else {
          this._emit({ type: 'error', code: 'BAD_VALUE', message: 'Modo inválido' });
        }
        break;
      case 'set_threshold': {
        const v = Number(msg.value);
        if (Number.isFinite(v) && v >= 0 && v <= ADC_MAX) {
          this.sim.threshold = Math.round(v);
          this._ack('set_threshold');
        } else {
          this._emit({ type: 'error', code: 'BAD_VALUE', message: 'Umbral fuera de rango' });
        }
        break;
      }
      default:
        this._emit({ type: 'error', code: 'UNKNOWN_ACTION', message: `Acción desconocida: ${msg.action}` });
    }
    this._emit(this._telemetry()); // feedback inmediato tras el comando
  }

  _ack(action) { this._emit({ type: 'ack', action, ok: true }); }

  close() {
    this.readyState = 3; // CLOSED
    if (this._openTimer) { clearTimeout(this._openTimer); this._openTimer = null; }
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this.onclose) this.onclose({});
  }
}
