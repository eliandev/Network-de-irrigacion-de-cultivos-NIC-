/**
 * MiMata — Captura de la foto y consulta a la IA.
 * Reduce la foto en el navegador (menos datos y menos tokens de visión) y la
 * manda a /api/identify con locale:'sv' para recibir la ficha tropicalizada a
 * El Salvador y en voseo. El endpoint (mimata/api/identify.js) reutiliza la
 * función serverless de NIC (Groq); sin el flag, responde en español neutro.
 */

const ENDPOINT = '/api/identify';
const TIMEOUT_MS = 45000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const MESSAGES = {
  not_configured: 'La identificación por IA todavía no está configurada en el servidor.',
  rate_limited: 'Hay muchas consultas seguidas. Esperá unos segundos y probá otra vez.',
  network: 'No hay conexión. Revisá tu internet y probá de nuevo.',
  timeout: 'La IA se está tardando más de la cuenta. Probá de nuevo en un ratito.',
  error: 'No pudimos identificar la planta. Probá de nuevo o con otra foto.',
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No pudimos leer esa imagen. Probá con una foto JPG o PNG.'));
    img.src = src;
  });
}

/** Redimensiona a un lado máximo y exporta JPEG (fondo blanco para PNG con transparencia). */
function toJpeg(img, maxDim, quality) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(1, maxDim / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Prepara la foto: una versión para la IA (1024 px) y otra para guardar (480 px).
 * @returns {Promise<{sendUrl: string, photo: string}>}
 */
export async function prepare(file) {
  if (!file) throw new Error('No elegiste ninguna foto.');
  if (file.type && !file.type.startsWith('image/')) throw new Error('Ese archivo no es una imagen.');
  if (file.size > MAX_FILE_BYTES) throw new Error('La foto pesa demasiado (más de 25 MB).');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return { sendUrl: toJpeg(img, 1024, 0.85), photo: toJpeg(img, 480, 0.8) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Normaliza la ficha que devuelve el modelo (tipos y rangos seguros para la UI). */
function normalize(f) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const pct = Math.round(Number(f.humedad_ideal_pct));
  const conf = str(f.confianza).toLowerCase();
  return {
    es_planta: f.es_planta === true || str(f.es_planta).toLowerCase() === 'true',
    nombre_comun: str(f.nombre_comun),
    nombre_cientifico: str(f.nombre_cientifico),
    descripcion: str(f.descripcion),
    frecuencia_riego: str(f.frecuencia_riego),
    humedad_ideal_pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null,
    luz: str(f.luz),
    cuidados: Array.isArray(f.cuidados) ? f.cuidados.map(str).filter(Boolean).slice(0, 6) : [],
    confianza: ['alta', 'media', 'baja'].includes(conf) ? conf : 'baja',
  };
}

/**
 * Envía la foto a la IA.
 * @returns {Promise<{ok: true, ficha: object} | {ok: false, code: string, message: string}>}
 */
export async function identify(sendUrl) {
  const fail = (code) => ({ ok: false, code, message: MESSAGES[code] || MESSAGES.error });
  if (navigator.onLine === false) return fail('network');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: sendUrl, mediaType: 'image/jpeg', locale: 'sv' }),
      signal: ctrl.signal,
    });
  } catch (err) {
    return fail(err && err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  let data = {};
  try { data = await res.json(); } catch { /* respuesta no-JSON (p. ej. 504 de la plataforma) */ }

  if (res.ok && data && data.ficha) return { ok: true, ficha: normalize(data.ficha) };
  if (res.status === 501 || data.error === 'not_configured') return fail('not_configured');
  if (res.status === 429 || data.error === 'rate_limited') return fail('rate_limited');
  if (res.status === 504) return fail('timeout');
  return fail('error');
}
