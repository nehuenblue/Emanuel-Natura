// =====================================================================
// Emanuel Cosméticos · Clientes (js/pages/clientes.js)
// ---------------------------------------------------------------------
// Funcionalidad:
//   - Listado paginado con buscador en vivo + filtros (estado, zona)
//   - Selección múltiple para acciones masivas (PDF/Excel/WhatsApp en F8)
//   - Modal de alta/edición con validaciones
//   - Mini-mapa Leaflet integrado: click marca, pegar coords funciona
//   - Modal de ficha individual con KPIs, datos, ubicación
//   - Acceso vía ?id=xxx para abrir ficha directo desde el dashboard
// =====================================================================

import { requireAuth } from "../auth.js";
import { renderLayout } from "../layout.js";
import {
  listarClientes, listarZonas, crearCliente, actualizarCliente,
  obtenerCliente, darDeBajaCliente, reactivarCliente,
  GeoPoint
} from "../db.js";
import {
  $, $$, escapeHTML, toast, debounce, formatoMoneda, formatoMonedaPartes,
  formatoFecha, fechaRelativa, esTelefonoArgentino, normalizarTelefono
} from "../utils.js";

// =====================================================================
// Captura global de errores
// =====================================================================
window.addEventListener('error', (e) => {
  console.error('[clientes] error:', e.error || e.message);
  mostrarErrorFatal(e.error?.message || e.message || 'Error desconocido', e.error?.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[clientes] unhandled:', e.reason);
  mostrarErrorFatal(e.reason?.message || String(e.reason), e.reason?.stack);
});

function mostrarErrorFatal(mensaje, stack) {
  const $carga = document.getElementById('pantalla-carga');
  if ($carga) $carga.style.display = 'none';
  const $app = document.getElementById('app');
  if ($app) $app.style.display = 'grid';

  let $aviso = document.getElementById('aviso-inicial');
  if (!$aviso) {
    $aviso = document.createElement('div');
    $aviso.id = 'aviso-inicial';
    $aviso.style.cssText = 'padding: 40px; max-width: 720px; margin: 40px auto;';
    document.body.appendChild($aviso);
  }
  $aviso.innerHTML = `
    <div class="alerta alerta-error">
      <strong>Error al cargar clientes</strong><br>
      ${escapeHTML(mensaje)}
      ${stack ? `<details style="margin-top:10px;"><summary style="cursor:pointer; font-size:12px;">Detalles</summary><pre style="font-size:11px; margin-top:8px; background:#fdf8f3; padding:10px; border-radius:6px; overflow:auto; max-height:200px;">${escapeHTML(stack)}</pre></details>` : ''}
    </div>`;
}

// =====================================================================
// Inicialización
// =====================================================================
const usuario = await requireAuth();
document.getElementById('pantalla-carga').style.display = 'none';
document.getElementById('app').style.display = 'grid';
renderLayout({ usuario, paginaActiva: "clientes" });

// =====================================================================
// Estado
// =====================================================================
let clientesData     = [];      // todos los clientes traídos de Firestore
let clientesFiltrados = [];     // los que matchean los filtros actuales
let seleccionados    = new Set(); // IDs seleccionados
let mapaForm         = null;    // instancia Leaflet del modal alta/edición
let markerForm       = null;
let mapaFicha        = null;
let modoEdicion      = false;   // false = alta, true = edición

const $buscador        = $('#buscador');
const $filtroEstado    = $('#filtro-estado');
const $filtroZona      = $('#filtro-zona');
const $btnLimpiar      = $('#btn-limpiar-filtros');
const $btnNuevo        = $('#btn-nuevo');
const $lista           = $('#lista-clientes');
const $resumen         = $('#resumen-clientes');
const $barraSeleccion  = $('#barra-seleccion');
const $contSeleccion   = $('#contador-seleccion');
const $totalMostrados  = $('#total-mostrados');
const $btnSelAll       = $('#btn-seleccionar-todos');
const $btnQuitarSel    = $('#btn-quitar-seleccion');

// =====================================================================
// CARGA INICIAL
// =====================================================================
async function recargar() {
  $lista.innerHTML = `
    <div style="padding: 40px;">
      ${Array(5).fill(0).map(() => `
        <div style="display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--linea);">
          <div class="skeleton" style="width: 40px; height: 40px; border-radius: 50%;"></div>
          <div style="flex:1;">
            <div class="skeleton skeleton-text" style="width: 50%; margin-bottom: 8px;"></div>
            <div class="skeleton skeleton-text" style="width: 30%; height: 10px;"></div>
          </div>
          <div class="skeleton skeleton-text" style="width: 80px;"></div>
        </div>`).join('')}
    </div>`;

  try {
    clientesData = await listarClientes();

    // Llenar el dropdown de zonas con las que existen
    const zonas = [...new Set(clientesData.map(c => c.zona).filter(Boolean))].sort();
    $filtroZona.innerHTML = '<option value="">Todas las zonas</option>' +
      zonas.map(z => `<option value="${escapeHTML(z)}">${escapeHTML(z)}</option>`).join('');

    // También llenar el datalist del form
    const $datalist = document.getElementById('zonas-existentes');
    if ($datalist) {
      $datalist.innerHTML = zonas.map(z => `<option value="${escapeHTML(z)}">`).join('');
    }

    aplicarFiltros();
  } catch (e) {
    mostrarErrorFatal(e.message || String(e), e.stack);
  }
}

// =====================================================================
// FILTROS + BUSCADOR
// =====================================================================
function aplicarFiltros() {
  const texto      = ($buscador.value || '').toLowerCase().trim();
  const filtroEst  = $filtroEstado.value;
  const filtroZona = $filtroZona.value;

  clientesFiltrados = clientesData.filter(c => {
    // Estado
    if (filtroEst === "deudores" && !((c.saldoPendiente || 0) > 0)) return false;
    if (filtroEst === "al-dia"   && ((c.saldoPendiente || 0) > 0 || c.estado === "inactivo")) return false;
    if (filtroEst === "inactivos" && c.estado !== "inactivo") return false;
    if (filtroEst === "todos" && c.estado === "inactivo") {
      // En "todos" mostramos activos por default; los inactivos van en su tab
      // (excepto si el usuario buscó por texto algo específico)
      if (!texto) return false;
    }

    // Zona
    if (filtroZona && c.zona !== filtroZona) return false;

    // Texto: buscar en nombre, apellido, teléfono, dirección, zona, observaciones
    if (texto) {
      const blob = [c.nombre, c.apellido, c.telefono, c.direccion, c.zona, c.observaciones]
        .filter(Boolean).join(' ').toLowerCase();
      if (!blob.includes(texto)) return false;
    }

    return true;
  });

  renderLista();
}

$buscador.addEventListener('input', debounce(aplicarFiltros, 200));
$filtroEstado.addEventListener('change', aplicarFiltros);
$filtroZona.addEventListener('change', aplicarFiltros);
$btnLimpiar.addEventListener('click', () => {
  $buscador.value = '';
  $filtroEstado.value = 'todos';
  $filtroZona.value = '';
  aplicarFiltros();
});

// =====================================================================
// RENDER LISTA
// =====================================================================
function renderLista() {
  const total = clientesData.length;
  const visibles = clientesFiltrados.length;
  const conDeuda = clientesData.filter(c => (c.saldoPendiente || 0) > 0).length;

  $resumen.textContent = total === 0
    ? "Todavía no cargaste clientes. Empezá tocando 'Nuevo cliente'."
    : `${total} ${total === 1 ? 'cliente' : 'clientes'} en total · ${conDeuda} con deuda · mostrando ${visibles}`;

  $totalMostrados.textContent = visibles;

  if (visibles === 0) {
    $lista.innerHTML = `
      <div class="vacio">
        <h3>${total === 0 ? 'Sin clientes todavía' : 'Sin resultados'}</h3>
        <p>${total === 0
          ? 'Hacé click en "Nuevo cliente" arriba a la derecha para empezar a cargar tu cartera.'
          : 'Probá cambiar los filtros o limpiar la búsqueda.'}</p>
      </div>`;
    return;
  }

  $lista.innerHTML = clientesFiltrados.map(c => filaCliente(c)).join('');

  // Wire-up de eventos de cada fila
  $$('.fila-cliente').forEach($fila => {
    const id = $fila.dataset.id;
    $fila.querySelector('.checkbox-fila')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSeleccion(id);
    });
    $fila.querySelector('.fila-cuerpo')?.addEventListener('click', () => abrirFicha(id));
  });
}

function filaCliente(c) {
  const nombre   = `${c.nombre || ''} ${c.apellido || ''}`.trim() || 'Sin nombre';
  const inic     = nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  const debe     = (c.saldoPendiente || 0) > 0;
  const inactivo = c.estado === "inactivo";
  const checked  = seleccionados.has(c.id);

  return `
    <div class="fila-cliente" data-id="${c.id}" style="display: flex; align-items: center; padding: 14px 20px; border-bottom: 1px solid var(--linea); gap: 14px; ${inactivo ? 'opacity: 0.55;' : ''}">

      <!-- Checkbox -->
      <div class="checkbox-fila" style="cursor: pointer; padding: 4px;">
        <div style="width: 18px; height: 18px; border-radius: 4px; border: 2px solid ${checked ? 'var(--terracota)' : 'var(--gris-suave)'}; background: ${checked ? 'var(--terracota)' : 'transparent'}; display: flex; align-items: center; justify-content: center; transition: all 0.15s;">
          ${checked ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </div>
      </div>

      <!-- Cuerpo clickeable (abre ficha) -->
      <div class="fila-cuerpo" style="flex: 1; display: flex; align-items: center; gap: 14px; cursor: pointer; min-width: 0;">

        <!-- Avatar -->
        <div style="width: 40px; height: 40px; background: var(--rose-claro); color: var(--terracota); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 500; font-size: 14px; flex-shrink: 0;">${escapeHTML(inic)}</div>

        <!-- Datos -->
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 14px; font-weight: 500; color: var(--tinta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${escapeHTML(nombre)}
            ${inactivo ? '<span class="badge badge-neutral" style="margin-left: 6px;">Inactivo</span>' : ''}
          </div>
          <div style="font-size: 12px; color: var(--gris-suave); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${c.telefono ? `<span>${escapeHTML(c.telefono)}</span>` : ''}
            ${c.telefono && (c.zona || c.direccion) ? ' · ' : ''}
            ${c.zona ? `<span>${escapeHTML(c.zona)}</span>` : ''}
            ${c.zona && c.direccion ? ' · ' : ''}
            ${c.direccion ? `<span>${escapeHTML(c.direccion)}</span>` : ''}
            ${!c.telefono && !c.zona && !c.direccion ? '<span style="font-style: italic;">Sin datos de contacto</span>' : ''}
          </div>
        </div>

        <!-- Saldo -->
        <div style="text-align: right; flex-shrink: 0;">
          ${debe ? `
            <div style="font-family: var(--font-serif); font-size: 18px; color: var(--estado-error); white-space: nowrap;">
              ${formatoMoneda(c.saldoPendiente, { compacto: true })}
            </div>
            <div style="font-size: 10px; color: var(--gris-suave); letter-spacing: 0.1em; text-transform: uppercase; margin-top: 2px;">adeudado</div>
          ` : `
            <span class="badge badge-ok">Al día</span>
          `}
        </div>
      </div>
    </div>`;
}

// =====================================================================
// SELECCIÓN MÚLTIPLE
// =====================================================================
function toggleSeleccion(id) {
  if (seleccionados.has(id)) seleccionados.delete(id);
  else seleccionados.add(id);
  actualizarBarraSeleccion();
  // Re-renderizar solo esa fila no es trivial sin librería, mejor todo:
  renderLista();
}

function actualizarBarraSeleccion() {
  const n = seleccionados.size;
  if (n === 0) {
    $barraSeleccion.classList.add('oculto');
  } else {
    $barraSeleccion.classList.remove('oculto');
    $contSeleccion.textContent = `${n} ${n === 1 ? 'seleccionado' : 'seleccionados'}`;
  }
}

$btnSelAll.addEventListener('click', () => {
  // Si ya están todos los visibles seleccionados, deseleccionar; sino, seleccionar todos los visibles
  const idsVisibles = clientesFiltrados.map(c => c.id);
  const todosYa = idsVisibles.every(id => seleccionados.has(id));
  if (todosYa) {
    idsVisibles.forEach(id => seleccionados.delete(id));
  } else {
    idsVisibles.forEach(id => seleccionados.add(id));
  }
  actualizarBarraSeleccion();
  renderLista();
});

$btnQuitarSel.addEventListener('click', () => {
  seleccionados.clear();
  actualizarBarraSeleccion();
  renderLista();
});

// =====================================================================
// MODAL ALTA / EDICIÓN
// =====================================================================
const $modalForm    = $('#modal-form');
const $formCliente  = $('#form-cliente');
const $tituloForm   = $('#titulo-form');
const $btnGuardar   = $('#btn-guardar');
const $formError    = $('#form-error');

function abrirModalForm(cliente = null) {
  modoEdicion = !!cliente;
  $tituloForm.textContent = modoEdicion ? "Editar cliente" : "Nuevo cliente";
  $formError.classList.add('oculto');

  // Reset
  $formCliente.reset();
  $('#cliente-id').value     = '';
  $('#f-coords').value       = '';

  if (cliente) {
    $('#cliente-id').value      = cliente.id;
    $('#f-nombre').value        = cliente.nombre || '';
    $('#f-apellido').value      = cliente.apellido || '';
    $('#f-telefono').value      = cliente.telefono || '';
    $('#f-zona').value          = cliente.zona || '';
    $('#f-direccion').value     = cliente.direccion || '';
    $('#f-observaciones').value = cliente.observaciones || '';
    if (cliente.ubicacion) {
      const lat = cliente.ubicacion.latitude  ?? cliente.ubicacion._lat;
      const lng = cliente.ubicacion.longitude ?? cliente.ubicacion._long;
      $('#f-coords').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
  }

  $modalForm.classList.add('abierto');

  // Inicializar mapa después de que se muestre (Leaflet necesita el div visible)
  setTimeout(() => inicializarMapaForm(cliente), 100);
}

function cerrarModalForm() {
  $modalForm.classList.remove('abierto');
  if (mapaForm) {
    mapaForm.remove();
    mapaForm = null;
    markerForm = null;
  }
}

function inicializarMapaForm(cliente) {
  const $div = document.getElementById('mapa-form');
  if (!$div) return;

  // Centro inicial: ubicación del cliente, sino Zapala (centro Patagonia)
  let centroLat = -38.902, centroLng = -70.065, zoom = 13;
  if (cliente?.ubicacion) {
    centroLat = cliente.ubicacion.latitude  ?? cliente.ubicacion._lat;
    centroLng = cliente.ubicacion.longitude ?? cliente.ubicacion._long;
    zoom = 16;
  }

  mapaForm = L.map($div).setView([centroLat, centroLng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
  }).addTo(mapaForm);

  if (cliente?.ubicacion) {
    markerForm = L.marker([centroLat, centroLng]).addTo(mapaForm);
  }

  mapaForm.on('click', (e) => {
    const { lat, lng } = e.latlng;
    setMarkerForm(lat, lng);
    $('#f-coords').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  });

  // Forzar refresh por si el mapa estaba oculto
  setTimeout(() => mapaForm?.invalidateSize(), 100);
}

function setMarkerForm(lat, lng) {
  if (!mapaForm) return;
  if (markerForm) mapaForm.removeLayer(markerForm);
  markerForm = L.marker([lat, lng]).addTo(mapaForm);
  mapaForm.setView([lat, lng], Math.max(mapaForm.getZoom(), 15));
}

// Aplicar coords pegadas manualmente
$('#btn-usar-coords').addEventListener('click', () => {
  const valor = $('#f-coords').value.trim();
  const match = valor.match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/);
  if (!match) {
    toast('Formato inválido. Usá "lat, lng" (ej: -38.902, -70.065)', 'warn');
    return;
  }
  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    toast('Coordenadas fuera de rango.', 'warn');
    return;
  }
  setMarkerForm(lat, lng);
  $('#f-coords').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
});

$('#btn-borrar-coords').addEventListener('click', () => {
  $('#f-coords').value = '';
  if (markerForm && mapaForm) {
    mapaForm.removeLayer(markerForm);
    markerForm = null;
  }
});

// Cerradores del modal
$('#cerrar-form').addEventListener('click', cerrarModalForm);
$('#btn-cancelar').addEventListener('click', cerrarModalForm);
$modalForm.addEventListener('click', (e) => {
  if (e.target === $modalForm) cerrarModalForm();
});

// Botón nuevo
$btnNuevo.addEventListener('click', () => abrirModalForm(null));

// Submit del formulario
$formCliente.addEventListener('submit', async (e) => {
  e.preventDefault();
  $formError.classList.add('oculto');

  // Recoger
  const id = $('#cliente-id').value;
  const datos = {
    nombre:        $('#f-nombre').value.trim(),
    apellido:      $('#f-apellido').value.trim(),
    telefono:      $('#f-telefono').value.trim(),
    zona:          $('#f-zona').value.trim(),
    direccion:     $('#f-direccion').value.trim(),
    observaciones: $('#f-observaciones').value.trim(),
  };

  // Validaciones
  if (!datos.nombre)   return mostrarFormError("El nombre es obligatorio.");
  if (!datos.apellido) return mostrarFormError("El apellido es obligatorio.");
  if (datos.telefono && !esTelefonoArgentino(datos.telefono)) {
    return mostrarFormError("El teléfono no parece válido. Formato esperado: +54 9 299 555 1234 o similar.");
  }

  // Normalizar teléfono si pasó la validación
  if (datos.telefono) {
    datos.telefono = normalizarTelefono(datos.telefono);
  }

  // Ubicación
  const coordsStr = $('#f-coords').value.trim();
  if (coordsStr) {
    const m = coordsStr.match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/);
    if (m) {
      datos.ubicacion = new GeoPoint(parseFloat(m[1]), parseFloat(m[2]));
    }
  } else {
    datos.ubicacion = null;
  }

  $btnGuardar.disabled = true;
  $btnGuardar.innerHTML = '<span class="cargando-spinner"></span> Guardando…';

  try {
    if (id) {
      await actualizarCliente(id, datos);
      toast('Cliente actualizado.', 'ok');
    } else {
      const nuevoId = await crearCliente(datos);
      toast('Cliente creado.', 'ok');
    }
    cerrarModalForm();
    await recargar();
  } catch (err) {
    console.error('[clientes] error al guardar:', err);
    mostrarFormError(err.message || "No se pudo guardar. Revisá los datos.");
  } finally {
    $btnGuardar.disabled = false;
    $btnGuardar.textContent = 'Guardar';
  }
});

function mostrarFormError(msg) {
  $formError.textContent = msg;
  $formError.classList.remove('oculto');
}

// =====================================================================
// MODAL FICHA
// =====================================================================
const $modalFicha = $('#modal-ficha');

async function abrirFicha(clienteId) {
  // Buscar primero en cache local, sino traer fresco
  let cliente = clientesData.find(c => c.id === clienteId);
  if (!cliente) {
    try {
      cliente = await obtenerCliente(clienteId);
    } catch (e) {
      toast('No se pudo cargar el cliente.', 'error');
      return;
    }
  }
  if (!cliente) {
    toast('Cliente no encontrado.', 'warn');
    return;
  }

  const nombre = `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim() || 'Sin nombre';

  $('#ficha-nombre').textContent = nombre;
  $('#ficha-meta').innerHTML = `
    ${cliente.estado === "inactivo" ? '<span class="badge badge-neutral">Inactivo</span>' : '<span class="badge badge-ok">Activo</span>'}
    ${cliente.fechaAlta ? ` · Alta ${escapeHTML(fechaRelativa(cliente.fechaAlta))}` : ''}
  `;

  // KPIs
  const debe = (cliente.saldoPendiente || 0) > 0;
  const totalMoneda = (n) => {
    const { simbolo, valor } = formatoMonedaPartes(n);
    return `<span class="moneda">${simbolo}</span>${valor}`;
  };
  $('#ficha-kpis').innerHTML = `
    <div class="kpi">
      <div class="kpi-etiqueta">Total comprado</div>
      <div class="kpi-valor chico">${totalMoneda(cliente.totalComprado || 0)}</div>
      <div class="kpi-pie">${cliente.cantidadCompras || 0} ${(cliente.cantidadCompras || 0) === 1 ? 'compra' : 'compras'}</div>
    </div>
    <div class="kpi">
      ${debe ? '<div class="kpi-acento ok"></div>' : ''}
      <div class="kpi-etiqueta">Total pagado</div>
      <div class="kpi-valor chico">${totalMoneda(cliente.totalPagado || 0)}</div>
      <div class="kpi-pie">Histórico</div>
    </div>
    <div class="kpi">
      ${debe ? '<div class="kpi-acento error"></div>' : ''}
      <div class="kpi-etiqueta">Saldo</div>
      <div class="kpi-valor chico">${totalMoneda(cliente.saldoPendiente || 0)}</div>
      <div class="kpi-pie">${debe ? 'Pendiente de cobro' : 'Al día'}</div>
    </div>
  `;

  // Datos
  const tieneUbicacion = !!cliente.ubicacion;
  const lat = tieneUbicacion ? (cliente.ubicacion.latitude  ?? cliente.ubicacion._lat) : null;
  const lng = tieneUbicacion ? (cliente.ubicacion.longitude ?? cliente.ubicacion._long) : null;

  $('#ficha-datos').innerHTML = `
    <div>
      <div class="etiqueta">Teléfono</div>
      <div style="font-size: 14px; margin-top: 4px;">${cliente.telefono ? `<a href="tel:${escapeHTML(cliente.telefono)}">${escapeHTML(cliente.telefono)}</a>` : '<span class="color-gris">—</span>'}</div>
    </div>
    <div>
      <div class="etiqueta">Zona</div>
      <div style="font-size: 14px; margin-top: 4px;">${escapeHTML(cliente.zona || '—')}</div>
    </div>
    <div style="grid-column: 1 / -1;">
      <div class="etiqueta">Dirección</div>
      <div style="font-size: 14px; margin-top: 4px;">${escapeHTML(cliente.direccion || '—')}</div>
    </div>
    ${cliente.observaciones ? `
      <div style="grid-column: 1 / -1;">
        <div class="etiqueta">Observaciones</div>
        <div style="font-size: 14px; margin-top: 4px; padding: 8px 12px; background: var(--crema-oscura); border-radius: 8px; line-height: 1.5;">${escapeHTML(cliente.observaciones)}</div>
      </div>
    ` : ''}
  `;

  // Mapa
  const $mapaCard = $('#ficha-mapa-card');
  if (tieneUbicacion) {
    $mapaCard.style.display = 'block';
    $('#ficha-google-maps').href = `https://www.google.com/maps?q=${lat},${lng}`;

    setTimeout(() => {
      const $div = document.getElementById('ficha-mapa');
      if (mapaFicha) {
        mapaFicha.remove();
        mapaFicha = null;
      }
      mapaFicha = L.map($div).setView([lat, lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19
      }).addTo(mapaFicha);
      L.marker([lat, lng]).addTo(mapaFicha);
      setTimeout(() => mapaFicha?.invalidateSize(), 100);
    }, 100);
  } else {
    $mapaCard.style.display = 'none';
  }

  // Botón "Dar de baja" / "Reactivar" según estado
  const $btnBaja = $('#ficha-baja');
  if (cliente.estado === "inactivo") {
    $btnBaja.textContent = "Reactivar";
    $btnBaja.dataset.accion = "reactivar";
  } else {
    $btnBaja.textContent = "Dar de baja";
    $btnBaja.dataset.accion = "baja";
  }
  $btnBaja.dataset.id = cliente.id;

  $('#ficha-editar').dataset.id = cliente.id;
  $modalFicha.classList.add('abierto');
}

function cerrarFicha() {
  $modalFicha.classList.remove('abierto');
  if (mapaFicha) {
    mapaFicha.remove();
    mapaFicha = null;
  }
  // Si entramos vía ?id=, limpiar la URL para evitar reabrirla en F5/refresh
  if (window.location.search) {
    history.replaceState(null, '', window.location.pathname);
  }
}

$('#cerrar-ficha').addEventListener('click', cerrarFicha);
$('#ficha-cerrar-btn').addEventListener('click', cerrarFicha);
$modalFicha.addEventListener('click', (e) => {
  if (e.target === $modalFicha) cerrarFicha();
});

// Editar desde la ficha
$('#ficha-editar').addEventListener('click', async (e) => {
  const id = e.currentTarget.dataset.id;
  const cliente = clientesData.find(c => c.id === id) || await obtenerCliente(id);
  cerrarFicha();
  setTimeout(() => abrirModalForm(cliente), 200);
});

// Dar de baja / Reactivar
$('#ficha-baja').addEventListener('click', async (e) => {
  const id = e.currentTarget.dataset.id;
  const accion = e.currentTarget.dataset.accion;

  if (accion === "baja") {
    if (!confirm("¿Dar de baja a este cliente? Quedará marcado como inactivo pero su historial se conserva.")) return;
    try {
      await darDeBajaCliente(id);
      toast('Cliente dado de baja.', 'ok');
      cerrarFicha();
      await recargar();
    } catch (err) {
      toast('No se pudo dar de baja: ' + err.message, 'error');
    }
  } else if (accion === "reactivar") {
    if (!confirm("¿Reactivar este cliente?")) return;
    try {
      await reactivarCliente(id);
      toast('Cliente reactivado.', 'ok');
      cerrarFicha();
      await recargar();
    } catch (err) {
      toast('No se pudo reactivar: ' + err.message, 'error');
    }
  }
});

// =====================================================================
// Cerrar modales con Escape
// =====================================================================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($modalForm.classList.contains('abierto')) cerrarModalForm();
    else if ($modalFicha.classList.contains('abierto')) cerrarFicha();
  }
});

// =====================================================================
// Soporte para ?id=xxx desde dashboard (abrir ficha directo)
// y ?filtro=deudores (preseleccionar filtro)
// =====================================================================
const params = new URLSearchParams(window.location.search);
const idQS    = params.get('id');
const filtroQS = params.get('filtro');

if (filtroQS) {
  // Setear filtro y reaplicar después de cargar
  $filtroEstado.value = filtroQS;
}

// Carga inicial
await recargar();

// Si vino con ?id=, abrir ficha
if (idQS) {
  setTimeout(() => abrirFicha(idQS), 300);
}
