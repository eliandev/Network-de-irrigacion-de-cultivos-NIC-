/**
 * NIC — Función serverless (Vercel) de reconocimiento de plantas por foto.
 * Recibe una imagen (base64) y llama a la API de Claude (vision) para devolver
 * una ficha estructurada de la especie. La clave vive en Vercel como variable
 * de entorno ANTHROPIC_API_KEY y NUNCA se expone al navegador.
 *
 * Usa fetch nativo (Node 18+) — sin dependencias, así el deploy no requiere
 * `npm install`. Structured outputs garantiza que la respuesta sea el JSON.
 */

// Haiku 4.5: tiene visión y soporta structured outputs; ~5× más barato que Opus 5
// (≈ medio centavo por identificación). Suficiente para reconocer plantas.
const MODEL = 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

// Esquema de la ficha (structured outputs: sin min/max; enum/integer/array OK).
const FICHA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'es_planta', 'nombre_comun', 'nombre_cientifico', 'descripcion',
    'frecuencia_riego', 'humedad_ideal_pct', 'luz', 'cuidados', 'confianza',
  ],
  properties: {
    es_planta: { type: 'boolean' },
    nombre_comun: { type: 'string' },
    nombre_cientifico: { type: 'string' },
    descripcion: { type: 'string' },
    frecuencia_riego: { type: 'string' },
    humedad_ideal_pct: { type: 'integer' },
    luz: { type: 'string' },
    cuidados: { type: 'array', items: { type: 'string' } },
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
  },
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.statusCode = 501;
    res.end(JSON.stringify({ error: 'not_configured', message: 'Falta ANTHROPIC_API_KEY en Vercel.' }));
    return;
  }

  let image; let mediaType;
  try {
    const data = await readJson(req);
    image = String(data.image || '');
    mediaType = String(data.mediaType || 'image/jpeg');
    // Acepta data URLs ("data:image/jpeg;base64,....") o base64 puro.
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
    const upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        // Sin 'thinking': en Haiku 4.5 el razonamiento está desactivado por
        // defecto al omitirlo (rápido y económico para clasificar).
        output_config: { format: { type: 'json_schema', schema: FICHA_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'upstream', status: upstream.status, message: detail.slice(0, 500) }));
      return;
    }

    const payload = await upstream.json();
    if (payload.stop_reason === 'refusal') {
      res.statusCode = 200;
      res.end(JSON.stringify({ error: 'refusal', message: 'No fue posible analizar la imagen.' }));
      return;
    }

    const textBlock = (payload.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'empty', message: 'Respuesta vacía del modelo.' }));
      return;
    }

    const ficha = JSON.parse(textBlock.text);
    res.statusCode = 200;
    res.end(JSON.stringify({ ficha, source: 'ai' }));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'exception', message: String(err && err.message || err) }));
  }
}
