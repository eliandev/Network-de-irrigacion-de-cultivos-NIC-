/**
 * NIC — Función serverless (Vercel) de reconocimiento de plantas por foto.
 * Usa la API de Google Gemini (nivel gratuito de Google AI Studio) con visión y
 * salida JSON estructurada. La clave vive en Vercel como GEMINI_API_KEY y NUNCA
 * se expone al navegador.
 *
 * fetch nativo (Node 18+) — sin dependencias, así el deploy no requiere install.
 *
 * Variables de entorno:
 *   GEMINI_API_KEY  (obligatoria)  — clave gratis de https://aistudio.google.com
 *   GEMINI_MODEL    (opcional)     — modelo; por defecto 'gemini-2.0-flash'.
 *                                    Si tu cuenta usa otro modelo gratis (p. ej.
 *                                    'gemini-2.5-flash'), fíjalo aquí sin tocar código.
 */

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
    const url = `${API_BASE}/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'upstream', status: upstream.status, message: detail.slice(0, 500) }));
      return;
    }

    const payload = await upstream.json();

    // Bloqueo de seguridad / prompt bloqueado.
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
