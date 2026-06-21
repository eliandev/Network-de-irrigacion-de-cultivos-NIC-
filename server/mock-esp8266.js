/**
 * NIC — Servidor mock del ESP8266 (sin dependencias externas).
 * --------------------------------------------------------------
 * Simula al ESP8266 + Arduino Uno en lazo cerrado para poder
 * desarrollar y demostrar la PWA SIN el hardware real.
 *
 *   - Sirve los archivos estaticos de la PWA (carpeta /web) por HTTP.
 *   - Expone un servidor WebSocket en la ruta /ws (RFC 6455, hecho a mano).
 *   - Simula el control de riego de lazo cerrado del Arduino:
 *        * humedad como caminata aleatoria (el suelo se seca / se humedece),
 *        * riego automatico por umbral (ADC),
 *        * riego manual con temporizador de seguridad (failsafe),
 *        * mensajes telemetry / ack / status / error igual que el PRD.
 *
 * Uso:   node server/mock-esp8266.js
 * Luego: abrir http://localhost:8080 en el navegador.
 *
 * NOTA: este archivo es solo para desarrollo/demo. En produccion la PWA
 * vive en el ESP8266 (LittleFS) y el WebSocket lo expone el firmware del ESP.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HOST = process.env.HOST || '0.0.0.0';

// ---------------------------------------------------------------------------
// Estado simulado del Arduino (lazo cerrado)
// ---------------------------------------------------------------------------
const ADC_MAX = 1023;
const FAILSAFE_MAX_S = 3600; // tope absoluto del temporizador de seguridad

const sim = {
  raw: 600,            // lectura ADC del YL-69 (0..1023; mas seco => mayor)
  threshold: 721,      // umbral de activacion del riego automatico (ADC)
  mode: 'auto',        // 'auto' | 'manual'
  manualUntil: 0,      // epoch(ms) hasta el que dura el riego manual (failsafe)
  linkOk: true,        // enlace ESP <-> Arduino
};

/** Devuelve el estado de la bomba derivado del estado del sistema. */
function pumpState(now) {
  if (sim.manualUntil > now) return 'on';        // riego manual activo
  if (sim.mode === 'auto') return sim.raw > sim.threshold ? 'on' : 'off';
  return 'off';                                  // modo manual sin riego activo
}

/** Avanza la fisica del suelo un paso (~1 s). */
function stepPhysics(now) {
  const pumping = pumpState(now) === 'on';
  const noise = (Math.random() - 0.5) * 6;
  if (pumping) {
    sim.raw -= 22 + Math.random() * 20; // regando => suelo mas humedo (raw baja)
  } else {
    sim.raw += 2 + Math.random() * 8;   // secandose => raw sube
  }
  sim.raw = Math.max(0, Math.min(ADC_MAX, Math.round(sim.raw + noise)));
}

function buildTelemetry() {
  const now = Date.now();
  const pump = pumpState(now);
  const manualRemaining = sim.manualUntil > now
    ? Math.ceil((sim.manualUntil - now) / 1000)
    : 0;
  return {
    type: 'telemetry',
    humidity_raw: sim.raw,
    humidity_pct: Math.round(((ADC_MAX - sim.raw) / ADC_MAX) * 100),
    pump,
    mode: sim.mode,
    threshold: sim.threshold,
    manual_remaining_s: manualRemaining,
    ts: Math.floor(now / 1000),
  };
}

// ---------------------------------------------------------------------------
// HTTP estatico (sirve la PWA desde /web)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    // Evitar path traversal.
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(WEB_DIR, safe);
    if (!filePath.startsWith(WEB_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // Fallback SPA: servir index.html para rutas desconocidas.
      filePath = path.join(WEB_DIR, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('404 — recurso no encontrado. ¿Construiste la carpeta /web?');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Error del servidor: ' + err.message);
  }
}

const server = http.createServer(serveStatic);

// ---------------------------------------------------------------------------
// WebSocket (RFC 6455) implementado a mano — solo frames de texto pequeños
// ---------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

server.on('upgrade', (req, socket) => {
  if ((req.url || '').split('?')[0] !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  clients.add(socket);
  console.log(`[ws] cliente conectado (${clients.size} activo/s)`);

  // Estado de bienvenida.
  sendText(socket, JSON.stringify({ type: 'status', link: sim.linkOk ? 'arduino_ok' : 'arduino_lost' }));
  sendText(socket, JSON.stringify(buildTelemetry()));

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let frame;
    while ((frame = decodeFrame(buffer)) && frame.complete) {
      buffer = buffer.subarray(frame.totalLength);
      handleFrame(socket, frame);
    }
  });

  const cleanup = () => {
    if (clients.delete(socket)) {
      console.log(`[ws] cliente desconectado (${clients.size} activo/s)`);
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

function handleFrame(socket, frame) {
  if (frame.opcode === 0x8) { // close
    try { socket.end(encodeFrame(Buffer.alloc(0), 0x8)); } catch { /* noop */ }
    clients.delete(socket);
    return;
  }
  if (frame.opcode === 0x9) { // ping -> pong
    sendRaw(socket, encodeFrame(frame.payload, 0xA));
    return;
  }
  if (frame.opcode === 0xA) return; // pong, ignorar
  if (frame.opcode === 0x1) {       // texto
    const text = frame.payload.toString('utf8');
    let msg;
    try { msg = JSON.parse(text); }
    catch {
      sendText(socket, JSON.stringify({ type: 'error', code: 'BAD_JSON', message: 'Mensaje no es JSON valido' }));
      return;
    }
    handleMessage(socket, msg);
  }
}

function handleMessage(socket, msg) {
  if (msg.type === 'ping') { // ping a nivel de aplicacion (keepalive del cliente)
    sendText(socket, JSON.stringify({ type: 'pong', ts: Math.floor(Date.now() / 1000) }));
    return;
  }
  if (msg.type !== 'command') return;

  const now = Date.now();
  switch (msg.action) {
    case 'pump_on': {
      const dur = Math.max(1, Math.min(FAILSAFE_MAX_S, Number(msg.duration_s) || 1200));
      sim.manualUntil = now + dur * 1000;
      ack(socket, 'pump_on');
      break;
    }
    case 'pump_off':
      sim.manualUntil = 0;
      ack(socket, 'pump_off');
      break;
    case 'set_mode':
      if (msg.value === 'auto' || msg.value === 'manual') {
        sim.mode = msg.value;
        if (msg.value === 'auto') sim.manualUntil = 0;
        ack(socket, 'set_mode');
      } else {
        sendText(socket, JSON.stringify({ type: 'error', code: 'BAD_VALUE', message: 'Modo invalido' }));
      }
      break;
    case 'set_threshold': {
      const v = Number(msg.value);
      if (Number.isFinite(v) && v >= 0 && v <= ADC_MAX) {
        sim.threshold = Math.round(v);
        ack(socket, 'set_threshold');
      } else {
        sendText(socket, JSON.stringify({ type: 'error', code: 'BAD_VALUE', message: 'Umbral fuera de rango' }));
      }
      break;
    }
    default:
      sendText(socket, JSON.stringify({ type: 'error', code: 'UNKNOWN_ACTION', message: `Accion desconocida: ${msg.action}` }));
  }
  // Tras un comando, emitir telemetria inmediata para feedback rapido.
  broadcast(buildTelemetry());
}

function ack(socket, action) {
  sendText(socket, JSON.stringify({ type: 'ack', action, ok: true }));
}

// --- Codec WebSocket -------------------------------------------------------
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset)); offset += 8;
  }
  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { fin, opcode, payload, totalLength: offset + len, complete: true };
}

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendRaw(socket, frame) {
  try { socket.write(frame); } catch { /* socket cerrado */ }
}
function sendText(socket, text) {
  sendRaw(socket, encodeFrame(Buffer.from(text, 'utf8'), 0x1));
}
function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const c of clients) sendText(c, text);
}

// ---------------------------------------------------------------------------
// Bucle de simulacion: ~1 Hz de fisica + telemetria
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  stepPhysics(now);
  if (sim.manualUntil && sim.manualUntil <= now) {
    // El temporizador de seguridad vencio: la bomba se apaga sola (failsafe).
    sim.manualUntil = 0;
  }
  broadcast(buildTelemetry());
}, 1000);

server.listen(PORT, HOST, () => {
  console.log('NIC — servidor mock del ESP8266');
  console.log(`  HTTP/PWA : http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log('  Ctrl+C para detener.');
});
