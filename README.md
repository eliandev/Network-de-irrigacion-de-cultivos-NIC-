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

## ☁️ Deploy en Vercel (demo pública)

La app está lista para desplegarse como **sitio estático** en Vercel — útil para mostrarla públicamente sin hardware.

> **Importante:** Vercel sirve por HTTPS y **no puede correr el servidor WebSocket**; además, desde Internet no se llega al ESP de tu red local. Por eso la app incluye un **modo demostración**: un simulador del Arduino que corre en el **propio navegador** (`web/js/simulator.js`) y alimenta la UI con datos realistas (humedad, riego auto/manual con failsafe, ack…). En un host público se activa **automáticamente** (aparece el badge **DEMO** en la barra). En tu red local sigue usando el WebSocket real del ESP.

### Pasos

**Opción A — CLI**
```bash
npm i -g vercel
vercel            # primera vez (responde las preguntas)
vercel --prod     # a producción
```

**Opción B — desde GitHub**
1. Sube este repo a GitHub.
2. vercel.com → *Add New… → Project* → importa el repo.
3. Framework preset: **Other**. Sin *build command*. Deploy.

La configuración ya está en [`vercel.json`](vercel.json): sirve `web/` como raíz y fija cabeceras correctas (service worker sin caché, tipo MIME del manifest y de los `.js`).

### 🤖 Antonio.ia (IA de plantas) — variable de entorno (opcional)
**Antonio.ia** es el nombre del asistente de reconocimiento de plantas por foto. Por dentro usa una **función serverless** ([`api/identify.js`](api/identify.js)) que llama a **Groq** (GroqCloud, gratis, **sin tarjeta**) con un modelo de visión (Qwen3.6-27B). Para activarlo en Vercel:

1. Crea una clave gratis en **[console.groq.com/keys](https://console.groq.com/keys)** (registro con email/Google, sin tarjeta).
2. **Project → Settings → Environment Variables** → añade `GROQ_API_KEY` con esa clave (Production + Preview).
3. *(Opcional)* Fuerza otro modelo con `GROQ_MODEL`. Por defecto la función recorre una lista de modelos de visión candidatos y usa el primero disponible (vigente ago-2026: `qwen/qwen3.6-27b`). Groq **depreca** modelos seguido: si todos fallaran, mira el vigente en [console.groq.com/docs/vision](https://console.groq.com/docs/vision) y ponlo en `GROQ_MODEL`.
4. Redespliega.

Límite gratis: ~30 peticiones/min y ~1000/día (suficiente para uso personal). Si no la configuras, el resto de la app funciona igual; solo la identificación mostrará "Antonio.ia no está configurado" (y en la demo local devuelve una ficha de ejemplo).

> **Nota:** los cuidados/humedad los genera el modelo (no una base botánica verificada), por eso la ficha incluye un nivel de **confianza** y un aviso.

### Origen de los datos (Ajustes → Conexión)
- **Automático** (por defecto): real en red local, demo en host público.
- **Hardware real (ESP32-S3):** fuerza el WebSocket real.
- **Demostración:** fuerza el simulador (para enseñar la UI en cualquier lugar).

> El **clima** (Open-Meteo) y **Antonio.ia** usan Internet. El **GPS** del navegador funciona porque Vercel sirve por HTTPS. La app es responsive: **panel admin con barra lateral en escritorio** y barra inferior en móvil.

---

## 🧱 Estructura del proyecto

```
NIC/
├── api/
│   └── identify.js          Función serverless (Vercel): IA de plantas por foto (Groq, Qwen3.6 vision)
├── server/
│   └── mock-esp8266.js      Simula el controlador (HTTP + WebSocket + /api/identify) para dev
├── web/                     <-- ESTO es lo que va al ESP32-S3 (LittleFS) en producción
│   ├── index.html           App shell (barra lateral + barra inferior, panel admin responsive)
│   ├── manifest.webmanifest Manifiesto PWA
│   ├── service-worker.js    Caché del app shell (uso offline)
│   ├── assets/              logo.svg, icon.svg (gota de agua con brote, azul→verde)
│   ├── css/styles.css       Sistema de diseño + layout de escritorio (panel admin)
│   └── js/
│       ├── app.js           Bootstrap + router + shell (pill, banner, badge DEMO)
│       ├── store.js         Estado central reactivo (pub/sub)
│       ├── protocol.js      Constantes, conversiones y (de)serialización JSON
│       ├── ws-client.js     WebSocket (o simulador): reconexión, keepalive, ack, estados
│       ├── simulator.js     "WebSocket falso" que simula el controlador (modo demo / Vercel)
│       ├── settings.js      Preferencias (host/IP, demo, sensores, planta…) en localStorage
│       ├── history.js       Historial de humedad en IndexedDB (24 h)
│       ├── irrigation.js    Historial de riegos + agua usada (detecta cada riego)
│       ├── alerts.js        Alertas (humedad, conexión, tanque) + notificaciones
│       ├── weather.js       Clima por ubicación (Open-Meteo, sin API key)
│       ├── plant.js         IA de plantas: captura foto + llama /api/identify
│       ├── icons.js         Set de íconos SVG outlined (sin emojis)
│       ├── ui.js            Toasts + diálogo de confirmación
│       └── screens/         dashboard · monitoreo · control · alertas · ajustes · planta
├── vercel.json              Config de despliegue en Vercel (estático + funciones)
└── package.json
```

## 🔌 Hardware

| Componente | Función |
|---|---|
| **ESP32-S3 Nano** (WiFi 2.4 GHz) | Controlador principal |
| **YL-69** (sonda resistiva) | Humedad del suelo (riego por umbral) |
| **DHT11 / KY-015** | Temperatura y humedad del aire |
| **HC-SR04** (ultrasónico) | Nivel del tanque de agua (distancia al agua) |
| **LDR** | Luz (ubicación de la planta) |
| Relé + bomba sumergible | Actuador de riego |

---

## 📡 Protocolo (JSON sobre WebSocket)

Coincide con el PRD §6.4. Implementado en `web/js/protocol.js` y `server/mock-esp8266.js`.

**Telemetría — controlador → App** (~1 Hz):
```json
{ "type":"telemetry", "humidity_raw":540, "humidity_pct":47, "pump":"off",
  "mode":"auto", "threshold":721, "manual_remaining_s":0, "ts":1718970000,
  "temp_c":24, "humidity_air":55, "water_pct":80, "light_pct":60 }
```
Los sensores extra (`temp_c` DHT11, `humidity_air` DHT11, `water_pct` HC-SR04, `light_pct` LDR)
son opcionales: si el firmware no los envía, la app oculta esas tarjetas.

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
