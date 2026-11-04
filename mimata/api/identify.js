/**
 * MiMata — Función serverless (Vercel) de identificación de plantas por foto.
 * Usa la API de Claude (visión + salidas estructuradas) con el SDK oficial
 * @anthropic-ai/sdk. La clave vive en Vercel como ANTHROPIC_API_KEY y NUNCA se
 * expone al navegador. NIC sigue con su propia función (../../api/identify.js, Groq).
 *
 * Las salidas estructuradas garantizan que la respuesta cumpla FICHA_SCHEMA, así
 * que no hacen falta reintentos ni parseo defensivo. Lo que el esquema no puede
 * expresar (rangos numéricos, cuántos cuidados) va en el prompt y se sanea al final.
 *
 * Variables de entorno:
 *   ANTHROPIC_API_KEY  (obligatoria) — clave de https://platform.claude.com/settings/keys,
 *                                      creada para un workspace concreto.
 *   ANTHROPIC_MODEL    (opcional)    — por defecto claude-opus-5-5. Más barato:
 *                                      claude-haiku-5-5.
 *
 * En local, server/mock-esp8266.js llama a esta misma función cuando encuentra la
 * clave en mimata/.env.local o mimata/.env (ver mimata/.env.example).
 */

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-5-5';

// Modelos con respaldo del lado del servidor si un clasificador de seguridad
// rechaza la petición (fallbacks: "default"). Haiku 5.5 no lo tiene.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_B64 = 10 * 1024 * 1024; // límite de la API por imagen (en base64)

// La foto llega reducida a 1024 px, así que la respuesta tarda pocos segundos.
// 20 s por intento y un reintento (~40 s en el peor caso) quedan por debajo de
// los 45 s que espera el navegador (TIMEOUT_MS en public/js/identify.js).
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 1;

// Ficha de la planta (mismo formato que consume public/js/identify.js). Las
// salidas estructuradas no admiten minimum/maximum ni límites de tamaño en
// arrays: esos rangos se piden en el prompt.
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

const SYSTEM = 'Sos un botánico salvadoreño experto en plantas tropicales de El Salvador y '
  + 'Centroamérica. Tus fichas las lee gente que cuida sus matas en casa, desde una app en el '
  + 'celular. Escribís en español salvadoreño con voseo, con un tono cercano, claro y práctico, '
  + 'como quien le explica a un vecino. Voseo correcto: imperativo "regá", "poné", "tené", '
  + '"cuidá", "revisá", "cortá", "echale"; presente "tenés", "podés", "necesitás". Nunca uses '
  + 'tuteo ("tú", "tienes", "riega", "pon") ni usted ("riegue", "coloque", "usted").';

const PROMPT = [
  'Identificá la planta de la foto y llená su ficha:',
  '- nombre_comun: el nombre con que se le conoce en El Salvador; si en Centroamérica tiene',
  '  otro nombre común, agregalo entre paréntesis.',
  '- descripcion: breve; qué es, usos comunes en El Salvador (cocina, medicina popular, ornato,',
  '  sombra) y si es tóxica para niños o mascotas.',
  '- frecuencia_riego: pensá en el clima cálido de El Salvador y distinguí la época seca',
  '  (nov–abr) de la lluviosa (may–oct).',
  '- humedad_ideal_pct: humedad ideal del suelo, de 0 a 100.',
  '- luz: sol directo, media sombra o sombra, pensando en el sol fuerte del trópico.',
  '- cuidados: de 2 a 4 consejos prácticos (abono, plagas comunes, poda, maceta o tierra).',
  '- confianza: qué tan seguro estás de la identificación.',
  'Si la foto no muestra una planta, poné es_planta=false, confianza="baja",',
  'humedad_ideal_pct=0, cuidados=[] y "—" en los demás textos.',
].join('\n');

let client = null; // se reutiliza mientras la instancia siga caliente

function getClient() {
  if (!client) client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  return client;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Separa un data URL ("data:image/jpeg;base64,…") en tipo y base64; acepta base64 puro. */
function parseImage(image, fallbackType) {
  const m = /^data:([^;,]+);base64,/.exec(image);
  const data = (m ? image.slice(m[0].length) : image).replace(/\s+/g, '');
  return { mediaType: (m ? m[1] : fallbackType).toLowerCase(), data };
}

/**
 * Traduce un error del SDK a [status HTTP, código], del más específico al más
 * general. El detalle va al log del servidor (Vercel → Logs), no al navegador.
 */
function classifyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return [502, 'unauthorized']; // clave inválida o vencida
  if (err instanceof Anthropic.PermissionDeniedError) return [502, 'forbidden'];
  if (err instanceof Anthropic.NotFoundError) return [502, 'bad_model'];          // ANTHROPIC_MODEL inexistente
  if (err instanceof Anthropic.RateLimitError) return [429, 'rate_limited'];      // límite por minuto o tope mensual
  if (err instanceof Anthropic.BadRequestError) return [502, 'bad_request'];      // p. ej. límite de gasto propio
  if (err instanceof Anthropic.InternalServerError) return [502, 'upstream'];     // 5xx / sobrecarga, ya reintentado
  if (err instanceof Anthropic.APIConnectionTimeoutError) return [504, 'timeout'];
  if (err instanceof Anthropic.APIConnectionError) return [502, 'connection'];
  if (err instanceof Anthropic.APIError) return [502, err.status === 402 ? 'billing' : 'upstream']; // 402 = sin saldo
  return [502, 'exception'];
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const reply = (status, body) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') return reply(405, { error: 'Usa POST' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return reply(501, { error: 'not_configured', message: 'Falta ANTHROPIC_API_KEY.' });
  }

  let image;
  try {
    const data = await readJson(req);
    image = parseImage(String(data.image || ''), String(data.mediaType || 'image/jpeg'));
  } catch {
    return reply(400, { error: 'bad_request', message: 'Cuerpo JSON inválido.' });
  }
  if (!image.data) return reply(400, { error: 'bad_request', message: 'Falta la imagen.' });
  if (!IMAGE_TYPES.has(image.mediaType)) {
    return reply(415, { error: 'bad_image', message: 'Formato no soportado (JPEG, PNG, GIF o WebP).' });
  }
  if (image.data.length > MAX_IMAGE_B64) {
    return reply(413, { error: 'too_large', message: 'La imagen supera los 10 MB.' });
  }

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: 16000,
    // Reconocer una foto y llenar la ficha es una tarea corta: con esfuerzo bajo
    // responde más rápido y gasta menos tokens de razonamiento.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: FICHA_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
        { type: 'text', text: PROMPT },
      ],
    }],
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let message;
  try {
    message = await getClient().beta.messages.create(params);
  } catch (err) {
    const [status, code] = classifyError(err);
    console.error(`[identify] ${code} (HTTP ${err.status ?? '—'}): ${err.message}`);
    return reply(status, { error: code, model });
  }

  // stop_reason se revisa antes de leer el contenido.
  if (message.stop_reason === 'refusal') {
    console.error(`[identify] refusal (${message.stop_details?.category ?? 'sin categoría'})`);
    return reply(422, { error: 'refusal', model: message.model });
  }
  if (message.stop_reason === 'max_tokens') {
    console.error('[identify] respuesta cortada por max_tokens');
    return reply(502, { error: 'truncated', model: message.model });
  }

  let ficha;
  try {
    ficha = JSON.parse(message.content.find((b) => b.type === 'text')?.text);
  } catch {
    console.error('[identify] la respuesta no trae el JSON de la ficha');
    return reply(502, { error: 'parse', model: message.model });
  }

  const { input_tokens: inTok, output_tokens: outTok } = message.usage;
  console.log(`[identify] ok · ${message.model} · ${inTok} tokens de entrada / ${outTok} de salida`);

  ficha.humedad_ideal_pct = Math.max(0, Math.min(100, ficha.humedad_ideal_pct));
  return reply(200, { ficha, source: 'ai', model: message.model });
}
