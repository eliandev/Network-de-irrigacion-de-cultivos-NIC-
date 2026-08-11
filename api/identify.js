/**
 * NIC — Función serverless (Vercel) de reconocimiento de plantas por foto.
 * Usa la API de Groq (GroqCloud, nivel gratuito real, sin tarjeta) con un modelo
 * de visión (Llama 4). La clave vive en Vercel como GROQ_API_KEY y NUNCA se
 * expone al navegador. fetch nativo (Node 18+) — sin dependencias.
 *
 * ¿Por qué Groq? Gratis sin tarjeta, server-side con una sola API key, sin
 * geo-bloqueo, y devuelve la ficha completa en una llamada (a diferencia de
 * Gemini, cuyo 403 "denied access" es un flag de cuenta sin solución rápida).
 *
 * Variables de entorno:
 *   GROQ_API_KEY  (obligatoria)  — clave gratis de https://console.groq.com/keys
 *   GROQ_MODEL    (opcional)     — modelo de visión; por defecto Llama 4 Scout.
 *                                  Groq rota modelos: si diera error, revisa
 *                                  https://console.groq.com/docs/models y ponlo aquí.
 */

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PRIMARY_MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const FALLBACK_MODEL = 'meta-llama/llama-4-maverick-17b-128e-instruct';

const SYSTEM = 'Eres un botánico experto. Respondes SIEMPRE con un único objeto JSON '
  + 'válido, sin texto adicional ni markdown.';

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

function buildBody(model, dataUrl) {
  return JSON.stringify({
    model,
    temperature: 0.2,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });
}

function callGroq(apiKey, model, dataUrl) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: buildBody(model, dataUrl),
  });
}

/** Parseo defensivo: quita cercos ```json y espacios antes de JSON.parse. */
function parseFicha(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
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
    let model = PRIMARY_MODEL;
    let upstream = await callGroq(apiKey, model, image);

    // Groq rota modelos: si el primario está retirado (400/404), probar el alterno.
    if ((upstream.status === 400 || upstream.status === 404) && model !== FALLBACK_MODEL) {
      model = FALLBACK_MODEL;
      upstream = await callGroq(apiKey, model, image);
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      const code = upstream.status === 429 ? 'rate_limited'
        : upstream.status === 401 ? 'unauthorized' : 'upstream';
      res.statusCode = upstream.status === 429 ? 429 : 502;
      res.end(JSON.stringify({ error: code, status: upstream.status, model, message: detail.slice(0, 500) }));
      return;
    }

    const payload = await upstream.json();
    const text = payload.choices && payload.choices[0]
      && payload.choices[0].message && payload.choices[0].message.content;
    if (!text) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'empty', message: 'Respuesta vacía del modelo.' }));
      return;
    }

    let ficha;
    try { ficha = parseFicha(text); }
    catch {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'parse', message: 'El modelo no devolvió JSON válido.' }));
      return;
    }

    // Saneo mínimo del resultado.
    if (Number.isFinite(Number(ficha.humedad_ideal_pct))) {
      ficha.humedad_ideal_pct = Math.max(0, Math.min(100, Math.round(Number(ficha.humedad_ideal_pct))));
    }
    if (!Array.isArray(ficha.cuidados)) ficha.cuidados = [];

    res.statusCode = 200;
    res.end(JSON.stringify({ ficha, source: 'ai' }));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'exception', message: String(err && err.message || err) }));
  }
}
