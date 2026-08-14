/**
 * NIC — Pantalla "Mi planta" (Antonio.ia, reconocimiento por foto).
 * Antonio.ia identifica la especie con una foto y muestra su ficha (línea base de cuidado).
 * La humedad ideal de la ficha puede aplicarse como umbral de riego.
 */

import { store } from '../store.js';
import { settings } from '../settings.js';
import { plant } from '../plant.js';
import { ws } from '../ws-client.js';
import { CONN, pctToThresholdAdc, cmdSetThreshold } from '../protocol.js';
import { toast, confirmDialog, escapeHtml } from '../ui.js';
import { icon } from '../icons.js';

let unsub = null;
let mounted = false;
let status = 'idle';   // 'idle' | 'loading'
let errorMsg = '';

export function mount(root) {
  mounted = true;
  status = 'idle';
  errorMsg = '';

  root.innerHTML = `
    <h1 class="screen-title">Mi planta</h1>
    <p class="screen-sub">Identifica tu planta con Antonio.ia y usa su ficha como referencia de cuidado.</p>

    <div class="card">
      <div class="card__header"><span class="card__title">${icon('sparkles', { size: 18 })} Antonio.ia — Reconocer por foto</span></div>
      <p class="soon-note">Toma o sube una foto de la planta; Antonio.ia identifica la especie, su frecuencia de riego y su humedad ideal.</p>
      <input type="file" id="plant-file" accept="image/*" capture="environment" hidden />
      <div class="btn-row mt">
        <button type="button" class="btn btn--primary" id="plant-shoot">${icon('camera', { size: 16 })} Tomar / subir foto</button>
      </div>
      <div id="plant-status" class="mt"></div>
    </div>

    <div id="plant-ficha"></div>
  `;

  const fileInput = root.querySelector('#plant-file');
  root.querySelector('#plant-shoot').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => onFile(root, fileInput));

  unsub = settings.subscribe(() => render(root));
  render(root);
}

export function unmount() {
  mounted = false;
  if (unsub) { unsub(); unsub = null; }
}

async function onFile(root, fileInput) {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = ''; // permite re-seleccionar la misma foto
  if (!file) return;

  status = 'loading';
  errorMsg = '';
  render(root);

  try {
    const { sendUrl, thumb } = await plant.prepare(file);
    const res = await plant.identify(sendUrl);
    if (!mounted) return;

    if (res.ok && res.ficha && res.ficha.es_planta) {
      plant.save(res.ficha, thumb); // dispara settings -> re-render
      status = 'idle';
      toast(res.source === 'mock' ? 'Identificada (datos de ejemplo)' : 'Planta identificada por Antonio.ia', { type: 'ok' });
    } else if (res.ok && res.ficha && !res.ficha.es_planta) {
      status = 'idle';
      errorMsg = 'No se detectó una planta en la foto. Prueba con otra imagen.';
    } else {
      status = 'idle';
      errorMsg = res.code === 'not_configured'
        ? 'Antonio.ia aún no está configurado en el servidor (falta la clave). Funciona en la demo local y en Vercel una vez configurado.'
        : (res.message || 'No se pudo identificar la planta.');
    }
  } catch (e) {
    if (!mounted) return;
    status = 'idle';
    errorMsg = 'No se pudo procesar la imagen.';
  }
  render(root);
}

function render(root) {
  // Estado de la captura (cargando / error)
  const statusEl = root.querySelector('#plant-status');
  if (statusEl) {
    if (status === 'loading') {
      statusEl.innerHTML = '<p class="empty-state">Antonio.ia está analizando la foto…</p>';
    } else if (errorMsg) {
      statusEl.innerHTML = `<p class="soon-note">${icon('triangle-alert', { size: 14 })} ${escapeHtml(errorMsg)}</p>`;
    } else {
      statusEl.innerHTML = '';
    }
  }

  // Ficha guardada
  const fichaEl = root.querySelector('#plant-ficha');
  if (!fichaEl) return;
  const saved = plant.getSaved();
  if (!saved || !saved.ficha) {
    fichaEl.innerHTML = `
      <div class="card is-soon">
        <div class="card__header"><span class="card__title">${icon('leaf', { size: 18 })} Ficha de la planta</span></div>
        <p class="soon-note">Aún no has identificado ninguna planta. Toma una foto para empezar.</p>
      </div>`;
    return;
  }
  fichaEl.innerHTML = fichaCard(saved);

  // Acciones
  const applyBtn = fichaEl.querySelector('#plant-apply');
  if (applyBtn) applyBtn.addEventListener('click', onApplyThreshold);
  const removeBtn = fichaEl.querySelector('#plant-remove');
  if (removeBtn) removeBtn.addEventListener('click', onRemove);
}

function fichaCard(saved) {
  const f = saved.ficha;
  const conf = f.confianza === 'alta' ? 'ok' : f.confianza === 'baja' ? 'warn' : 'info';
  const cuidados = Array.isArray(f.cuidados) ? f.cuidados : [];
  return `
    <div class="card">
      <div class="card__header">
        <span class="card__title">${icon('leaf', { size: 18 })} ${escapeHtml(f.nombre_comun || 'Planta')}</span>
        <span class="chip chip--${conf}">Confianza ${escapeHtml(f.confianza || '—')}</span>
      </div>
      <div class="plant-head">
        ${saved.thumb ? `<img class="plant-thumb" src="${saved.thumb}" alt="Foto de la planta" />` : ''}
        <div>
          <div class="plant-sci">${escapeHtml(f.nombre_cientifico || '')}</div>
          <p class="small muted mt">${escapeHtml(f.descripcion || '')}</p>
        </div>
      </div>
      <div class="kv mt"><span class="kv__k">Frecuencia de riego</span><span class="kv__v">${escapeHtml(f.frecuencia_riego || '—')}</span></div>
      <div class="kv"><span class="kv__k">Humedad de suelo ideal</span><span class="kv__v">${Number.isFinite(f.humedad_ideal_pct) ? f.humedad_ideal_pct + '%' : '—'}</span></div>
      <div class="kv"><span class="kv__k">Luz</span><span class="kv__v">${escapeHtml(f.luz || '—')}</span></div>
      ${cuidados.length ? `<div class="mt"><span class="kv__k">Cuidados</span><ul class="plant-care">${cuidados.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div>` : ''}
      <div class="btn-row mt">
        ${Number.isFinite(f.humedad_ideal_pct) && f.humedad_ideal_pct > 0
          ? `<button type="button" class="btn btn--primary btn--small" id="plant-apply">Usar humedad ideal como umbral</button>`
          : ''}
        <button type="button" class="btn btn--ghost btn--small" id="plant-remove">${icon('x', { size: 15 })} Quitar planta</button>
      </div>
      <p class="hint mt">Ficha generada por Antonio.ia como línea base. La humedad real la miden los sensores.</p>
    </div>`;
}

async function onApplyThreshold() {
  const saved = plant.getSaved();
  const pct = saved && saved.ficha ? saved.ficha.humedad_ideal_pct : null;
  if (!Number.isFinite(pct)) return;
  if (store.getState().connection !== CONN.CONNECTED) {
    toast('Conéctate al dispositivo para aplicar el umbral', { type: 'error' });
    return;
  }
  const adc = pctToThresholdAdc(pct);
  try {
    await ws.sendCommand(cmdSetThreshold(adc));
    toast(`Umbral ajustado a la humedad ideal (${pct}%)`, { type: 'ok' });
  } catch {
    toast('No se pudo ajustar el umbral', { type: 'error' });
  }
}

async function onRemove() {
  const ok = await confirmDialog({
    title: 'Quitar planta',
    message: '¿Eliminar la ficha de la planta guardada?',
    confirmText: 'Quitar', danger: true,
  });
  if (ok) plant.clear();
}
