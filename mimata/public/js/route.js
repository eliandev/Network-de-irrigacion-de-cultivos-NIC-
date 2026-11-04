/**
 * MiMata — Fuente única de la ruta actual (la usan app.js y views.js).
 * Solo los hashes "#/..." son rutas; cualquier otro (p. ej. "#main") se trata
 * como la ruta por defecto, y app.js no re-renderiza por ellos.
 *
 * Rutas:  #/identificar (inicio) · #/mis-matas · #/mata/<id>
 */

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** ¿El hash es una ruta de la app (o está vacío)? */
export function isRouteHash(hash = location.hash) {
  return hash === '' || hash === '#' || hash.startsWith('#/');
}

/** @returns {{name: 'identificar'|'mis-matas'|'mata', id?: string}} */
export function parseRoute(hash = location.hash) {
  const path = hash.startsWith('#/') ? hash.slice(2) : '';
  const [name = '', arg = ''] = path.split('/');
  if (name === 'mis-matas') return { name };
  if (name === 'mata' && arg) return { name, id: safeDecode(arg) };
  return { name: 'identificar' };
}
