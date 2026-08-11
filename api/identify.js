/**
 * NIC — Función serverless (Vercel) de reconocimiento de plantas por foto.
 * Usa la API de Google Gemini (nivel gratuito de Google AI Studio) con visión y
 * salida JSON estructurada. La clave vive en Vercel como GEMINI_API_KEY y NUNCA
 * se expone al navegador.
 *
 * Resiliente a cambios de modelo: si el modelo configurado ya no existe (404),
 * consulta la lista de modelos de la cuenta y elige automáticamente uno "flash"
 * que soporte generateContent — así no hay que editar código cuando Google rota
 * los nombres de modelo.
 *
 * fetch nativo (Node 18+) — sin dependencias.
 *
 * Variables de entorno:
 *   GEMINI_API_KEY  (obligatoria)  — clave gratis de https://aistudio.google.com
 *   GEMINI_MODEL    (opcional)     — fuerza un modelo concreto (p. ej. 'gemini-2.5-flash').
 *                                    Si se omite, se intenta 'gemini-flash-latest' y,
 *                                    si no existe, se autodetecta uno disponible.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

// Cache del modelo resuelto mientras la instancia serverless siga "caliente".
let RESOLVED_MODEL = null;

// Esquema para structured outputs de Gemini (tipos en MAYÚSCULAS; sin additionalProperties).
const FICHA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    es_planta: { type: 'BOOLEAN' },
    nombre_comun: { type: 'STRING' },
    nombre_cientifico: { type: 'STRING' },
    descripcion: { type: 'STRING' },
    frecuencia_riego: { type: 'STRING' },
    humedad_ideal_pct: { type: 'INTEGER' },
    luz: { type: 'STRING' },
    cuidados: { type: 'ARRAY', items: { type: 'STRING' } },
    confianza: { type: 'STRING', enum: ['alta', 'media', 'baja'] },
  },
  required: [
    'es_planta', 'nombre_comun', 'nombre_cientifico', 'descripcion',
    'frecuencia_riego', 'humedad_ideal_pct', 'luz', 'cuidados', 'confianza',
  ],
};

const PROMPT = [
  'Identifica la planta que aparece en la foto y devuelve su ficha en español.',
  'Rellena todos los campos: nombre común y científico, una descripción breve',
  '(usos/características), la frecuencia de riego recomendada, la humedad de suelo',
  'ideal en porcentaje (0–100), el nivel de luz recomendado, 2–4 recomendaciones',
  'de cuidado y tu nivel de confianza (alta/media/baja).',
  'Si la imagen NO muestra una planta, pon es_planta=false, confianza="baja" y',
  'deja el resto de campos con "—" (humedad_ideal_pct=0, cuidados=[]).',
].join(' ');

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function buildBody(mediaType, image) {
  return JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mediaType, data: image } },
        { text: PROMPT },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: FICHA_SCHEMA,
    },
  });
}

function callModel(apiKey, model, body) {
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

/** Descubre un modelo "flash" disponible que soporte generateContent. */
async function discoverModel(apiKey) {
  const res = await fetch(`${API_BASE}?key=${encodeURIComponent(apiKey)}&pageSize=200`);
  if (!res.ok) return null;
  const j = await res.json();
  const names = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''));
  // Preferimos un "flash" estable (evitando previews/exp), luego cualquier flash, luego cualquier gemini.
  return names.find((n) => /flash/i.test(n) && !/(exp|preview|thinking)/i.test(n))
    || names.find((n) => /flash/i.test(n))
    || names.find((n) => /gemini/i.test(n))
    || names[0] || null;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Usa POST' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.statusCode = 501;
    res.end(JSON.stringify({ error: 'not_configured', message: 'Falta GEMINI_API_KEY en Vercel.' }));
    return;
  }

  let image; let mediaType;
  try {
    const data = await readJson(req);
    image = String(data.image || '');
    mediaType = String(data.mediaType || 'image/jpeg');
    const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (m) { mediaType = m[1]; image = m[2]; }
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
    const body = buildBody(mediaType, image);
    let model = RESOLVED_MODEL || DEFAULT_MODEL;
    let upstream = await callModel(apiKey, model, body);

    // Si el modelo no existe (retirado/renombrado), autodetectar y reintentar una vez.
    if (upstream.status === 404) {
      const picked = await discoverModel(apiKey);
      if (picked) {
        model = picked;
        RESOLVED_MODEL = picked;
        upstream = await callModel(apiKey, model, body);
      }
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'upstream', status: upstream.status, model, message: detail.slice(0, 500) }));
      return;
    }

    // Éxito: recordamos el modelo que funcionó para las próximas llamadas.
    RESOLVED_MODEL = model;
    const payload = await upstream.json();

    const blocked = payload.promptFeedback && payload.promptFeedback.blockReason;
    const cand = payload.candidates && payload.candidates[0];
    if (blocked || (cand && cand.finishReason === 'SAFETY')) {
      res.statusCode = 200;
      res.end(JSON.stringify({ error: 'refusal', message: 'No fue posible analizar la imagen.' }));
      return;
    }

    const text = cand && cand.content && cand.content.parts
      && cand.content.parts.map((p) => p.text || '').join('');
    if (!text) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'empty', message: 'Respuesta vacía del modelo.' }));
      return;
    }

    const ficha = JSON.parse(text);
    res.statusCode = 200;
    res.end(JSON.stringify({ ficha, source: 'ai' }));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'exception', message: String(err && err.message || err) }));
  }
}
