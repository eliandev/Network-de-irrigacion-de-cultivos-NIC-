/**
 * MiMata — Vistas: Identificar, Mis matas y Detalle de una mata.
 * Render con plantillas HTML + delegación de eventos sobre <main> (cada vista
 * reasigna onclick/onchange/onsubmit, así no se acumulan handlers).
 * Todo el texto en español salvadoreño con voseo.
 *
 * Accesibilidad: tras cada acción del usuario el foco va a un destino lógico
 * (focusNext) y los cambios de estado se anuncian en #sr-status (announce).
 */

import { icon } from './icons.js';
import { store } from './store.js';
import { prepare, identify } from './identify.js';
import { parseRoute } from './route.js';
import { toast, confirmDialog, escapeHtml as h } from './ui.js';

const CONFIANZA = {
  alta: { label: 'Confianza alta', cls: 'ok' },
  media: { label: 'Confianza media', cls: 'mid' },
  baja: { label: 'Confianza baja', cls: 'low' },
};

const fmtShort = new Intl.DateTimeFormat('es-SV', { day: 'numeric', month: 'short' });
const fmtLong = new Intl.DateTimeFormat('es-SV', { day: 'numeric', month: 'long', year: 'numeric' });

let requestRender = () => {};
/** La app registra aquí cómo re-renderizar la ruta actual. */
export function setRenderer(fn) { requestRender = fn; }

/** Época del año en El Salvador: lluviosa (may–oct) o seca (nov–abr). */
export function season(date = new Date()) {
  const m = date.getMonth();
  return m >= 4 && m <= 9
    ? { key: 'lluviosa', label: 'Época lluviosa', range: 'may–oct', icon: 'cloud-rain' }
    : { key: 'seca', label: 'Época seca', range: 'nov–abr', icon: 'sun' };
}

/** Texto útil o '' (el modelo usa "—" para campos sin dato). */
const val = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s && s !== '—' && s !== '-' ? s : '';
};

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
const onIdentifyRoute = () => parseRoute().name === 'identificar';

function clearHandlers(root) {
  root.onclick = null;
  root.onchange = null;
  root.onsubmit = null;
}

// ---------------------------------------------------------------------------
// Foco y anuncios
// ---------------------------------------------------------------------------
let pendingFocus = null;

/** Pide enfocar `selector` después del próximo render. */
function focusNext(selector) { pendingFocus = selector; }

function applyFocus(root) {
  if (!pendingFocus) return;
  const el = root.querySelector(pendingFocus);
  pendingFocus = null;
  if (el) el.focus();
}

/** Anuncia un texto a lectores de pantalla (región live persistente en index.html). */
function announce(text) {
  const region = document.getElementById('sr-status');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = text; });
}

// ---------------------------------------------------------------------------
// Ficha (compartida por el resultado y el detalle)
// ---------------------------------------------------------------------------
function fichaHtml(f, { photo = '', apodo = '' } = {}) {
  const nombre = val(f.nombre_comun) || 'Planta sin nombre';
  const cientifico = val(f.nombre_cientifico);
  const desc = val(f.descripcion);
  const riego = val(f.frecuencia_riego);
  const luz = val(f.luz);
  const pct = Number.isFinite(f.humedad_ideal_pct) ? f.humedad_ideal_pct : 0;
  const cuidados = Array.isArray(f.cuidados) ? f.cuidados : [];
  const conf = CONFIANZA[f.confianza] || CONFIANZA.baja;
  const s = season();

  return `
  <article class="ficha" aria-labelledby="ficha-name">
    <header class="ficha__head${photo ? '' : ' ficha__head--nophoto'}">
      ${photo ? `<img class="ficha__photo" src="${h(photo)}" alt="Foto de ${h(apodo || nombre)}" width="120" height="120">` : ''}
      <div class="ficha__titles">
        ${apodo ? `<p class="ficha__apodo">“${h(apodo)}”</p>` : ''}
        <h1 class="ficha__name" id="ficha-name" tabindex="-1">${h(nombre)}</h1>
        ${cientifico ? `<p class="ficha__sci">${h(cientifico)}</p>` : ''}
        <span class="chip chip--${conf.cls}">${conf.label}</span>
      </div>
    </header>
    ${desc ? `<p class="ficha__desc">${h(desc)}</p>` : ''}
    <dl class="facts">
      ${riego ? `
      <div class="fact">
        <dt>${icon('droplet', { size: 18 })}Riego</dt>
        <dd>${h(riego)}
          <span class="fact__hint">${icon(s.icon, { size: 14 })}Ahorita estamos en ${s.label.toLowerCase()} (${s.range}).</span>
        </dd>
      </div>` : ''}
      ${luz ? `
      <div class="fact">
        <dt>${icon('sun', { size: 18 })}Luz</dt>
        <dd>${h(luz)}</dd>
      </div>` : ''}
      ${pct > 0 ? `
      <div class="fact">
        <dt>${icon('droplets', { size: 18 })}Humedad ideal del suelo</dt>
        <dd class="fact__meter">
          <span class="meter" role="img" aria-label="${pct} por ciento"><span style="width:${pct}%"></span></span>
          <strong aria-hidden="true">${pct}%</strong>
        </dd>
      </div>` : ''}
    </dl>
    ${cuidados.length ? `
    <section class="cuidados" aria-labelledby="cuidados-title">
      <h2 id="cuidados-title">Cuidados</h2>
      <ul>${cuidados.map((c) => `<li>${icon('check-circle', { size: 18 })}<span>${h(c)}</span></li>`).join('')}</ul>
    </section>` : ''}
    <p class="ficha__note">${icon('info', { size: 16 })}<span>Esta ficha la genera una IA: tomala como guía y fijate cómo responde tu mata.</span></p>
  </article>`;
}

// ---------------------------------------------------------------------------
// Identificar
// ---------------------------------------------------------------------------

// Estado del flujo; vive fuera del render para conservar el resultado al cambiar de pestaña.
const idState = { phase: 'idle', photo: '', sendUrl: '', ficha: null, error: '', savedId: null, token: 0 };

function resetIdentify() {
  idState.token += 1; // invalida cualquier respuesta en vuelo
  Object.assign(idState, { phase: 'idle', photo: '', sendUrl: '', ficha: null, error: '', savedId: null });
}

const fileInputs = `
  <input type="file" id="mm-cam" accept="image/*" capture="environment" hidden>
  <input type="file" id="mm-gal" accept="image/*" hidden>`;

function pickButtons(primaryLabel = 'Tomar foto') {
  // En compu no hay cámara trasera: un solo botón para elegir archivo (+ arrastrar y soltar).
  if (!isTouch()) {
    return `<button type="button" class="btn btn--primary btn--lg" data-action="gallery">${icon('image')}Elegir una foto</button>`;
  }
  return `
    <button type="button" class="btn btn--primary btn--lg" data-action="camera">${icon('camera')}${primaryLabel}</button>
    <button type="button" class="btn btn--secondary btn--lg" data-action="gallery">${icon('image')}Subir de la galería</button>`;
}

function idleHtml() {
  return `
  <section class="hero" data-drop>
    <p class="eyebrow">${icon('sparkles', { size: 16 })}Identificación con IA</p>
    <h1 tabindex="-1">¿Y esa mata de qué es?</h1>
    <p class="hero__lead">Tomale una foto a tu planta y te decimos qué es y cómo cuidarla, pensado para el clima de El Salvador.</p>
    <div class="actions">${pickButtons()}</div>
    ${isTouch() ? '' : '<p class="drop-hint">…o arrastrá la foto hasta aquí.</p>'}
  </section>
  <section class="tips" aria-labelledby="tips-title">
    <h2 id="tips-title">${icon('lightbulb', { size: 18 })}Para que salga bien la foto</h2>
    <ul>
      <li>Buscá buena luz natural, sin contraluz.</li>
      <li>Que se vean bien las hojas (y la flor o el fruto, si tiene).</li>
      <li>Una sola mata por foto, bien enfocada.</li>
    </ul>
  </section>
  ${fileInputs}`;
}

function loadingHtml() {
  return `
  <section class="analyzing">
    <div class="analyzing__photo">
      ${idState.photo ? `<img src="${h(idState.photo)}" alt="Tu foto">` : ''}
      <div class="analyzing__overlay"><span class="spinner" aria-hidden="true"></span></div>
    </div>
    <p class="analyzing__text" tabindex="-1">${idState.photo ? 'Analizando tu mata…' : 'Preparando la foto…'}</p>
    <p class="analyzing__sub">Esto tarda unos segunditos.</p>
  </section>`;
}

function resultHtml() {
  const f = idState.ficha;
  if (!f.es_planta) {
    return `
    <div class="notice notice--warn" tabindex="-1">
      ${icon('triangle-alert')}
      <div><strong>Mirá, eso no parece una planta.</strong>
      <p>Probá con otra foto donde se vean bien las hojas, con buena luz y una sola mata.</p></div>
    </div>
    ${idState.photo ? `<img class="photo-small" src="${h(idState.photo)}" alt="Tu foto">` : ''}
    <div class="actions">${pickButtons('Tomar otra foto')}</div>
    ${fileInputs}`;
  }

  const saved = idState.savedId ? store.get(idState.savedId) : null;
  return `
  ${fichaHtml(f, { photo: idState.photo })}
  <section class="save-area" aria-label="Guardar">
    ${saved ? `
    <div class="notice notice--ok" tabindex="-1">
      ${icon('check-circle')}
      <div><strong>Guardada en Mis matas.</strong>
      <p><a href="#/mata/${encodeURIComponent(saved.id)}">Ver su ficha</a></p></div>
    </div>` : `
    <form class="panel save" data-form="save" novalidate>
      <label for="mm-apodo">Ponele un apodo <span class="muted">(opcional)</span></label>
      <input id="mm-apodo" name="apodo" type="text" maxlength="40" placeholder="Ej.: La del corredor" autocomplete="off" enterkeyhint="done">
      <button type="submit" class="btn btn--primary">${icon('plus')}Guardar en Mis matas</button>
    </form>`}
    <button type="button" class="btn btn--ghost btn--block" data-action="again">${icon('camera')}Identificar otra mata</button>
  </section>`;
}

function errorHtml() {
  return `
  <div class="notice notice--error" role="alert" tabindex="-1">
    ${icon('octagon-alert')}
    <div><strong>No se pudo identificar.</strong><p>${h(idState.error)}</p></div>
  </div>
  ${idState.photo ? `<img class="photo-small" src="${h(idState.photo)}" alt="Tu foto">` : ''}
  <div class="actions">
    ${idState.sendUrl ? `<button type="button" class="btn btn--primary" data-action="retry">${icon('rotate-cw')}Intentar de nuevo</button>` : ''}
    <button type="button" class="btn btn--secondary" data-action="gallery">${icon('image')}Usar otra foto</button>
  </div>
  ${fileInputs}`;
}

async function runIdentify() {
  const token = ++idState.token;
  Object.assign(idState, { phase: 'loading', error: '', ficha: null, savedId: null });
  announce('Analizando tu mata…');
  if (onIdentifyRoute()) { focusNext('.analyzing__text'); requestRender(); }

  const res = await identify(idState.sendUrl);
  if (token !== idState.token) return; // el usuario empezó otra identificación

  let message;
  if (!res.ok) {
    Object.assign(idState, { phase: 'error', error: res.message });
    message = `No se pudo identificar: ${res.message}`;
  } else {
    Object.assign(idState, { phase: 'result', ficha: res.ficha });
    message = res.ficha.es_planta
      ? `Ya está lista la ficha: ${val(res.ficha.nombre_comun) || 'tu mata'}.`
      : 'Eso no parece una planta. Probá con otra foto.';
  }
  announce(message);

  if (onIdentifyRoute()) {
    focusNext(res.ok && res.ficha.es_planta ? '#ficha-name' : '.notice');
    requestRender();
  } else {
    toast(res.ok ? 'Ya está lista la ficha de tu mata.' : 'No se pudo identificar tu mata.', { type: res.ok ? 'ok' : 'error' });
  }
}

async function onPhoto(file) {
  const token = ++idState.token;
  Object.assign(idState, { phase: 'loading', photo: '', sendUrl: '', ficha: null, error: '', savedId: null });
  focusNext('.analyzing__text');
  requestRender();
  try {
    const { sendUrl, photo } = await prepare(file);
    if (token !== idState.token) return;
    Object.assign(idState, { sendUrl, photo });
  } catch (err) {
    if (token !== idState.token) return;
    Object.assign(idState, { phase: 'error', error: err.message || 'No pudimos leer esa imagen.' });
    announce(`No se pudo identificar: ${idState.error}`);
    focusNext('.notice');
    requestRender();
    return;
  }
  runIdentify();
}

/**
 * Arrastrar y soltar a nivel de ventana: el navegador nunca abre el archivo
 * (perderías una ficha sin guardar). Solo se acepta en Identificar y si no se
 * está analizando otra foto. Llamar una vez al arrancar.
 */
export function initDrop() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const canDrop = () => onIdentifyRoute() && idState.phase !== 'loading';
  const zone = () => document.querySelector('[data-drop]');

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = canDrop() ? 'copy' : 'none';
    zone()?.classList.toggle('is-drag', canDrop());
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) zone()?.classList.remove('is-drag'); // salió de la ventana
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    zone()?.classList.remove('is-drag');
    const file = e.dataTransfer.files?.[0];
    if (file && canDrop()) onPhoto(file);
  });
}

export function renderIdentificar(root) {
  const views = { idle: idleHtml, loading: loadingHtml, result: resultHtml, error: errorHtml };
  root.innerHTML = (views[idState.phase] || idleHtml)();
  clearHandlers(root);

  root.onclick = (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'camera') root.querySelector('#mm-cam')?.click();
    else if (action === 'gallery') root.querySelector('#mm-gal')?.click();
    else if (action === 'retry') runIdentify();
    else if (action === 'again') {
      resetIdentify();
      focusNext('.hero h1');
      requestRender();
      window.scrollTo(0, 0);
    }
  };

  root.onchange = (e) => {
    const input = e.target;
    if (input.matches('#mm-cam, #mm-gal') && input.files && input.files[0]) onPhoto(input.files[0]);
  };

  root.onsubmit = async (e) => {
    const form = e.target.closest('[data-form="save"]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const apodo = String(form.elements.apodo.value || '').trim().slice(0, 40);
    try {
      idState.savedId = await store.add({ ficha: idState.ficha, photo: idState.photo, apodo });
      toast('Listo, guardamos tu mata.', { type: 'ok' });
      focusNext('.notice--ok');
      requestRender();
    } catch (err) {
      btn.disabled = false;
      toast(err.message || 'No se pudo guardar la mata.', { type: 'error', duration: 4500 });
    }
  };

  applyFocus(root);
}

// ---------------------------------------------------------------------------
// Mis matas
// ---------------------------------------------------------------------------
function cardHtml(m) {
  const nombre = val(m.ficha.nombre_comun) || 'Planta';
  const title = m.apodo || nombre;
  const sub = m.apodo ? nombre : val(m.ficha.nombre_cientifico);
  return `
  <li>
    <a class="card" href="#/mata/${encodeURIComponent(m.id)}">
      ${m.photo
        ? `<img class="card__img" src="${h(m.photo)}" alt="" loading="lazy" width="240" height="240">`
        : `<span class="card__img card__img--empty">${icon('leaf', { size: 36 })}</span>`}
      <span class="card__body">
        <span class="card__name">${h(title)}</span>
        ${sub ? `<span class="card__sub">${h(sub)}</span>` : ''}
        <span class="card__date">${icon('calendar', { size: 13 })}${h(fmtShort.format(m.savedAt))}</span>
      </span>
    </a>
  </li>`;
}

function emptyHtml() {
  return `
  <div class="empty">
    <span class="empty__icon">${icon('sprout', { size: 36 })}</span>
    <h2>Todavía no tenés matas guardadas</h2>
    <p>Identificá tu primera planta y guardala aquí para tener su ficha siempre a mano.</p>
    <a class="btn btn--primary" href="#/identificar">${icon('camera')}Identificar una mata</a>
  </div>`;
}

export function renderMisMatas(root) {
  const matas = store.list();
  const n = matas.length;
  clearHandlers(root);
  root.innerHTML = `
  <header class="page-head">
    <h1 tabindex="-1">Mis matas</h1>
    <p>${n ? `Tenés ${n} ${n === 1 ? 'mata guardada' : 'matas guardadas'}.` : 'Aquí vas a ver las matas que guardés.'}</p>
  </header>
  ${store.isPersistent() ? '' : `
  <div class="notice notice--warn" role="status">
    ${icon('triangle-alert')}
    <div><strong>Este navegador no deja guardar.</strong>
    <p>Puede ser por el modo privado. Tus matas se van a perder al cerrar la app.</p></div>
  </div>`}
  ${n ? `<ul class="grid" role="list">${matas.map(cardHtml).join('')}</ul>` : emptyHtml()}`;
  applyFocus(root);
}

// ---------------------------------------------------------------------------
// Detalle de una mata
// ---------------------------------------------------------------------------
const detail = { id: null, editing: false };

export function renderDetalle(root, id) {
  if (detail.id !== id) Object.assign(detail, { id, editing: false });
  const m = store.get(id);
  clearHandlers(root);

  const back = `<a class="back" href="#/mis-matas">${icon('arrow-left', { size: 18 })}Mis matas</a>`;
  if (!m) {
    root.innerHTML = `
    ${back}
    <div class="empty">
      <span class="empty__icon">${icon('leaf', { size: 36 })}</span>
      <h1 tabindex="-1">No encontramos esa mata</h1>
      <p>Puede que la hayás eliminado.</p>
      <a class="btn btn--primary" href="#/mis-matas">Ver mis matas</a>
    </div>`;
    applyFocus(root);
    return;
  }

  const nombre = val(m.ficha.nombre_comun) || 'Planta';
  root.innerHTML = `
  ${back}
  ${fichaHtml(m.ficha, { photo: m.photo, apodo: m.apodo })}
  <p class="meta">${icon('calendar', { size: 14 })}Guardada el ${h(fmtLong.format(m.savedAt))}</p>
  ${detail.editing ? `
  <form class="panel save" data-form="rename" novalidate>
    <label for="mm-apodo-edit">Apodo</label>
    <input id="mm-apodo-edit" name="apodo" type="text" maxlength="40" value="${h(m.apodo)}" placeholder="Ej.: La del corredor" autocomplete="off" enterkeyhint="done">
    <div class="actions">
      <button type="submit" class="btn btn--primary">${icon('check')}Guardar apodo</button>
      <button type="button" class="btn btn--ghost" data-action="cancel-edit">Cancelar</button>
    </div>
  </form>` : `
  <div class="actions">
    <button type="button" class="btn btn--secondary" data-action="edit">${icon('pencil')}${m.apodo ? 'Cambiar apodo' : 'Ponerle apodo'}</button>
    <button type="button" class="btn btn--danger" data-action="delete">${icon('trash')}Eliminar</button>
  </div>`}`;

  root.onclick = async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'edit') {
      detail.editing = true;
      focusNext('#mm-apodo-edit');
      requestRender();
    } else if (action === 'cancel-edit') {
      detail.editing = false;
      focusNext('[data-action="edit"]');
      requestRender();
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: '¿Eliminar esta mata?',
        message: `Se va a borrar la ficha de "${m.apodo || nombre}". Esto no se puede deshacer.`,
        confirmText: 'Sí, eliminar',
        cancelText: 'Cancelar',
        danger: true,
      });
      if (!ok) return;
      focusNext('.page-head h1');
      location.hash = '#/mis-matas'; // primero salimos, para no mostrar "no encontramos" un instante
      try {
        await store.remove(m.id);
        toast('Mata eliminada.', { type: 'ok' });
      } catch {
        toast('No se pudo eliminar la mata.', { type: 'error' });
      }
    }
  };

  root.onsubmit = async (e) => {
    const form = e.target.closest('[data-form="rename"]');
    if (!form) return;
    e.preventDefault();
    const apodo = String(form.elements.apodo.value || '').trim().slice(0, 40);
    detail.editing = false;
    focusNext('[data-action="edit"]');
    try {
      const updated = await store.update(m.id, { apodo }); // emite -> la app re-renderiza el detalle
      if (!updated) toast('Esa mata ya no existe: se eliminó en otra ventana.', { type: 'error', duration: 4500 });
      else toast(apodo ? 'Apodo guardado.' : 'Le quitamos el apodo.', { type: 'ok' });
    } catch (err) {
      detail.editing = true;
      focusNext('#mm-apodo-edit');
      toast(err.message || 'No se pudo guardar el apodo.', { type: 'error' });
      requestRender();
    }
  };

  applyFocus(root);
  if (detail.editing && document.activeElement?.id === 'mm-apodo-edit') {
    document.activeElement.select();
  }
}
