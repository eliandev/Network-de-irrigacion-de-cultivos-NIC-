/**
 * NIC — Función serverless (Vercel) de reconocimiento de plantas por foto.
 * Usa la API de Groq (GroqCloud, nivel gratuito real, sin tarjeta) con un modelo
 * de visión (Qwen3.6-27B; con respaldos automáticos por si Groq lo rota). La
 * clave vive en Vercel como GROQ_API_KEY y NUNCA se expone al navegador.
 * fetch nativo (Node 18+) — sin dependencias.
 *
 * ¿Por qué Groq? Gratis sin tarjeta, server-side con una sola API key, sin
 * geo-bloqueo, y devuelve la ficha completa en una llamada (a diferencia de
 * Gemini, cuyo 403 "denied access" es un flag de cuenta sin solución rápida).
 *
 * IMPORTANTE (qwen3): es un modelo con modo "thinking". Con imágenes reales
 * (complejas) puede razonar y, bajo JSON mode con poco presupuesto de tokens,
 * agotar el budget DENTRO del razonamiento y no emitir JSON -> Groq devuelve
 * code:'json_validate_failed' con failed_generation vacío. Por eso apagamos el
 * razonamiento (reasoning_effort:'none'), damos tokens holgados y aplicamos una
 * escalera de reintentos + parseo defensivo.
 *
 * Variables de entorno:
 *   GROQ_API_KEY  (obligatoria)  — clave gratis de https://console.groq.com/keys
 *   GROQ_MODEL    (opcional)     — fuerza un modelo de visión concreto. Por
 *                                  defecto se recorre una lista de candidatos
 *                                  (ver VISION_MODELS). Vigente en ago-2026:
 *                                  qwen/qwen3.6-27b — https://console.groq.com/docs/vision
 */

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Modelos de visión candidatos, en orden de preferencia. Groq DEPRECA modelos
// con frecuencia (los Llama 4 se apagaron a mediados de 2026), así que probamos
// en orden hasta que uno responda; el que funcione se cachea en la instancia
// caliente. GROQ_MODEL (si se define) se prueba primero. Si TODOS fallaran,
// mira el vigente en https://console.groq.com/docs/vision y ponlo aquí o en
// GROQ_MODEL sin tocar más código. (Nota: los modelos gpt-oss NO valen: son de
// solo texto, no "ven" imágenes.)
const VISION_MODELS = [
  'qwen/qwen3.6-27b',                               // vigente (ago-2026): multimodal + JSON
  'meta-llama/llama-4-scout-17b-16e-instruct',      // respaldo (deprecado)
  'meta-llama/llama-4-maverick-17b-128e-instruct',  // respaldo (deprecado)
  'llama-3.2-90b-vision-preview',                   // respaldo histórico
  'llama-3.2-11b-vision-preview',                   // respaldo histórico
];

// Escalera de intentos por modelo. Cada peldaño endurece la config para vencer
// el "thinking" de qwen3: (1) JSON mode con presupuesto amplio; (2) más tokens,
// prompt reforzado y temperatura más baja; (3) SIN response_format, parseando el
// texto libre (último recurso). En todos apagamos el razonamiento.
const ATTEMPTS = [
  { maxTokens: 2048, temperature: 0.2, jsonMode: true,  strictStart: false },
  { maxTokens: 4096, temperature: 0.1, jsonMode: true,  strictStart: true },
  { maxTokens: 4096, temperature: 0.1, jsonMode: false, strictStart: true },
];

// Modelo que respondió OK en esta instancia caliente (evita reintentar 404s).
let cachedModel = null;

/** Lista de modelos a intentar: GROQ_MODEL → cache → catálogo, sin duplicar. */
function candidateModels() {
  const list = [];
  if (process.env.GROQ_MODEL) list.push(process.env.GROQ_MODEL);
  if (cachedModel && !list.includes(cachedModel)) list.push(cachedModel);
  for (const m of VISION_MODELS) if (!list.includes(m)) list.push(m);
  return list;
}

/** ¿El error de Groq indica "modelo inexistente/retirado" (probar el siguiente)? */
function isModelError(status, detail) {
  if (status !== 404 && status !== 400) return false;
  return /does not exist|not_found|decommission|deprecat|no longer|do not have access/i.test(detail || '');
}

/** ¿Groq no pudo validar el JSON (síntoma del razonamiento que agota el budget)? */
function isJsonValidateFailed(status, detail) {
  return status === 400 && /json_validate_failed|validate json/i.test(detail || '');
}

/** ¿Groq rechazó un parámetro de razonamiento (reintentar el intento sin ellos)? */
function isReasoningParamError(status, detail) {
  return status === 400
    && /reasoning_effort|reasoning_format|unknown parameter|unrecognized|unsupported parameter/i.test(detail || '');
}

const SYSTEM = 'Eres un botánico experto. Respondes SIEMPRE con un único objeto JSON '
  + 'válido, sin texto adicional ni markdown.';

const STRICT_SUFFIX = ' Empieza tu respuesta directamente con «{» y termínala con «}». '
  + 'No incluyas absolutamente nada fuera del objeto JSON (ni razonamiento, ni ```).';

const PROMPT = [
  'Identifica la planta de la foto y devuelve un objeto JSON con EXACTAMENTE estas claves:',
  '"es_planta" (boolean), "nombre_comun" (string), "nombre_cientifico" (string),',
  '"descripcion" (string breve con usos/características), "frecuencia_riego" (string),',
  '"humedad_ideal_pct" (entero 0–100, humedad de suelo ideal), "luz" (string),',
  '"cuidados" (array de 2 a 4 strings) y "confianza" ("alta" | "media" | "baja").',
  'Todo en español. Si la imagen NO muestra una planta, pon es_planta=false,',
  'confianza="baja", humedad_ideal_pct=0, cuidados=[] y el resto con "—".',
  'Responde solo con el JSON.',
].join(' ');

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Construye el body de la Chat Completions de Groq para un intento concreto. */
function buildBody(model, dataUrl, opts) {
  const o = opts || {};
  const body = {
    model,
    temperature: o.temperature != null ? o.temperature : 0.2,
    max_tokens: o.maxTokens || 2048,
    messages: [
      { role: 'system', content: SYSTEM + (o.strictStart ? STRICT_SUFFIX : '') },
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };
  // Apaga el razonamiento para que no se coma el presupuesto de tokens.
  // qwen3 solo acepta 'none' | 'default'. 'hidden' deja el content limpio y es
  // compatible con json_object (a diferencia de 'raw'). Se omiten si Groq los
  // rechazara (ver isReasoningParamError -> reintento con noReasoning).
  if (!o.noReasoning) {
    body.reasoning_effort = 'none';
    body.reasoning_format = 'hidden';
  }
  // JSON mode: garantiza JSON sintáctico. qwen NO soporta json_schema/strict
  // (solo gpt-oss), enviarlo dispararía json_validate_failed.
  if (o.jsonMode) body.response_format = { type: 'json_object' };
  return JSON.stringify(body);
}

function callGroq(apiKey, model, dataUrl, opts) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: buildBody(model, dataUrl, opts),
  });
}

/**
 * Parseo defensivo: quita razonamiento <think>…</think>, cercos ```json y, si
 * hace falta, rescata el primer objeto {…} balanceado antes de JSON.parse.
 */
function parseFicha(text) {
  let t = String(text || '').trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); // por si colara el razonamiento
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (t[0] !== '{') {
    const m = t.match(/\{[\s\S]*\}/); // rescata el objeto si viene con texto alrededor
    if (m) t = m[0];
  }
  return JSON.parse(t);
}

function sendError(res, httpStatus, code, message, upstreamStatus, model) {
  res.statusCode = httpStatus;
  res.end(JSON.stringify({ error: code, status: upstreamStatus || 0, model: model || null, message }));
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Usa POST' }));
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.statusCode = 501;
    res.end(JSON.stringify({ error: 'not_configured', message: 'Falta GROQ_API_KEY en Vercel.' }));
    return;
  }

  let image; let mediaType;
  try {
    const data = await readJson(req);
    image = String(data.image || '');
    mediaType = String(data.mediaType || 'image/jpeg');
    // La API espera un data URL completo; lo reconstruimos si vino base64 puro.
    if (!/^data:/.test(image) && image) image = `data:${mediaType};base64,${image}`;
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'bad_request', message: 'Cuerpo JSON inválido.' }));
    return;
  }

  if (!image) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'bad_request', message: 'Falta la imagen.' }));
    return;
  }

  try {
    const models = candidateModels();
    let lastStatus = 0; let lastDetail = ''; let lastModel = models[0];

    for (let mi = 0; mi < models.length; mi += 1) {
      const model = models[mi]; lastModel = model;
      let modelGone = false;

      for (let ai = 0; ai < ATTEMPTS.length; ai += 1) {
        const opts = ATTEMPTS[ai];
        let r = await callGroq(apiKey, model, image, opts);
        let detail = r.ok ? '' : await r.text().catch(() => '');

        // Groq rechazó un parámetro de razonamiento -> reintenta el MISMO peldaño sin ellos.
        if (!r.ok && isReasoningParamError(r.status, detail)) {
          r = await callGroq(apiKey, model, image, { ...opts, noReasoning: true });
          detail = r.ok ? '' : await r.text().catch(() => '');
        }

        // Modelo retirado -> salta al siguiente modelo candidato.
        if (!r.ok && isModelError(r.status, detail)) { modelGone = true; break; }

        if (!r.ok) {
          lastStatus = r.status; lastDetail = detail;
          // 401/429 no se arreglan reintentando: repórtalos ya.
          if (r.status === 401) { sendError(res, 502, 'unauthorized', detail.slice(0, 500), r.status, model); return; }
          if (r.status === 429) { sendError(res, 429, 'rate_limited', detail.slice(0, 500), r.status, model); return; }
          // json_validate_failed u otros: escala la escalera si aún quedan peldaños.
          if (ai < ATTEMPTS.length - 1) continue;
          const code = isJsonValidateFailed(r.status, detail) ? 'json_failed' : 'upstream';
          sendError(res, 502, code, detail.slice(0, 500), r.status, model);
          return;
        }

        // Respuesta OK: extrae el content y verifica que no venga vacío/truncado.
        const payload = await r.json().catch(() => null);
        const choice = payload && payload.choices && payload.choices[0];
        const finish = choice && choice.finish_reason;
        const text = choice && choice.message && choice.message.content;

        // Vacío o truncado por 'length' = razonamiento se comió el budget: sube tokens.
        if ((!text || finish === 'length') && ai < ATTEMPTS.length - 1) {
          lastStatus = 200; lastDetail = `content vacío/truncado (finish=${finish})`;
          continue;
        }
        if (!text) {
          sendError(res, 502, 'empty', 'Respuesta vacía del modelo (posible razonamiento truncado).', 200, model);
          return;
        }

        let ficha;
        try { ficha = parseFicha(text); }
        catch {
          if (ai < ATTEMPTS.length - 1) { lastStatus = 200; lastDetail = 'JSON no parseable'; continue; }
          sendError(res, 502, 'parse', 'El modelo no devolvió JSON válido.', 200, model);
          return;
        }

        // Éxito. Saneo mínimo y responde.
        cachedModel = model;
        if (Number.isFinite(Number(ficha.humedad_ideal_pct))) {
          ficha.humedad_ideal_pct = Math.max(0, Math.min(100, Math.round(Number(ficha.humedad_ideal_pct))));
        }
        if (!Array.isArray(ficha.cuidados)) ficha.cuidados = [];
        res.statusCode = 200;
        res.end(JSON.stringify({ ficha, source: 'ai', model }));
        return;
      }

      if (!modelGone) break; // el modelo respondió pero agotó la escalera: no pruebes otros
    }

    // Todos los modelos candidatos estaban retirados / inaccesibles.
    sendError(res, 502, 'no_model',
      'Ningún modelo de visión de Groq está disponible. Revisa el vigente en https://console.groq.com/docs/vision y ponlo en GROQ_MODEL.',
      lastStatus, lastModel);
  } catch (err) {
    sendError(res, 502, 'exception', String(err && err.message || err), 0, null);
  }
}
