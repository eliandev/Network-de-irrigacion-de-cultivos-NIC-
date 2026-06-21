# NIC — Network de Irrigación de Cultivos

PWA (Progressive Web App) para **control y monitoreo del sistema de riego automatizado** en la red local. Fase 1 (MVP) según el PRD.

La app se comunica por **WebSocket** con un **ESP8266** (puente WiFi ↔ Serial) que habla por UART con el **Arduino Uno** (lazo cerrado autónomo: sensor de humedad YL-69 + relé + bomba).

> Mientras no tengas el hardware, este repo incluye un **servidor mock del ESP8266** (Node, sin dependencias) que simula el Arduino para desarrollar y demostrar la app de inmediato.

---

## 🚀 Cómo ejecutarlo (demo con el mock)

Requisitos: **Node.js 18+** (probado en v24).

```bash
node server/mock-esp8266.js
# o:  npm run dev
```

Luego abre **http://localhost:8080** en el navegador (móvil o escritorio).
La PWA se sirve y abre automáticamente un WebSocket a `ws://localhost:8080/ws`.

No hay paso de *build* ni dependencias que instalar: es HTML/CSS/JS vanilla con ES modules.

---

## 🧱 Estructura del proyecto

```
NIC/
├── server/
│   └── mock-esp8266.js      Simula ESP8266 (HTTP estático + WebSocket) y el Arduino en lazo cerrado
├── web/                     <-- ESTO es lo que va al ESP8266 (LittleFS) en producción
│   ├── index.html           App shell (barra, banner, vistas, navegación de 5 pestañas)
│   ├── manifest.webmanifest Manifiesto PWA
│   ├── service-worker.js    Caché del app shell (uso offline)
│   ├── assets/              logo.svg, icon.svg (gota de agua con brote, azul→verde)
│   ├── css/styles.css       Sistema de diseño (tema NIC)
│   └── js/
│       ├── app.js           Bootstrap + router + shell (pill de conexión, banner, badge)
│       ├── store.js         Estado central reactivo (pub/sub)
│       ├── protocol.js      Constantes, conversiones y (de)serialización JSON
│       ├── ws-client.js     WebSocket: reconexión, keepalive, ack, máquina de estados
│       ├── settings.js      Preferencias (host/IP, notificaciones…) en localStorage
│       ├── history.js       Historial de humedad en IndexedDB (24 h)
│       ├── alerts.js        Generación de alertas + notificaciones del navegador
│       ├── ui.js            Toasts + diálogo de confirmación
│       └── screens/         dashboard · monitoreo · control · alertas · ajustes
└── package.json
```

---

## 📡 Protocolo (JSON sobre WebSocket)

Coincide con el PRD §6.4. Implementado en `web/js/protocol.js` y `server/mock-esp8266.js`.

**Telemetría — ESP → App** (~1 Hz):
```json
{ "type":"telemetry", "humidity_raw":540, "humidity_pct":47, "pump":"off",
  "mode":"auto", "threshold":721, "manual_remaining_s":0, "ts":1718970000 }
```

**Comando — App → ESP → Arduino:**
```json
{ "type":"command", "action":"pump_on",  "duration_s":1200 }
{ "type":"command", "action":"pump_off" }
{ "type":"command", "action":"set_mode", "value":"auto" }
{ "type":"command", "action":"set_threshold", "value":700 }
```

**Confirmación / estado — ESP → App:**
```json
{ "type":"ack",    "action":"pump_on", "ok":true }
{ "type":"status", "link":"arduino_ok" }
{ "type":"error",  "code":"ARDUINO_TIMEOUT", "message":"Sin respuesta del Arduino" }
```

**Keepalive:** la app envía `{ "type":"ping" }` cada ~5 s; el dispositivo responde `{ "type":"pong" }`.
Si no llegan mensajes durante ~8 s, la app fuerza una reconexión (backoff exponencial, máx. 10 s).

### Conversión de humedad
```
humidity_pct = round( (1023 - humidity_raw) / 1023 * 100 )
```
El umbral se maneja internamente en unidades ADC (compatible con el firmware actual, default **721**) y se muestra también en %.

---

## 🖥️ Pantallas (MVP)

| Pestaña | Contenido |
|---|---|
| **Inicio** | Estado del sistema, humedad (gauge), bomba/modo, alertas recientes, acceso a riego manual. Nivel de agua / Clima / Próximo riego como **"Próximamente"**. |
| **Monitoreo** | Humedad en vivo, sparkline del historial (IndexedDB, 24 h), estado del enlace con el Arduino, limpiar historial. |
| **Control** | Riego manual ON/OFF con duración + confirmación + cuenta regresiva; modo Automático/Manual; ajuste de umbral. Horarios como **"Próximamente"**. |
| **Alertas** | Lista in-app, activar notificaciones del navegador, marcar leídas / limpiar. |
| **Ajustes** | Host/IP + probar conexión, preferencias de notificación, unidades/idioma, info del dispositivo. |

---

## 🔒 Seguridad / failsafe (responsabilidad del firmware)

La app **nunca** es responsable de la seguridad del riego:

- El **Arduino sigue regando por umbral** aunque la app esté cerrada o desconectada (lazo cerrado autónomo).
- El **riego manual tiene un temporizador de seguridad** en el Arduino: la bomba se apaga sola al vencer la duración, aunque se pierda la conexión.

El mock implementa ambos comportamientos para poder demostrarlos.

---

## 🚢 Despliegue al ESP8266 (producción, resumen)

1. El firmware del ESP8266 (modo estación, STA) se une al router y publica `riego.local` por **mDNS**.
2. Sube el contenido de `web/` a **LittleFS** y sírvelo por HTTP; expón el WebSocket en `/ws`.
3. La PWA detecta el host automáticamente (mismo origen). Si `riego.local` no resuelve, fija la **IP manual** en **Ajustes**.
4. ⚠️ **Hardware:** la línea **TX Arduino (5 V) → RX ESP (3.3 V)** requiere **divisor de voltaje** o conversor de nivel.

> **Flujo recomendado de cambios:** rama → pull request → *preview* → QA → revisión → producción. No editar el firmware en producción directamente.

---

## ⚙️ Decisiones de diseño / supuestos

- **Sin build, sin dependencias** en la web: maximiza compatibilidad y reduce el peso en LittleFS (memoria limitada del ESP8266).
- **WebSocket** (no Bluetooth): funciona en cualquier navegador moderno, incluido iOS.
- **Sin autenticación** en esta fase (operación solo en red local) — riesgo aceptado documentado en el PRD (RNF-06).
- Historial **local** (IndexedDB), retención 24 h, 1 muestra/~15 s.
- Idioma **español**; estructura preparada para i18n (Fase 2).

---

## 🧪 Pruebas rápidas (con el mock)

- Deja el sistema en **Automático** y observa cómo la bomba se enciende cuando el suelo se seca (ADC > umbral) y se apaga al humedecerse.
- En **Control**, activa un **riego manual** corto (p. ej. 1 min) y observa la cuenta regresiva; detén el mock (Ctrl+C) durante el riego para comprobar el **failsafe** (la bomba se apagaría sola en el Arduino real al vencer el temporizador).
- Baja la **humedad crítica** en Ajustes para forzar una **alerta**.
- Detén el mock para ver el **banner "Sin conexión"** y la **reconexión** automática al reiniciarlo.
