/**
 * MiMata — Almacén local de "Mis matas" (IndexedDB).
 * ---------------------------------------------------------------------------
 * ¿Por qué IndexedDB y no localStorage? Guardamos la foto de cada mata, y
 * localStorage tiene ~5 MB por origen: se llenaría con unas pocas decenas de
 * fotos. IndexedDB tiene mucha más cuota y una base propia ('mimata').
 *
 * Si IndexedDB no está disponible (algunos modos privados), funciona en
 * memoria y la UI avisa que no se va a guardar al cerrar.
 *
 * Varias ventanas abiertas (la app instalada + una pestaña) se avisan los
 * cambios por BroadcastChannel y releen la base.
 *
 * Registro:  { id, ficha, photo (dataURL JPEG ~480px), apodo, savedAt }
 */

const DB_NAME = 'mimata';
const DB_VERSION = 1;
const STORE = 'matas';

let dbPromise = null;
let cache = [];          // copia en memoria, ordenada de la más reciente a la más vieja
let persistent = true;   // false => IndexedDB no disponible, solo memoria
const listeners = new Set();
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('mimata') : null;

function openDb() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB no disponible')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('savedAt', 'savedAt');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Si la conexión se cierra (bug de WebKit en iOS, datos del sitio borrados,
      // otra pestaña sube la versión), la olvidamos y la próxima operación abre otra.
      const forget = () => {
        try { db.close(); } catch { /* noop */ }
        if (dbPromise === p) dbPromise = null;
      };
      db.onclose = forget;
      db.onversionchange = forget;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('[mimata] IndexedDB: otra pestaña bloquea la apertura; esperando…');
  });
  dbPromise = p;
  p.catch(() => { if (dbPromise === p) dbPromise = null; }); // permite reintentar
  return p;
}

/**
 * Ejecuta `fn(objectStore, out)` en una transacción y resuelve con `out.value`
 * cuando la transacción se completa. Si la conexión murió, reintenta una vez
 * con una conexión nueva (la transacción fallida no dejó nada escrito).
 */
function run(mode, fn) {
  const attempt = () => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode); // lanza InvalidStateError si la conexión murió
    const out = { value: undefined };
    fn(tx.objectStore(STORE), out);
    tx.oncomplete = () => resolve(out.value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción cancelada'));
  }));
  return attempt().catch((err) => {
    if (err && (err.name === 'InvalidStateError' || err.name === 'UnknownError')) {
      dbPromise = null;
      return attempt();
    }
    throw err;
  });
}

async function reload() {
  const all = await run('readonly', (os, out) => {
    const r = os.getAll();
    r.onsuccess = () => { out.value = r.result; };
  });
  cache = Array.isArray(all) ? all : [];
  cache.sort((a, b) => b.savedAt - a.savedAt);
}

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[mimata] listener', err); }
  }
}

/** Notifica a esta ventana y a las demás ventanas de MiMata. */
function changed() {
  emit();
  try { channel?.postMessage('changed'); } catch { /* noop */ }
}

function newId() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Traduce errores de IndexedDB a mensajes para el usuario. */
function friendlyError(err) {
  if (err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || '')))) {
    return new Error('No hay espacio para guardar más matas. Eliminá alguna e intentá de nuevo.');
  }
  return new Error('No se pudo guardar. Intentá de nuevo.');
}

export const store = {
  /** Carga las matas guardadas. Llamar una vez al arrancar. */
  async init() {
    try {
      await reload();
    } catch (err) {
      console.warn('[mimata] IndexedDB no disponible; se usará memoria.', err);
      persistent = false;
      cache = [];
    }
    if (channel && persistent) {
      channel.onmessage = () => {
        reload().then(emit).catch((err) => console.warn('[mimata] no se pudo releer', err));
      };
    }
    emit();
  },

  isPersistent() { return persistent; },
  list() { return cache.slice(); },
  count() { return cache.length; },
  get(id) { return cache.find((m) => m.id === id) || null; },

  /** Guarda una mata nueva y devuelve su id. */
  async add({ ficha, photo = '', apodo = '' }) {
    const mata = { id: newId(), ficha, photo, apodo: String(apodo || '').trim(), savedAt: Date.now() };
    if (persistent) {
      try { await run('readwrite', (os) => { os.put(mata); }); }
      catch (err) { throw friendlyError(err); }
      // Pide almacenamiento persistente para que el navegador no borre las matas
      // si se queda sin espacio (best effort: puede ignorarse).
      try { navigator.storage?.persist?.(); } catch { /* noop */ }
    }
    cache.unshift(mata);
    changed();
    return mata.id;
  },

  /**
   * Actualiza campos de una mata (p. ej. { apodo }). Lee y escribe en la misma
   * transacción: si la mata ya no existe (se borró en otra ventana), no la
   * resucita. Devuelve true si la actualizó.
   */
  async update(id, patch) {
    let next = null;
    if (persistent) {
      try {
        next = await run('readwrite', (os, out) => {
          const g = os.get(id);
          g.onsuccess = () => {
            if (!g.result) return;
            out.value = { ...g.result, ...patch };
            os.put(out.value);
          };
        }) || null;
      } catch (err) { throw friendlyError(err); }
    } else {
      const cur = cache.find((m) => m.id === id);
      next = cur ? { ...cur, ...patch } : null;
    }
    if (next) cache = cache.map((m) => (m.id === id ? next : m));
    else cache = cache.filter((m) => m.id !== id);
    changed();
    return !!next;
  },

  async remove(id) {
    if (persistent) await run('readwrite', (os) => { os.delete(id); });
    cache = cache.filter((m) => m.id !== id);
    changed();
  },

  /** Suscribe un callback a cualquier cambio. Devuelve la función para desuscribir. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
