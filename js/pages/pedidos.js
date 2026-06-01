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
  listarPagosDeVenta, anularPago, actualizarEntregaItems
} from "../db.js";
import {
  $, $$, escapeHTML, toast, debounce,
  formatoMoneda, formatoFecha, fechaRelativa, RANGOS,
  generarLinkWhatsApp, TEMPLATES_WSP
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
  // Los pedidos cancelados no suman a "vendido" ni a "adeudado",
  // pero siguen apareciendo en la lista.
  const computables = ventasFiltradas.filter(v => v.estadoPedido !== "cancelado");
  const totalDeuda = computables.reduce((s, v) => s + (v.saldo || 0), 0);
  const totalVendido = computables.reduce((s, v) => s + (v.total || 0), 0);

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

  // Para "parcial-entrega", mostrar conteo de items
  let textoEstadoPedido = v.estadoPedido || 'pendiente';
  if (v.estadoPedido === "parcial-entrega") {
    const totalItems = (v.items || []).length;
    const entregados = (v.items || []).filter(it => it.entregado === true).length;
    textoEstadoPedido = `parcial (${entregados}/${totalItems})`;
  }

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
      <td class="alinear-centro"><span class="estado ${claseEstadoPedido}">${escapeHTML(textoEstadoPedido)}</span></td>
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

  // Cargar el cliente para tener su teléfono y mostrar botón de WhatsApp
  if (v.clienteId) {
    cargarBotonWhatsApp(v);
  }

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

  // Items con checkbox de entregado
  const items = v.items || [];
  $('#det-items').innerHTML = items.map((it, idx) => {
    const subtotal = it.subtotal || (it.cantidad * it.precioUnit);
    const entregadoClase = it.entregado ? 'entregado' : '';
    return `
      <div class="detalle-item ${entregadoClase}" data-codigo="${escapeHTML(it.codigo)}" data-idx="${idx}">
        <div class="check-entregado" data-codigo="${escapeHTML(it.codigo)}" title="${it.entregado ? 'Marcar como NO entregado' : 'Marcar como entregado'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="foto-d"><div class="ph">📷</div></div>
        <div>
          <div class="nom-d" title="${escapeHTML(it.nombre)}">${escapeHTML(it.nombre)}</div>
          <div class="cod-d">${escapeHTML(it.codigo)} · ${formatoMoneda(it.precioUnit)} c/u</div>
        </div>
        <div class="cant-d">×${it.cantidad}</div>
        <div class="sub-d">${formatoMoneda(subtotal)}</div>
      </div>`;
  }).join('');

  // Wire-up de checks de entregado
  $$('#det-items .check-entregado').forEach($check => {
    $check.addEventListener('click', async (e) => {
      e.stopPropagation();
      const codigo = $check.dataset.codigo;
      const item = items.find(i => i.codigo === codigo);
      if (!item) return;
      const nuevoEstado = !item.entregado;

      // Optimistic UI
      $check.closest('.detalle-item').classList.toggle('entregado', nuevoEstado);

      try {
        await actualizarEntregaItems(v.id, [{ codigo, entregado: nuevoEstado }]);
        // Actualizar localmente para mantener consistencia visual
        item.entregado = nuevoEstado;
        // Actualizar el estado del pedido en pantalla (puede haber cambiado a "entregado" / "parcial-entrega")
        const ventaFresca = await obtenerVenta(v.id);
        if (ventaFresca) {
          ventaActual = ventaFresca;
          $('#det-estado-pedido').textContent = ventaFresca.estadoPedido === "parcial-entrega" ? "parcial" : (ventaFresca.estadoPedido || 'pendiente');
          $('#det-estado-pedido').className = `estado estado-${ventaFresca.estadoPedido || 'pendiente'}`;
          $('#det-cambiar-estado').value = ventaFresca.estadoPedido === "parcial-entrega" ? "pendiente" : (ventaFresca.estadoPedido || 'pendiente');
        }
      } catch (err) {
        console.error(err);
        // Revertir UI
        $check.closest('.detalle-item').classList.toggle('entregado', !nuevoEstado);
        toast('No se pudo actualizar: ' + err.message, 'error');
      }
    });
  });

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
// BOTÓN DE WHATSAPP CONTEXTUAL EN EL DETALLE
// =====================================================================
async function cargarBotonWhatsApp(venta) {
  const $cont = $('#det-wsp-container');
  if (!$cont) return;
  $cont.innerHTML = '<small style="color: var(--gris-suave); font-size: 10px;">Cargando contacto…</small>';

  try {
    const cliente = await obtenerCliente(venta.clienteId);
    if (!cliente || !cliente.telefono) {
      $cont.innerHTML = '<small style="color: var(--gris-suave); font-size: 11px;">Sin teléfono — cargá uno en la ficha del cliente para usar WhatsApp.</small>';
      return;
    }

    const nombre = `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim() || venta.clienteNombre || '';

    // Determinar el mensaje según el estado del pedido
    let template, label;
    if (venta.estadoPedido === "cancelado") {
      template = TEMPLATES_WSP.saludoLibre({ nombreCliente: nombre });
      label = "Mensaje libre";
    } else if (venta.estadoPedido === "entregado" && venta.saldo > 0) {
      template = TEMPLATES_WSP.recordatorioCobro({
        nombreCliente: nombre,
        saldoPendiente: venta.saldo,
      });
      label = "Recordatorio de cobro";
    } else if (venta.estadoPedido === "entregado" && venta.saldo === 0) {
      template = TEMPLATES_WSP.saludoLibre({ nombreCliente: nombre });
      label = "Mensaje libre";
    } else if (venta.estadoPedido === "pendiente" && (venta.estadoPago === "pagado" || venta.saldo === 0)) {
      // Pagado pero pendiente de entrega → avisar que está listo
      template = TEMPLATES_WSP.pedidoListo({
        nombreCliente: nombre,
        total: venta.total,
        saldo: 0,
      });
      label = "Pedido listo para entregar";
    } else if (venta.estadoPedido === "pendiente") {
      // Pedido pendiente → confirmación del pedido
      template = TEMPLATES_WSP.confirmacionPedido({
        nombreCliente: nombre,
        items: venta.items || [],
        total: venta.total,
      });
      label = "Confirmar pedido";
    } else {
      // parcial-entrega u otro: aviso de listo
      template = TEMPLATES_WSP.pedidoListo({
        nombreCliente: nombre,
        total: venta.total,
        saldo: venta.saldo,
      });
      label = "Aviso de pedido";
    }

    const link = generarLinkWhatsApp(cliente.telefono, template);
    if (!link) {
      $cont.innerHTML = '<small style="color: var(--gris-suave); font-size: 11px;">Teléfono inválido.</small>';
      return;
    }

    $cont.innerHTML = `
      <a href="${link}" target="_blank" rel="noopener" class="btn-wsp" style="width: 100%; justify-content: center;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        ${escapeHTML(label)} por WhatsApp
      </a>
    `;
  } catch (err) {
    console.error('[pedidos] error cargando wsp:', err);
    $cont.innerHTML = '<small style="color: var(--gris-suave); font-size: 11px;">No se pudo cargar el contacto.</small>';
  }
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
// EDICIÓN INLINE DEL PAGADO
// =====================================================================
$('#btn-editar-pagado').addEventListener('click', () => {
  if (!ventaActual) return;
  $('#det-pagado-display').style.display = 'none';
  $('#det-pagado-edit').style.display = 'flex';
  $('#input-pagado-nuevo').value = ventaActual.pagado || 0;
  $('#input-pagado-nuevo').max = ventaActual.total;
  $('#input-pagado-nuevo').focus();
  $('#input-pagado-nuevo').select();
});

$('#btn-cancelar-pagado').addEventListener('click', () => {
  $('#det-pagado-display').style.display = 'flex';
  $('#det-pagado-edit').style.display = 'none';
});

$('#btn-aplicar-pagado').addEventListener('click', async () => {
  if (!ventaActual) return;

  const montoNuevo = Number($('#input-pagado-nuevo').value);
  const montoActual = ventaActual.pagado || 0;
  const total = ventaActual.total || 0;

  if (isNaN(montoNuevo) || montoNuevo < 0) {
    toast('Ingresá un monto válido.', 'warn');
    return;
  }
  if (montoNuevo > total) {
    toast(`El pagado no puede ser mayor al total (${formatoMoneda(total)}).`, 'warn');
    return;
  }
  if (montoNuevo === montoActual) {
    $('#det-pagado-display').style.display = 'flex';
    $('#det-pagado-edit').style.display = 'none';
    return;
  }

  const $btn = $('#btn-aplicar-pagado');
  $btn.disabled = true;
  $btn.innerHTML = '<span class="cargando-spinner"></span>';

  try {
    if (montoNuevo > montoActual) {
      // Caso A: subir el monto → registrar pago adicional
      const diferencia = montoNuevo - montoActual;
      if (!confirm(`Vas a registrar un pago adicional de ${formatoMoneda(diferencia)}.\n\n¿Continuar?`)) {
        $btn.disabled = false;
        $btn.textContent = 'Aplicar';
        return;
      }
      await registrarPago({
        ventaId:       ventaActual.id,
        monto:         diferencia,
        formaPago:     ventaActual.formaPago || 'efectivo',
        observaciones: 'Ajuste de pagado desde el detalle del pedido',
      });
      toast('Pago registrado.', 'ok');

    } else {
      // Caso B: bajar el monto → hay que anular pagos hasta llegar al monto deseado
      const reducir = montoActual - montoNuevo;
      if (!confirm(`Vas a reducir el pagado de ${formatoMoneda(montoActual)} a ${formatoMoneda(montoNuevo)}.\n\nSe van a anular pagos por un total de ${formatoMoneda(reducir)} (empezando por los más recientes).\n\n¿Continuar?`)) {
        $btn.disabled = false;
        $btn.textContent = 'Aplicar';
        return;
      }

      // Buscar los pagos no anulados, ordenados por fecha (más recientes primero)
      const pagos = await listarPagosDeVenta(ventaActual.id);
      const pagosActivos = pagos.filter(p => p.anulado !== true);

      // Si reducir == suma exacta de algunos pagos, los anulamos.
      // Si no, anulamos los más nuevos hasta acercarnos lo más posible.
      let restante = reducir;
      const anular = [];
      for (const p of pagosActivos) {
        if (restante <= 0) break;
        if (p.monto <= restante) {
          anular.push(p);
          restante -= p.monto;
        }
      }

      if (restante > 0) {
        toast(`No se puede ajustar exacto. Quedarían ${formatoMoneda(restante)} sin poder restar (los pagos no calzan exacto). Anulá pagos manualmente desde el historial.`, 'warn');
        $btn.disabled = false;
        $btn.textContent = 'Aplicar';
        return;
      }

      // Anular en serie
      for (const p of anular) {
        await anularPago(p.id, 'Ajuste de pagado desde el detalle del pedido');
      }
      toast(`Pagos anulados (${anular.length}).`, 'ok');
    }

    // Recargar el detalle con los datos frescos
    const ventaFresca = await obtenerVenta(ventaActual.id);
    if (ventaFresca) {
      ventaActual = ventaFresca;
      abrirDetalle(ventaActual.id);  // refresca todo el modal
    }
    await recargar();  // refresca la tabla principal

  } catch (err) {
    console.error(err);
    toast('Error: ' + err.message, 'error');
  } finally {
    $btn.disabled = false;
    $btn.textContent = 'Aplicar';
  }
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
