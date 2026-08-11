/**
 * NIC — Reconocimiento de planta por foto (cliente).
 * Prepara la imagen (reduce tamaño), la envía a /api/identify (función serverless
 * que llama a Claude) y guarda la ficha resultante como "mi planta" en settings.
 *
 * La ficha de la especie es la LÍNEA BASE: define humedad ideal, frecuencia de
 * riego y cuidados; los sensores aportan el estado real de la planta.
 */

import { settings } from './settings.js';

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('No se pudo leer la imagen'));
    r.readAsDataURL(file);
  });
}

/** Reduce una imagen (dataURL) a un máximo de píxeles y la devuelve como JPEG. */
function downscale(dataUrl, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Imagen no válida'));
    img.src = dataUrl;
  });
}

export const plant = {
  getSaved() { return settings.get().plant; },

  save(ficha, thumb) {
    settings.patch({ plant: { ficha, thumb, savedAt: Date.now() } });
  },

  clear() { settings.patch({ plant: null }); },

  /**
   * Prepara una foto: una versión reducida para enviar y una miniatura para
   * guardar localmente (evita llenar localStorage con la foto completa).
   */
  async prepare(file) {
    const raw = await fileToDataUrl(file);
    const sendUrl = await downscale(raw, 1024, 0.85);
    const thumb = await downscale(raw, 256, 0.8);
    return { sendUrl, thumb };
  },

  /**
   * Envía la imagen al servicio de IA.
   * @returns {Promise<{ok:boolean, ficha?:object, source?:string, code?:string, message?:string}>}
   */
  async identify(sendDataUrl) {
    try {
      const res = await fetch('/api/identify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: sendDataUrl, mediaType: 'image/jpeg' }),
      });
      let data = {};
      try { data = await res.json(); } catch { /* respuesta no-JSON */ }
      if (res.ok && data.ficha) {
        return { ok: true, ficha: data.ficha, source: data.source || 'ai' };
      }
      if (res.status === 501 || data.error === 'not_configured') {
        return { ok: false, code: 'not_configured', message: 'La IA no está configurada en el servidor.' };
      }
      return { ok: false, code: data.error || 'error', message: data.message || 'No se pudo identificar la planta.' };
    } catch {
      return { ok: false, code: 'network', message: 'No se pudo contactar el servicio de IA.' };
    }
  },
};
