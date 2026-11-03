/**
 * MiMata — Arranque de la app: router por hash, navegación, contador de
 * matas, chip de época del año y service worker.
 *
 * Rutas (ver route.js):  #/identificar (inicio) · #/mis-matas · #/mata/<id>
 */

import { icon } from './icons.js';
import { store } from './store.js';
import { parseRoute, isRouteHash } from './route.js';
import { initUi } from './ui.js';
import { renderIdentificar, renderMisMatas, renderDetalle, setRenderer, season, initDrop } from './views.js';

const main = document.getElementById('main');

function render() {
  const route = parseRoute();
  // En el detalle, "Mis matas" queda marcada como sección actual (no como página actual).
  document.querySelectorAll('[data-route]').forEach((el) => {
    if (el.dataset.route === route.name) el.setAttribute('aria-current', 'page');
    else if (route.name === 'mata' && el.dataset.route === 'mis-matas') el.setAttribute('aria-current', 'true');
    else el.removeAttribute('aria-current');
  });

  if (route.name === 'mis-matas') {
    renderMisMatas(main);
    document.title = 'Mis matas · MiMata';
  } else if (route.name === 'mata') {
    renderDetalle(main, route.id);
    const m = store.get(route.id);
    document.title = `${m ? (m.apodo || m.ficha.nombre_comun || 'Mata') : 'Mata'} · MiMata`;
  } else {
    renderIdentificar(main);
    document.title = 'MiMata — Conocé tus matas';
  }
}

/** Si el render se llevó el elemento enfocado, el foco vuelve al título de la vista. */
function restoreFocus(hadFocusInMain) {
  if (hadFocusInMain && !main.contains(document.activeElement)) {
    (main.querySelector('h1') || main).focus({ preventScroll: true });
  }
}

function renderCount() {
  const n = store.count();
  const label = n ? `, ${n} ${n === 1 ? 'mata guardada' : 'matas guardadas'}` : '';
  document.querySelectorAll('.js-count').forEach((b) => {
    b.hidden = n === 0;
    b.textContent = n > 99 ? '99+' : String(n);
  });
  document.querySelectorAll('.js-count-sr').forEach((s) => { s.textContent = label; });
}

function renderChrome() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 22 });
  });
  const s = season();
  const chip = document.querySelector('.js-season');
  if (chip) {
    chip.innerHTML = `${icon(s.icon, { size: 16 })}<span>${s.label}</span>`;
    chip.title = `${s.label} en El Salvador (${s.range})`;
  }
  // El skip-link solo mueve el foco: cambiar el hash a "#main" no es una ruta.
  document.querySelector('.skip-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    main.focus();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('./service-worker.js').catch((err) => {
    console.warn('[mimata] service worker no registrado', err);
  });
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

async function boot() {
  initUi();
  renderChrome();
  initDrop();
  registerServiceWorker();
  await store.init();

  setRenderer(render);
  store.subscribe(() => {
    renderCount();
    // En Identificar la vista maneja su propio re-render (evita parpadeos al guardar).
    if (parseRoute().name !== 'identificar') {
      const hadFocusInMain = main.contains(document.activeElement);
      render();
      restoreFocus(hadFocusInMain);
    }
  });

  window.addEventListener('hashchange', () => {
    if (!isRouteHash()) return; // p. ej. un ancla interna: no es cambio de vista
    render();
    window.scrollTo(0, 0);
    // Cambio de vista: el foco va siempre al título de la nueva (o a <main>).
    (main.querySelector('h1') || main).focus({ preventScroll: true });
  });

  renderCount();
  render();
}

boot();
