// =====================================================================
// Emanuel Cosméticos · Pedidos (js/pages/pedidos.js)
// ---------------------------------------------------------------------
// - Lista todas las ventas con filtros combinables
// - Soporta deep-link: ?id=xxx abre detalle, ?filtro=debe preselecciona filtro
// - Modal de detalle con items, totales y acciones
// - Modal de pago parcial con transacción atómica
// =====================================================================

import { requireAuth } from "../auth.js";
import { renderLayout } from "../layout.js";
import {
  listarVentas, obtenerVenta, cambiarEstadoPedido, registrarPago, obtenerCliente,
  listarPagosDeVenta, anularPago
} from "../db.js";
import {
  $, $$, escapeHTML, toast, debounce,
  formatoMoneda, formatoFecha, fechaRelativa, RANGOS
} from "../utils.js";

// =====================================================================
// Captura de errores
// =====================================================================
window.addEventListener('error', (e) => {
  console.error('[pedidos] error:', e.error || e.message);
  toast('Error: ' + (e.error?.message || e.message), 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[pedidos] unhandled:', e.reason);
  toast('Error: ' + (e.reason?.message || String(e.reason)), 'error');
});

// =====================================================================
// Init
// =====================================================================
const usuario = await requireAuth();
document.getElementById('pantalla-carga').style.display = 'none';
document.getElementById('app').style.display = 'grid';
renderLayout({ usuario, paginaActiva: "pedidos" });

// =====================================================================
// Estado
// =====================================================================
let ventas = [];
let ventasFiltradas = [];
let ventaActual = null;     // venta abierta en el detalle

// Refs
const $buscador        = $('#buscador');
const $filtroPago      = $('#filtro-estado-pago');
const $filtroPedido    = $('#filtro-estado-pedido');
const $filtroRango     = $('#filtro-rango');
const $btnLimpiar      = $('#btn-limpiar');
const $tbody           = $('#tbody-pedidos');
const $resumen         = $('#resumen-pedidos');
const $modalDetalle    = $('#modal-detalle');
const $modalPago       = $('#modal-pago');

// =====================================================================
// Mapeo de filtros desde URL
// =====================================================================
const params = new URLSearchParams(location.search);

// Sugerir filtros desde QS (compatible con clicks del dashboard)
const filtroQS = params.get('filtro');
if (filtroQS === "debe")       $filtroPago.value = "debe";
if (filtroQS === "parcial")    $filtroPago.value = "parcial";
if (filtroQS === "pagado")     $filtroPago.value = "pagado";
if (filtroQS === "pendiente")  $filtroPedido.value = "pendiente";
if (filtroQS === "entregado")  $filtroPedido.value = "entregado";

const rangoQS = params.get('rango');
if (rangoQS && RANGOS[rangoQS]) $filtroRango.value = rangoQS;

// =====================================================================
// CARGA
// =====================================================================
async function recargar() {
  $tbody.innerHTML = `<tr><td colspan="7"><div class="vacio"><p>Cargando…</p></div></td></tr>`;
  try {
    // Si hay filtro de rango activo, traemos solo ese período (más eficiente)
    const rangoActivo = $filtroRango.value;
    let desde = null, hasta = null;
    if (rangoActivo && RANGOS[rangoActivo]) {
      const r = RANGOS[rangoActivo]();
      desde = r.desde;
      hasta = r.hasta;
    }

    ventas = await listarVentas({ desde, hasta });
    aplicarFiltros();
  } catch (e) {
    console.error(e);
    $tbody.innerHTML = `<tr><td colspan="7">
      <div class="alerta alerta-error" style="margin: 20px;">
        ${escapeHTML(e.message || 'Error cargando pedidos')}
      </div>
    </td></tr>`;
  }
}

// =====================================================================
// FILTROS
// =====================================================================
function aplicarFiltros() {
  const texto = $buscador.value.toLowerCase().trim();
  const fp    = $filtroPago.value;
  const fped  = $filtroPedido.value;

  ventasFiltradas = ventas.filter(v => {
    if (fp   && v.estadoPago    !== fp)   return false;
    if (fped && v.estadoPedido  !== fped) return false;

    if (texto) {
      const itemsTxt = (v.items || []).map(it => `${it.codigo} ${it.nombre}`).join(' ').toLowerCase();
      const blob = `${v.clienteNombre || ''} ${itemsTxt}`.toLowerCase();
      if (!blob.includes(texto)) return false;
    }
    return true;
  });

  renderLista();
}

$buscador.addEventListener('input', debounce(aplicarFiltros, 200));
$filtroPago.addEventListener('change', aplicarFiltros);
$filtroPedido.addEventListener('change', aplicarFiltros);
$filtroRango.addEventListener('change', recargar);
$btnLimpiar.addEventListener('click', () => {
  $buscador.value = '';
  $filtroPago.value = '';
  $filtroPedido.value = '';
  $filtroRango.value = '';
  recargar();
});

// =====================================================================
// RENDER LISTA
// =====================================================================
function renderLista() {
  const total = ventas.length;
  const visibles = ventasFiltradas.length;
  const totalDeuda = ventasFiltradas.reduce((s, v) => s + (v.saldo || 0), 0);
  const totalVendido = ventasFiltradas.reduce((s, v) => s + (v.total || 0), 0);

  $resumen.textContent = total === 0
    ? "Todavía no hay pedidos. Empezá tocando '+ Nueva venta'."
    : `${visibles} ${visibles === 1 ? 'pedido' : 'pedidos'} · vendido: ${formatoMoneda(totalVendido)} · adeudado: ${formatoMoneda(totalDeuda)}`;

  if (visibles === 0) {
    $tbody.innerHTML = `<tr><td colspan="7">
      <div class="vacio">
        <h3>${total === 0 ? 'Sin pedidos' : 'Sin resultados'}</h3>
        <p>${total === 0
          ? 'Creá tu primera venta para empezar.'
          : 'Probá cambiar los filtros.'}</p>
      </div>
    </td></tr>`;
    return;
  }

  $tbody.innerHTML = ventasFiltradas.map(v => filaVenta(v)).join('');

  $$('#tbody-pedidos tr[data-id]').forEach($tr => {
    $tr.addEventListener('click', () => abrirDetalle($tr.dataset.id));
  });
}

function filaVenta(v) {
  const nombre = v.clienteNombre || 'Sin nombre';
  const inic = nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();

  const claseEstadoPago = `estado-${v.estadoPago || 'debe'}`;
  const claseEstadoPedido = `estado-${v.estadoPedido || 'pendiente'}`;

  const itemsResumen = (v.items || []).length;
  const resumenItems = itemsResumen === 1
    ? (v.items[0]?.nombre || '').substring(0, 40)
    : `${itemsResumen} productos`;

  return `
    <tr data-id="${escapeHTML(v.id)}">
      <td>
        <div style="font-size: 12px; color: var(--tinta);">${escapeHTML(formatoFecha(v.fechaVenta, { corta: true }))}</div>
        <div style="font-size: 10px; color: var(--gris-suave);">${escapeHTML(fechaRelativa(v.fechaVenta))}</div>
      </td>
      <td>
        <div class="cliente-cell">
          <div class="avatar-tabla">${escapeHTML(inic)}</div>
          <div style="min-width: 0;">
            <div style="font-weight: 500; color: var(--tinta); font-size: 13px;">${escapeHTML(nombre)}</div>
            <div style="font-size: 11px; color: var(--gris-suave); overflow: hidden; text-overflow: ellipsis; max-width: 220px; white-space: nowrap;">${escapeHTML(resumenItems)}</div>
          </div>
        </div>
      </td>
      <td class="alinear-derecha" style="font-weight: 500;">${formatoMoneda(v.total)}</td>
      <td class="alinear-derecha" style="color: var(--estado-ok);">${formatoMoneda(v.pagado)}</td>
      <td class="alinear-derecha" style="${(v.saldo || 0) > 0 ? 'color: var(--estado-error); font-weight: 500;' : 'color: var(--gris-suave);'}">${formatoMoneda(v.saldo)}</td>
      <td class="alinear-centro"><span class="estado ${claseEstadoPago}">${escapeHTML(v.estadoPago || 'debe')}</span></td>
      <td class="alinear-centro"><span class="estado ${claseEstadoPedido}">${escapeHTML(v.estadoPedido || 'pendiente')}</span></td>
    </tr>`;
}

// =====================================================================
// MODAL DETALLE
// =====================================================================
async function abrirDetalle(ventaId) {
  let v = ventas.find(x => x.id === ventaId);
  if (!v) {
    try { v = await obtenerVenta(ventaId); }
    catch (e) { toast('No se pudo cargar el pedido.', 'error'); return; }
  }
  if (!v) { toast('Pedido no encontrado.', 'warn'); return; }

  ventaActual = v;

  const nombre = v.clienteNombre || 'Sin nombre';
  const inic = nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();

  $('#det-titulo').textContent = `Pedido del ${formatoFecha(v.fechaVenta)}`;
  $('#det-meta').textContent = `ID ${v.id.substring(0, 8).toUpperCase()} · ${fechaRelativa(v.fechaVenta)}`;
  $('#det-cliente-avatar').textContent = inic;
  $('#det-cliente-nombre').textContent = nombre;
  $('#det-cliente-meta').textContent = v.clienteId ? `Cliente #${v.clienteId.substring(0, 6).toUpperCase()}` : '—';
  $('#det-ver-ficha').href = `clientes.html?id=${encodeURIComponent(v.clienteId || '')}`;

  // Estados
  $('#det-estado-pago').textContent = v.estadoPago || 'debe';
  $('#det-estado-pago').className = `estado estado-${v.estadoPago || 'debe'}`;
  $('#det-estado-pedido').textContent = v.estadoPedido || 'pendiente';
  $('#det-estado-pedido').className = `estado estado-${v.estadoPedido || 'pendiente'}`;

  const formasLabel = {
    efectivo: 'Efectivo',
    transferencia: 'Transferencia',
    mercadopago: 'Mercado Pago',
    otro: 'Otro'
  };
  $('#det-forma-pago').textContent = formasLabel[v.formaPago] || v.formaPago || 'Efectivo';

  // Items
  const items = v.items || [];
  $('#det-items').innerHTML = items.map(it => {
    const subtotal = it.subtotal || (it.cantidad * it.precioUnit);
    return `
      <div class="detalle-item">
        <div class="foto-d"><div class="ph">📷</div></div>
        <div>
          <div class="nom-d" title="${escapeHTML(it.nombre)}">${escapeHTML(it.nombre)}</div>
          <div class="cod-d">${escapeHTML(it.codigo)} · ${formatoMoneda(it.precioUnit)} c/u</div>
        </div>
        <div class="cant-d">×${it.cantidad}</div>
        <div class="sub-d">${formatoMoneda(subtotal)}</div>
      </div>`;
  }).join('');

  // Totales
  $('#det-subtotal').textContent = formatoMoneda(v.total);
  $('#det-pagado').textContent   = formatoMoneda(v.pagado);
  const $saldo = $('#det-saldo');
  $saldo.textContent = formatoMoneda(v.saldo);
  $saldo.style.color = (v.saldo || 0) > 0 ? 'var(--estado-error)' : 'var(--estado-ok)';

  // Observaciones
  if (v.observaciones) {
    $('#det-obs-bloque').style.display = 'block';
    $('#det-obs').textContent = v.observaciones;
  } else {
    $('#det-obs-bloque').style.display = 'none';
  }

  // Selector editable de estado del pedido
  $('#det-cambiar-estado').value = v.estadoPedido || 'pendiente';

  // Botón de pago: solo si hay saldo y no está cancelado
  const $btnPago = $('#det-pago');
  if (v.estadoPedido === "cancelado") {
    $btnPago.style.display = 'none';
  } else {
    $btnPago.style.display = (v.saldo || 0) > 0 ? '' : 'none';
  }

  // Cargar historial de pagos
  cargarHistorialPagos(v.id);

  $modalDetalle.classList.add('abierto');
}

// =====================================================================
// HISTORIAL DE PAGOS DENTRO DEL DETALLE
// =====================================================================
async function cargarHistorialPagos(ventaId) {
  const $bloque = $('#det-pagos-bloque');
  const $lista = $('#det-pagos-lista');
  $bloque.style.display = 'block';
  $lista.innerHTML = '<div style="text-align: center; padding: 10px; color: var(--gris-suave); font-size: 12px;">Cargando…</div>';

  try {
    const pagos = await listarPagosDeVenta(ventaId);
    if (pagos.length === 0) {
      $lista.innerHTML = '<div style="text-align: center; padding: 10px; color: var(--gris-suave); font-size: 12px;">Sin pagos registrados.</div>';
      return;
    }

    $lista.innerHTML = pagos.map(p => {
      const anuladoStyle = p.anulado ? 'opacity: 0.5; text-decoration: line-through;' : '';
      return `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--linea); ${anuladoStyle}">
          <div style="min-width: 0; flex: 1;">
            <div style="font-size: 13px; font-weight: 500; color: var(--tinta);">
              ${formatoMoneda(p.monto)}
              ${p.anulado ? '<span style="color: var(--estado-error); font-size: 10px; text-decoration: none; margin-left: 6px;">ANULADO</span>' : ''}
            </div>
            <div style="font-size: 11px; color: var(--gris-suave);">
              ${escapeHTML(formatoFecha(p.fecha))} · ${escapeHTML(p.formaPago || 'efectivo')}
              ${p.observaciones ? `<br>${escapeHTML(p.observaciones)}` : ''}
              ${p.anulado && p.motivoAnulacion ? `<br><span style="color: var(--estado-error); font-style: italic; text-decoration: none;">Anulado: ${escapeHTML(p.motivoAnulacion)}</span>` : ''}
            </div>
          </div>
          ${!p.anulado ? `<button class="btn-anular-pago-detalle" data-id="${escapeHTML(p.id)}" style="background: transparent; border: 1px solid var(--linea); color: var(--estado-error); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-family: inherit; flex-shrink: 0; margin-left: 10px;">Anular</button>` : ''}
        </div>`;
    }).join('');

    // Wire-up de los botones anular
    $$('.btn-anular-pago-detalle[data-id]').forEach($btn => {
      $btn.addEventListener('click', async () => {
        const pagoId = $btn.dataset.id;
        const pago = pagos.find(p => p.id === pagoId);
        if (!pago) return;
        const motivo = prompt(`¿Anular este pago de ${formatoMoneda(pago.monto)}?\n\nMotivo (opcional):`);
        if (motivo === null) return; // canceló
        try {
          await anularPago(pagoId, motivo);
          toast('Pago anulado.', 'ok');
          // Recargar el detalle y la lista de pedidos
          await recargar();
          // Reabrir el detalle con datos frescos
          const ventaFresca = await obtenerVenta(ventaId);
          if (ventaFresca) {
            ventaActual = ventaFresca;
            abrirDetalle(ventaId);
          }
        } catch (err) {
          toast('No se pudo anular: ' + err.message, 'error');
        }
      });
    });
  } catch (err) {
    console.error('[pedidos] error cargando pagos:', err);
    $lista.innerHTML = `<div style="color: var(--estado-error); font-size: 12px; padding: 10px;">No se pudo cargar el historial.</div>`;
  }
}

function cerrarDetalle() {
  $modalDetalle.classList.remove('abierto');
  ventaActual = null;
  // Limpiar QS para no reabrir en F5
  if (params.get('id')) {
    history.replaceState(null, '', location.pathname);
  }
}

$('#cerrar-detalle').addEventListener('click', cerrarDetalle);
$modalDetalle.addEventListener('click', (e) => {
  if (e.target === $modalDetalle) cerrarDetalle();
});

// =====================================================================
// CAMBIAR ESTADO DEL PEDIDO (selector editable)
// =====================================================================
$('#det-aplicar-estado').addEventListener('click', async () => {
  if (!ventaActual) return;
  const nuevoEstado = $('#det-cambiar-estado').value;
  if (nuevoEstado === ventaActual.estadoPedido) {
    toast('El pedido ya está en ese estado.', 'info');
    return;
  }

  let mensaje;
  if (nuevoEstado === "cancelado") {
    mensaje = (ventaActual.pagado || 0) > 0
      ? `Cancelar este pedido revierte el saldo del cliente.\n\nEl cliente ya pagó ${formatoMoneda(ventaActual.pagado)}, ese monto se descontará de su total pagado.\n\n¿Continuar?`
      : "¿Cancelar este pedido?";
  } else if (nuevoEstado === "entregado") {
    mensaje = "¿Marcar este pedido como entregado?";
  } else {
    mensaje = "¿Cambiar el estado a 'Pendiente de entrega'?";
  }
  if (!confirm(mensaje)) {
    $('#det-cambiar-estado').value = ventaActual.estadoPedido; // restaurar
    return;
  }

  const $btn = $('#det-aplicar-estado');
  $btn.disabled = true;
  $btn.innerHTML = '<span class="cargando-spinner"></span>';

  try {
    await cambiarEstadoPedido(ventaActual.id, nuevoEstado);
    toast(`Pedido marcado como ${nuevoEstado}.`, 'ok');
    cerrarDetalle();
    await recargar();
  } catch (err) {
    toast('No se pudo actualizar: ' + err.message, 'error');
  } finally {
    $btn.disabled = false;
    $btn.textContent = 'Aplicar';
  }
});

// =====================================================================
// MODAL DE PAGO PARCIAL
// =====================================================================
$('#det-pago').addEventListener('click', () => {
  if (!ventaActual) return;
  const saldo = ventaActual.saldo || 0;
  if (saldo <= 0) return;

  $('#pago-total').textContent  = formatoMoneda(ventaActual.total);
  $('#pago-pagado').textContent = formatoMoneda(ventaActual.pagado);
  $('#pago-saldo').textContent  = formatoMoneda(saldo);
  $('#pago-monto').value = saldo;  // Pre-llenar con saldo completo
  $('#pago-monto').max = saldo;
  $('#pago-forma').value = ventaActual.formaPago || 'efectivo';
  $('#pago-obs').value = '';
  $('#pago-error').classList.add('oculto');

  $modalPago.classList.add('abierto');
  setTimeout(() => $('#pago-monto').select(), 100);
});

function cerrarModalPago() { $modalPago.classList.remove('abierto'); }

$('#cerrar-pago').addEventListener('click', cerrarModalPago);
$('#btn-cancelar-pago').addEventListener('click', cerrarModalPago);
$modalPago.addEventListener('click', (e) => {
  if (e.target === $modalPago) cerrarModalPago();
});

$('#btn-confirmar-pago').addEventListener('click', async () => {
  $('#pago-error').classList.add('oculto');

  const monto = Number($('#pago-monto').value);
  const saldo = ventaActual?.saldo || 0;

  if (!monto || monto <= 0) {
    return mostrarErrorPago("Ingresá un monto válido.");
  }
  if (monto > saldo) {
    return mostrarErrorPago(`El monto excede el saldo (${formatoMoneda(saldo)}).`);
  }

  const $btn = $('#btn-confirmar-pago');
  $btn.disabled = true;
  $btn.innerHTML = '<span class="cargando-spinner"></span> Registrando…';

  try {
    await registrarPago({
      ventaId:       ventaActual.id,
      monto,
      formaPago:     $('#pago-forma').value,
      observaciones: $('#pago-obs').value.trim(),
    });
    toast('Pago registrado.', 'ok');
    cerrarModalPago();
    cerrarDetalle();
    await recargar();
  } catch (err) {
    console.error('[pedidos] error registrando pago:', err);
    mostrarErrorPago(err.message || "No se pudo registrar el pago.");
  } finally {
    $btn.disabled = false;
    $btn.textContent = 'Confirmar pago';
  }
});

function mostrarErrorPago(msg) {
  $('#pago-error').textContent = msg;
  $('#pago-error').classList.remove('oculto');
}

// Cerrar con Esc
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($modalPago.classList.contains('abierto'))    cerrarModalPago();
    else if ($modalDetalle.classList.contains('abierto')) cerrarDetalle();
  }
});

// =====================================================================
// CARGA INICIAL + deep-link
// =====================================================================
await recargar();

const idQS = params.get('id');
if (idQS) {
  setTimeout(() => abrirDetalle(idQS), 300);
}
