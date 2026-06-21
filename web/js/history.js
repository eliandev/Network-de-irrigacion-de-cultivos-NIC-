/**
 * NIC — Historial local de lecturas de humedad (IndexedDB).
 * Guarda muestras { ts, raw, pct } con muestreo limitado y retencion de 24 h.
 */

const DB_NAME = 'nic-db';
const DB_VERSION = 1;
const STORE = 'readings';
const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 horas
const MIN_SAMPLE_GAP_MS = 15 * 1000;       // 1 muestra cada ~15 s como maximo

let dbPromise = null;
let lastSampleTs = 0;

function openDB() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB no disponible')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'ts' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueado'));
  });
  // Si la apertura falla (Safari privado, cuota, etc.) NO cacheamos una promesa
  // rechazada de por vida: la limpiamos para reintentar en la próxima llamada.
  p.catch(() => { if (dbPromise === p) dbPromise = null; });
  dbPromise = p;
  return p;
}

function tx(mode) {
  return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

export const history = {
  /**
   * Registra una muestra respetando el muestreo minimo.
   * @returns {Promise<boolean>} true si se guardo.
   */
  async record(pct, raw) {
    const now = Date.now();
    if (now - lastSampleTs < MIN_SAMPLE_GAP_MS) return false;
    lastSampleTs = now;
    try {
      const os = await tx('readwrite');
      os.put({ ts: now, pct: Math.round(pct), raw: Math.round(raw) });
      // Poda oportunista de registros antiguos.
      this.prune().catch(() => {});
      return true;
    } catch (err) {
      console.warn('[history] no se pudo guardar', err);
      return false;
    }
  },

  /** Devuelve las muestras de las ultimas `windowMs` (por defecto 24 h). */
  async recent(windowMs = RETENTION_MS) {
    try {
      const os = await tx('readonly');
      const since = Date.now() - windowMs;
      return await new Promise((resolve, reject) => {
        const out = [];
        const range = IDBKeyRange.lowerBound(since);
        const cursorReq = os.openCursor(range);
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (cur) { out.push(cur.value); cur.continue(); }
          else resolve(out);
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    } catch (err) {
      console.warn('[history] no se pudo leer', err);
      return [];
    }
  },

  /** Elimina muestras mas antiguas que la ventana de retencion. */
  async prune() {
    const os = await tx('readwrite');
    const cutoff = Date.now() - RETENTION_MS;
    const range = IDBKeyRange.upperBound(cutoff);
    const cursorReq = os.openCursor(range);
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur) { cur.delete(); cur.continue(); }
    };
  },

  /** Borra todo el historial. */
  async clear() {
    try {
      const os = await tx('readwrite');
      os.clear();
      return true;
    } catch (err) {
      console.warn('[history] no se pudo limpiar', err);
      return false;
    }
  },
};
