// =====================================================================
// Emanuel Cosméticos · Pagos (js/pages/pagos.js)
// =====================================================================

import { requireAuth } from "../auth.js";
import { renderLayout } from "../layout.js";
import { listarPagos, anularPago, listarClientes } from "../db.js";
import {
  $, $$, escapeHTML, toast, debounce,
  formatoMoneda, formatoMonedaPartes, formatoFecha, fechaRelativa, RANGOS
} from "../utils.js";

// Errores globales
window.addEventListener('error', (e) => {
  console.error('[pagos] error:', e.error || e.message);
  toast('Error: ' + (e.error?.message || e.message), 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[pagos] unhandled:', e.reason);
  toast('Error: ' + (e.reason?.message || String(e.reason)), 'error');
});

// Init
const usuario = await requireAuth();
document.getElementById('pantalla-carga').style.display = 'none';
document.getElementById('app').style.display = 'grid';
renderLayout({ usuario, paginaActiva: "pagos" });

// Estado
let pagosData = [];
let pagosFiltrados = [];
let pagoSeleccionado = null;
let clientesPorId = {};   // cache id -> {nombre, apellido} para pagos viejos sin clienteNombre

const $buscador     = $('#buscador');
const $filtroRango  = $('#filtro-rango');
const $filtroForma  = $('#filtro-forma');
const $checkAnulados = $('#check-anulados');
const $btnLimpiar   = $('#btn-limpiar');
const $tbody        = $('#tbody-pagos');
const $resumen      = $('#resumen-pagos');
const $kpis         = $('#kpis-pagos');
const $modalAnular  = $('#modal-anular');

// =====================================================================
// CARGA
// =====================================================================
async function recargar() {
  $tbody.innerHTML = `<tr><td colspan="6"><div class="vacio"><p>Cargando…</p></div></td></tr>`;

  try {
    const rangoActivo = $filtroRango.value;
    let desde = null, hasta = null;
    if (rangoActivo !== "todo" && RANGOS[rangoActivo]) {
      const r = RANGOS[rangoActivo]();
      desde = r.desde;
      hasta = r.hasta;
    }

    // Cargar pagos + cache de clientes en paralelo (los clientes solo la 1ª vez)
    const promesas = [
      listarPagos({ desde, hasta, incluirAnulados: $checkAnulados.checked }),
    ];
    if (Object.keys(clientesPorId).length === 0) {
      promesas.push(listarClientes({ soloActivos: false }));
    }
    const [pagos, clientes] = await Promise.all(promesas);
    pagosData = pagos;

    // Construir cache de clientes
    if (clientes) {
      for (const c of clientes) {
        clientesPorId[c.id] = `${c.nombre || ''} ${c.apellido || ''}`.trim() || 'Sin nombre';
      }
    }

    aplicarFiltros();
  } catch (e) {
    console.error(e);
    $tbody.innerHTML = `<tr><td colspan="6">
      <div class="alerta alerta-error" style="margin: 20px;">
        ${escapeHTML(e.message || 'Error cargando pagos')}
      </div>
    </td></tr>`;
  }
}

// =====================================================================
// FILTROS
// =====================================================================
function aplicarFiltros() {
  const texto = $buscador.value.toLowerCase().trim();
  const forma = $filtroForma.value;

  pagosFiltrados = pagosData.filter(p => {
    if (forma && p.formaPago !== forma) return false;

    if (texto) {
      const blob = `${p.observaciones || ''} ${p.creadoPor || ''}`.toLowerCase();
      if (!blob.includes(texto)) return false;
    }
    return true;
  });

  renderKPIs();
  renderLista();
}

$buscador.addEventListener('input', debounce(aplicarFiltros, 200));
$filtroForma.addEventListener('change', aplicarFiltros);
$filtroRango.addEventListener('change', recargar);
$checkAnulados.addEventListener('change', recargar);
$btnLimpiar.addEventListener('click', () => {
  $buscador.value = '';
  $filtroForma.value = '';
  $filtroRango.value = 'esteMes';
  $checkAnulados.checked = false;
  recargar();
});

// =====================================================================
// KPIs (estadísticas del período filtrado)
// =====================================================================
function renderKPIs() {
  const pagosActivos = pagosFiltrados.filter(p => p.anulado !== true);
  const totalCobrado = pagosActivos.reduce((s, p) => s + (p.monto || 0), 0);
  const cantidad     = pagosActivos.length;
  const promedio     = cantidad > 0 ? totalCobrado / cantidad : 0;

  // Desglose por forma de pago
  const porForma = {};
  for (const p of pagosActivos) {
    const f = p.formaPago || 'otro';
    porForma[f] = (porForma[f] || 0) + (p.monto || 0);
  }
  const formaTop = Object.entries(porForma).sort((a, b) => b[1] - a[1])[0];

  const totalMoneda = (n) => {
    const { simbolo, valor } = formatoMonedaPartes(n);
    return `<span class="moneda">${simbolo}</span>${valor}`;
  };

  $kpis.innerHTML = `
    <div class="kpi">
      <div class="kpi-acento ok"></div>
      <div class="kpi-etiqueta">Total cobrado</div>
      <div class="kpi-valor">${totalMoneda(totalCobrado)}</div>
      <div class="kpi-pie">${cantidad} ${cantidad === 1 ? 'pago' : 'pagos'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-etiqueta">Promedio</div>
      <div class="kpi-valor">${totalMoneda(promedio)}</div>
      <div class="kpi-pie">por pago</div>
    </div>
    <div class="kpi">
      <div class="kpi-etiqueta">Forma principal</div>
      <div class="kpi-valor" style="font-family: var(--font-serif); font-size: 22px;">${formaTop ? escapeHTML(formaTop[0]) : '—'}</div>
      <div class="kpi-pie">${formaTop ? formatoMoneda(formaTop[1]) : '—'}</div>
    </div>
  `;
}

// =====================================================================
// RENDER LISTA
// =====================================================================
function renderLista() {
  const total = pagosData.length;
  const visibles = pagosFiltrados.length;
  const anulados = pagosData.filter(p => p.anulado === true).length;

  $resumen.textContent = total === 0
    ? "Todavía no se registraron pagos. Andá a 'Pedidos' y registrá un pago sobre una venta."
    : `${visibles} ${visibles === 1 ? 'pago' : 'pagos'}${anulados > 0 && $checkAnulados.checked ? ` (${anulados} anulados)` : ''}`;

  if (visibles === 0) {
    $tbody.innerHTML = `<tr><td colspan="6">
      <div class="vacio">
        <h3>${total === 0 ? 'Sin pagos' : 'Sin resultados'}</h3>
        <p>${total === 0
          ? 'Cuando registres un pago sobre una venta, aparece acá.'
          : 'Probá cambiar los filtros.'}</p>
      </div>
    </td></tr>`;
    return;
  }

  $tbody.innerHTML = pagosFiltrados.map(filaPago).join('');

  $$('.btn-anular[data-id]').forEach($btn => {
    $btn.addEventListener('click', () => abrirAnular($btn.dataset.id));
  });
}

function filaPago(p) {
  const anuladoClase = p.anulado ? 'anulado' : '';
  const nombre = obtenerNombreCliente(p);
  const inic = nombre.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();

  const formaPagoLabel = {
    efectivo: 'Efectivo',
    transferencia: 'Transferencia',
    mercadopago: 'M. Pago',
    otro: 'Otro'
  }[p.formaPago] || p.formaPago || 'Otro';

  return `
    <tr class="${anuladoClase}">
      <td>
        <div style="font-size: 12px; color: var(--tinta);">${escapeHTML(formatoFecha(p.fecha, { corta: true }))}</div>
        <div style="font-size: 10px; color: var(--gris-suave);">${escapeHTML(fechaRelativa(p.fecha))}</div>
      </td>
      <td>
        <div class="pago-cliente-cell">
          <div class="pago-avatar">${escapeHTML(inic)}</div>
          <div style="min-width: 0;">
            <div style="font-weight: 500; color: var(--tinta); font-size: 13px;">${escapeHTML(nombre)}</div>
            ${p.anulado ? '<div style="font-size: 10px; color: var(--estado-error); text-decoration: none;">ANULADO</div>' : ''}
          </div>
        </div>
      </td>
      <td class="alinear-derecha" style="font-weight: 500;">${formatoMoneda(p.monto)}</td>
      <td class="alinear-centro"><span class="badge badge-neutral">${escapeHTML(formaPagoLabel)}</span></td>
      <td style="font-size: 12px; color: var(--gris-suave); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(p.observaciones || '')}">${escapeHTML(p.observaciones || '—')}${p.anulado && p.motivoAnulacion ? `<br><span style="color: var(--estado-error); font-style: italic;">Anulado: ${escapeHTML(p.motivoAnulacion)}</span>` : ''}</td>
      <td class="alinear-derecha">
        <div class="flex flex-gap-sm" style="justify-content: flex-end;">
          ${p.ventaId ? `<a class="btn-ver-venta" href="pedidos.html?id=${escapeHTML(p.ventaId)}">Ver venta</a>` : ''}
          ${!p.anulado ? `<button class="btn-anular" data-id="${escapeHTML(p.id)}">Anular</button>` : ''}
        </div>
      </td>
    </tr>`;
}

function obtenerNombreCliente(p) {
  if (p.clienteNombre) return p.clienteNombre;
  if (p.clienteId && clientesPorId[p.clienteId]) return clientesPorId[p.clienteId];
  if (p.clienteId) return p.clienteId.substring(0, 6).toUpperCase();
  return 'Sin cliente';
}

// =====================================================================
// ANULAR PAGO
// =====================================================================
function abrirAnular(pagoId) {
  pagoSeleccionado = pagosData.find(p => p.id === pagoId);
  if (!pagoSeleccionado) return;

  const p = pagoSeleccionado;
  $('#info-pago-anular').innerHTML = `
    <div style="display: flex; justify-content: space-between; padding: 3px 0;">
      <span style="color: var(--gris-suave); font-size: 11px;">FECHA</span>
      <span>${escapeHTML(formatoFecha(p.fecha))}</span>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 3px 0;">
      <span style="color: var(--gris-suave); font-size: 11px;">MONTO</span>
      <span style="font-weight: 500; font-family: var(--font-serif); font-size: 18px;">${formatoMoneda(p.monto)}</span>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 3px 0;">
      <span style="color: var(--gris-suave); font-size: 11px;">FORMA</span>
      <span>${escapeHTML(p.formaPago || 'otro')}</span>
    </div>
  `;
  $('#motivo-anular').value = '';
  $('#anular-error').classList.add('oculto');
  $modalAnular.classList.add('abierto');
  setTimeout(() => $('#motivo-anular').focus(), 100);
}

function cerrarAnular() {
  $modalAnular.classList.remove('abierto');
  pagoSeleccionado = null;
}

$('#cerrar-anular').addEventListener('click', cerrarAnular);
$('#btn-cancelar-anular').addEventListener('click', cerrarAnular);
$modalAnular.addEventListener('click', (e) => {
  if (e.target === $modalAnular) cerrarAnular();
});

$('#btn-confirmar-anular').addEventListener('click', async () => {
  if (!pagoSeleccionado) return;
  $('#anular-error').classList.add('oculto');
  const motivo = $('#motivo-anular').value.trim();
  const $btn = $('#btn-confirmar-anular');
  $btn.disabled = true;
  $btn.innerHTML = '<span class="cargando-spinner"></span> Anulando…';

  try {
    await anularPago(pagoSeleccionado.id, motivo);
    toast('Pago anulado.', 'ok');
    cerrarAnular();
    await recargar();
  } catch (err) {
    console.error(err);
    $('#anular-error').textContent = err.message || 'No se pudo anular el pago.';
    $('#anular-error').classList.remove('oculto');
  } finally {
    $btn.disabled = false;
    $btn.textContent = 'Confirmar anulación';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $modalAnular.classList.contains('abierto')) cerrarAnular();
});

// Carga inicial
await recargar();
