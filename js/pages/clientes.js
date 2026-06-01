// =====================================================================
// Emanuel Cosméticos · Clientes (js/pages/clientes.js)
// ---------------------------------------------------------------------
// Funcionalidad:
//   - Listado con buscador + filtros (estado, zona)
//   - Selección múltiple (acciones masivas conectan en F8)
//   - Modal de alta/edición con validaciones
//   - Mini-mapa Leaflet con botones de zonas rápidas (Villa Pehuenia,
//     Moquehue, Lonco Luan, Aluminé, Zapala) + Mi ubicación GPS
//   - Ficha individual con KPIs, datos, mapa
//   - ?id=xxx abre ficha directo desde dashboard
// =====================================================================

import { requireAuth } from "../auth.js";
import { renderLayout } from "../layout.js";
import {
  listarClientes, crearCliente, actualizarCliente,
  obtenerCliente, darDeBajaCliente, reactivarCliente,
  listarVentas, GeoPoint
} from "../db.js";
import { ZONAS, CENTRO_DEFAULT } from "../zonas.js";
import {
  $, $$, escapeHTML, toast, debounce, formatoMoneda, formatoMonedaPartes,
  fechaRelativa, formatoFecha, esTelefonoArgentino, normalizarTelefono,
  generarLinkWhatsApp, TEMPLATES_WSP
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
let clientesData      = [];
let clientesFiltrados = [];
let seleccionados     = new Set();
let mapaForm          = null;
let markerForm        = null;
let mapaFicha         = null;
let modoEdicion       = false;

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
const $btnExportarPDF  = $('#btn-exportar-pdf');
const $btnExportarXls  = $('#btn-exportar-excel');
const $btnExportarWsp  = $('#btn-exportar-wsp');

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

    // Combinar zonas guardadas (de los clientes) + zonas predefinidas (zonas.js)
    const zonasClientes = clientesData.map(c => c.zona).filter(Boolean);
    const zonasPredef   = ZONAS.map(z => z.nombre);
    const todasZonas    = [...new Set([...zonasPredef, ...zonasClientes])].sort();

    $filtroZona.innerHTML = '<option value="">Todas las zonas</option>' +
      todasZonas.map(z => `<option value="${escapeHTML(z)}">${escapeHTML(z)}</option>`).join('');

    const $datalist = document.getElementById('zonas-existentes');
    if ($datalist) {
      $datalist.innerHTML = todasZonas.map(z => `<option value="${escapeHTML(z)}">`).join('');
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
    if (filtroEst === "deudores"  && !((c.saldoPendiente || 0) > 0)) return false;
    if (filtroEst === "al-dia"    && ((c.saldoPendiente || 0) > 0 || c.estado === "inactivo")) return false;
    if (filtroEst === "inactivos" && c.estado !== "inactivo") return false;
    if (filtroEst === "todos" && c.estado === "inactivo" && !texto) return false;

    if (filtroZona && c.zona !== filtroZona) return false;

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
  const total = clientesData.filter(c => c.estado !== "inactivo").length;
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

      <div class="checkbox-fila" style="cursor: pointer; padding: 4px;">
        <div style="width: 18px; height: 18px; border-radius: 4px; border: 2px solid ${checked ? 'var(--terracota)' : 'var(--gris-suave)'}; background: ${checked ? 'var(--terracota)' : 'transparent'}; display: flex; align-items: center; justify-content: center; transition: all 0.15s;">
          ${checked ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </div>
      </div>

      <div class="fila-cuerpo" style="flex: 1; display: flex; align-items: center; gap: 14px; cursor: pointer; min-width: 0;">

        <div style="width: 40px; height: 40px; background: var(--rose-claro); color: var(--terracota); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 500; font-size: 14px; flex-shrink: 0;">${escapeHTML(inic)}</div>

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

        <div style="text-align: right; flex-shrink: 0;">
          ${debe ? `
            <div style="font-family: var(--font-serif); font-size: 18px; color: var(--estado-error); white-space: nowrap;">
              ${formatoMoneda(c.saldoPendiente, { compacto: true })}
            </div>
            <div style="font-size: 10px; color: var(--gris-suave); letter-spacing: 0.1em; text-transform: uppercase; margin-top: 2px;">adeudado</div>
          ` : `<span class="badge badge-ok">Al día</span>`}
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
  renderLista();
}

function actualizarBarraSeleccion() {
  const n = seleccionados.size;
  if (n === 0) $barraSeleccion.classList.add('oculto');
  else {
    $barraSeleccion.classList.remove('oculto');
    $contSeleccion.textContent = `${n} ${n === 1 ? 'seleccionado' : 'seleccionados'}`;
  }
}

$btnSelAll.addEventListener('click', () => {
  const idsVisibles = clientesFiltrados.map(c => c.id);
  const todosYa = idsVisibles.every(id => seleccionados.has(id));
  if (todosYa) idsVisibles.forEach(id => seleccionados.delete(id));
  else idsVisibles.forEach(id => seleccionados.add(id));
  actualizarBarraSeleccion();
  renderLista();
});

$btnQuitarSel.addEventListener('click', () => {
  seleccionados.clear();
  actualizarBarraSeleccion();
  renderLista();
});

// =====================================================================
// EXPORTACIÓN DE SELECCIONADOS (PDF / Excel / WhatsApp)
// =====================================================================

// Devuelve los objetos cliente correspondientes a la selección actual
function clientesSeleccionados() {
  return clientesData.filter(c => seleccionados.has(c.id));
}

// ----- Excel (CSV compatible con Excel, sin librerías) -----
$btnExportarXls.addEventListener('click', () => {
  const sel = clientesSeleccionados();
  if (sel.length === 0) {
    toast('Seleccioná al menos un cliente.', 'warn');
    return;
  }

  const cols = ['Nombre', 'Apellido', 'Teléfono', 'Zona', 'Dirección',
                'Estado', 'Saldo pendiente', 'Total comprado', 'Total pagado', 'Observaciones'];

  const escapar = (v) => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const filas = sel.map(c => [
    c.nombre || '',
    c.apellido || '',
    c.telefono || '',
    c.zona || '',
    c.direccion || '',
    c.estado === 'inactivo' ? 'Inactivo' : 'Activo',
    c.saldoPendiente || 0,
    c.totalComprado || 0,
    c.totalPagado || 0,
    c.observaciones || '',
  ].map(escapar).join(';'));

  // BOM para que Excel reconozca UTF-8 (acentos)
  const csv = '\uFEFF' + cols.join(';') + '\n' + filas.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clientes_${fechaArchivo()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Excel generado (${sel.length} ${sel.length === 1 ? 'cliente' : 'clientes'}).`, 'ok');
});

// ----- PDF (jsPDF + autoTable, cargados en el HTML) -----
$btnExportarPDF.addEventListener('click', () => {
  const sel = clientesSeleccionados();
  if (sel.length === 0) {
    toast('Seleccioná al menos un cliente.', 'warn');
    return;
  }
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor) {
    toast('No se pudo cargar el generador de PDF. Revisá tu conexión.', 'error');
    return;
  }

  const doc = new jsPDFCtor({ unit: 'pt', format: 'a4' });

  // Encabezado
  doc.setFontSize(18);
  doc.text('Emanuel Cosméticos — Clientes', 40, 48);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generado: ${new Date().toLocaleString('es-AR')} · ${sel.length} cliente(s)`, 40, 66);
  doc.setTextColor(0);

  const cuerpo = sel.map(c => [
    `${c.nombre || ''} ${c.apellido || ''}`.trim(),
    c.telefono || '—',
    c.zona || '—',
    c.direccion || '—',
    formatoMoneda(c.saldoPendiente || 0),
    c.estado === 'inactivo' ? 'Inactivo' : 'Activo',
  ]);

  doc.autoTable({
    startY: 84,
    head: [['Cliente', 'Teléfono', 'Zona', 'Dirección', 'Saldo', 'Estado']],
    body: cuerpo,
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [60, 42, 35], textColor: [248, 241, 233] },
    alternateRowStyles: { fillColor: [253, 248, 243] },
    margin: { left: 40, right: 40 },
  });

  doc.save(`clientes_${fechaArchivo()}.pdf`);
  toast(`PDF generado (${sel.length} ${sel.length === 1 ? 'cliente' : 'clientes'}).`, 'ok');
});

// ----- WhatsApp -----
// WhatsApp no permite un solo chat hacia múltiples destinatarios.
// Por eso, la acción masiva abre el chat del primer seleccionado con teléfono válido.
$btnExportarWsp.addEventListener('click', () => {
  const sel = clientesSeleccionados();
  if (sel.length === 0) {
    toast('Seleccioná al menos un cliente.', 'warn');
    return;
  }

  const conTel = sel.filter(c => c.telefono && esTelefonoArgentino(c.telefono));
  if (conTel.length === 0) {
    toast('Ninguno de los seleccionados tiene un teléfono válido.', 'warn');
    return;
  }

  if (sel.length > 1) {
    toast('WhatsApp es de a uno: abriendo el chat del primer cliente con teléfono.', 'info');
  }

  const c = conTel[0];
  const debe = (c.saldoPendiente || 0) > 0;
  const nombre = `${c.nombre || ''}`.trim();
  const mensaje = debe
    ? TEMPLATES_WSP.recordatorioCobro({
        nombreCliente: nombre,
        saldoPendiente: c.saldoPendiente,
        miNombre: "Emanuel",
      })
    : TEMPLATES_WSP.saludoLibre({ nombreCliente: nombre, miNombre: "Emanuel" });

  const link = generarLinkWhatsApp(c.telefono, mensaje);
  if (!link) {
    toast('No se pudo generar el link de WhatsApp.', 'error');
    return;
  }
  window.open(link, '_blank', 'noopener');
});

// Nombre de archivo con fecha YYYY-MM-DD
function fechaArchivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// =====================================================================
// MODAL ALTA / EDICIÓN
// =====================================================================
const $modalForm   = $('#modal-form');
const $formCliente = $('#form-cliente');
const $tituloForm  = $('#titulo-form');
const $btnGuardar  = $('#btn-guardar');
const $formError   = $('#form-error');
const $botonesZonas = $('#botones-zonas');

function renderBotonesZonas() {
  // Botones de localidades + botón "Mi ubicación" al final
  const htmlZonas = ZONAS.map(z => `
    <button type="button" class="btn-zona" data-zona-id="${escapeHTML(z.id)}" title="Ir a ${escapeHTML(z.nombre)}">
      📍 ${escapeHTML(z.nombre)}
    </button>
  `).join('');

  const htmlGPS = `
    <button type="button" class="btn-zona btn-zona-gps" id="btn-mi-ubicacion" title="Usar mi ubicación actual (GPS)">
      🎯 Mi ubicación
    </button>
  `;

  $botonesZonas.innerHTML = htmlZonas + htmlGPS;

  // Wire-up
  $botonesZonas.querySelectorAll('.btn-zona[data-zona-id]').forEach($btn => {
    $btn.addEventListener('click', () => {
      const zona = ZONAS.find(z => z.id === $btn.dataset.zonaId);
      if (!zona || !mapaForm) return;
      mapaForm.setView([zona.lat, zona.lng], zona.zoom, { animate: true });
      // Si NO hay zona escrita en el form, sugerir esta
      const $zonaInput = $('#f-zona');
      if (!$zonaInput.value.trim()) {
        $zonaInput.value = zona.nombre;
      }
      // Resaltar visualmente el botón activo
      $botonesZonas.querySelectorAll('.btn-zona').forEach(b => b.classList.remove('activo'));
      $btn.classList.add('activo');
    });
  });

  $('#btn-mi-ubicacion').addEventListener('click', () => {
    if (!navigator.geolocation) {
      toast('Tu navegador no soporta GPS.', 'warn');
      return;
    }
    toast('Buscando tu ubicación…', 'info');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        if (mapaForm) {
          mapaForm.setView([latitude, longitude], 17, { animate: true });
        }
        setMarkerForm(latitude, longitude);
        $('#f-coords').value = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        toast('Ubicación encontrada.', 'ok');
      },
      (err) => {
        const msgs = {
          1: 'Permiso de ubicación denegado. Permitilo en el navegador y volvé a intentar.',
          2: 'No se pudo obtener tu ubicación.',
          3: 'Tardó demasiado. Probá de nuevo o usá un botón de zona.'
        };
        toast(msgs[err.code] || 'Error al obtener ubicación.', 'error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

function abrirModalForm(cliente = null) {
  modoEdicion = !!cliente;
  $tituloForm.textContent = modoEdicion ? "Editar cliente" : "Nuevo cliente";
  $formError.classList.add('oculto');

  $formCliente.reset();
  $('#cliente-id').value = '';
  $('#f-coords').value   = '';

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
  setTimeout(() => {
    inicializarMapaForm(cliente);
    renderBotonesZonas();
  }, 100);
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

  let centroLat = CENTRO_DEFAULT.lat;
  let centroLng = CENTRO_DEFAULT.lng;
  let zoom      = CENTRO_DEFAULT.zoom;

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

  setTimeout(() => mapaForm?.invalidateSize(), 100);
}

function setMarkerForm(lat, lng) {
  if (!mapaForm) return;
  if (markerForm) mapaForm.removeLayer(markerForm);
  markerForm = L.marker([lat, lng]).addTo(mapaForm);
}

$('#btn-usar-coords').addEventListener('click', () => {
  const valor = $('#f-coords').value.trim();
  const match = valor.match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/);
  if (!match) {
    toast('Formato inválido. Usá "lat, lng" (ej: -38.879801, -71.185758)', 'warn');
    return;
  }
  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    toast('Coordenadas fuera de rango.', 'warn');
    return;
  }
  setMarkerForm(lat, lng);
  mapaForm?.setView([lat, lng], 16, { animate: true });
  $('#f-coords').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
});

$('#btn-borrar-coords').addEventListener('click', () => {
  $('#f-coords').value = '';
  if (markerForm && mapaForm) {
    mapaForm.removeLayer(markerForm);
    markerForm = null;
  }
});

$('#cerrar-form').addEventListener('click', cerrarModalForm);
$('#btn-cancelar').addEventListener('click', cerrarModalForm);
$modalForm.addEventListener('click', (e) => {
  if (e.target === $modalForm) cerrarModalForm();
});

$btnNuevo.addEventListener('click', () => abrirModalForm(null));

$formCliente.addEventListener('submit', async (e) => {
  e.preventDefault();
  $formError.classList.add('oculto');

  const id = $('#cliente-id').value;
  const datos = {
    nombre:        $('#f-nombre').value.trim(),
    apellido:      $('#f-apellido').value.trim(),
    telefono:      $('#f-telefono').value.trim(),
    zona:          $('#f-zona').value.trim(),
    direccion:     $('#f-direccion').value.trim(),
    observaciones: $('#f-observaciones').value.trim(),
  };

  if (!datos.nombre)   return mostrarFormError("El nombre es obligatorio.");
  if (!datos.apellido) return mostrarFormError("El apellido es obligatorio.");
  if (datos.telefono && !esTelefonoArgentino(datos.telefono)) {
    return mostrarFormError("El teléfono no parece válido. Formato esperado: +54 9 299 555 1234 o similar.");
  }

  if (datos.telefono) datos.telefono = normalizarTelefono(datos.telefono);

  const coordsStr = $('#f-coords').value.trim();
  if (coordsStr) {
    const m = coordsStr.match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/);
    if (m) datos.ubicacion = new GeoPoint(parseFloat(m[1]), parseFloat(m[2]));
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
      await crearCliente(datos);
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
  let cliente = clientesData.find(c => c.id === clienteId);
  if (!cliente) {
    try { cliente = await obtenerCliente(clienteId); }
    catch (e) { toast('No se pudo cargar el cliente.', 'error'); return; }
  }
  if (!cliente) { toast('Cliente no encontrado.', 'warn'); return; }

  const nombre = `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim() || 'Sin nombre';

  $('#ficha-nombre').textContent = nombre;
  $('#ficha-meta').innerHTML = `
    ${cliente.estado === "inactivo" ? '<span class="badge badge-neutral">Inactivo</span>' : '<span class="badge badge-ok">Activo</span>'}
    ${cliente.fechaAlta ? ` · Alta ${escapeHTML(fechaRelativa(cliente.fechaAlta))}` : ''}
  `;

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

  const tieneUbicacion = !!cliente.ubicacion;
  const lat = tieneUbicacion ? (cliente.ubicacion.latitude  ?? cliente.ubicacion._lat) : null;
  const lng = tieneUbicacion ? (cliente.ubicacion.longitude ?? cliente.ubicacion._long) : null;

  // Generamos el link de WhatsApp si tiene teléfono
  let wspBlockHTML = '';
  if (cliente.telefono) {
    const mensajeWsp = debe
      ? TEMPLATES_WSP.recordatorioCobro({
          nombreCliente: nombre,
          saldoPendiente: cliente.saldoPendiente,
          miNombre: "Emanuel",
        })
      : TEMPLATES_WSP.saludoLibre({ nombreCliente: nombre, miNombre: "Emanuel" });
    const linkWsp = generarLinkWhatsApp(cliente.telefono, mensajeWsp);
    if (linkWsp) {
      wspBlockHTML = `
        <a href="${linkWsp}" target="_blank" rel="noopener" class="btn-wsp btn-wsp-mini" title="${debe ? 'Recordatorio de cobro por WhatsApp' : 'Abrir WhatsApp'}" style="margin-left: 8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        </a>`;
    }
  }

  $('#ficha-datos').innerHTML = `
    <div>
      <div class="etiqueta">Teléfono</div>
      <div style="font-size: 14px; margin-top: 4px; display: flex; align-items: center;">
        ${cliente.telefono ? `<a href="tel:${escapeHTML(cliente.telefono)}">${escapeHTML(cliente.telefono)}</a>` : '<span class="color-gris">—</span>'}
        ${wspBlockHTML}
      </div>
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

  const $mapaCard = $('#ficha-mapa-card');
  if (tieneUbicacion) {
    $mapaCard.style.display = 'block';
    $('#ficha-google-maps').href = `https://www.google.com/maps?q=${lat},${lng}`;

    setTimeout(() => {
      const $div = document.getElementById('ficha-mapa');
      if (mapaFicha) { mapaFicha.remove(); mapaFicha = null; }
      mapaFicha = L.map($div).setView([lat, lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19
      }).addTo(mapaFicha);
      L.marker([lat, lng]).addTo(mapaFicha);
      setTimeout(() => mapaFicha?.invalidateSize(), 100);
    }, 100);
  } else {
    $mapaCard.style.display = 'none';
  }

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

  // Cargar el historial de ventas del cliente (async, no bloquea el modal)
  cargarHistorialCliente(cliente.id);
}

// =====================================================================
// HISTORIAL DE VENTAS EN LA FICHA
// =====================================================================
async function cargarHistorialCliente(clienteId) {
  const $cont = $('#ficha-historial');
  if (!$cont) return;

  $cont.innerHTML = `<div class="vacio" style="padding: 24px;"><p>Cargando historial…</p></div>`;

  let ventas;
  try {
    ventas = await listarVentas({ clienteId });
  } catch (err) {
    console.error('[clientes] error cargando historial:', err);
    $cont.innerHTML = `<div class="vacio" style="padding: 24px;"><p>No se pudo cargar el historial.</p></div>`;
    return;
  }

  if (!ventas || ventas.length === 0) {
    $cont.innerHTML = `<div class="vacio" style="padding: 24px;"><p>Este cliente todavía no tiene compras registradas.</p></div>`;
    return;
  }

  const etiquetaEstado = (v) => {
    if (v.estadoPedido === "cancelado") return '<span class="badge badge-neutral">Cancelado</span>';
    if ((v.saldo || 0) > 0) return `<span class="badge" style="background: var(--rose-claro); color: var(--estado-error);">Debe ${formatoMoneda(v.saldo)}</span>`;
    return '<span class="badge badge-ok">Pagado</span>';
  };

  const filas = ventas.map(v => {
    const cancelado = v.estadoPedido === "cancelado";
    const nItems = (v.items || []).length;
    const detItems = nItems === 1
      ? escapeHTML((v.items[0]?.nombre) || '1 producto')
      : `${nItems} productos`;
    return `
      <div style="display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-bottom: 1px solid var(--linea); ${cancelado ? 'opacity: 0.55;' : ''}">
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 14px; font-weight: 500; ${cancelado ? 'text-decoration: line-through;' : ''}">${formatoMoneda(v.total)}</div>
          <div style="font-size: 12px; color: var(--gris-suave); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(detItems)} · ${formatoFecha(v.fechaVenta, { corta: true })}</div>
        </div>
        <div>${etiquetaEstado(v)}</div>
      </div>`;
  }).join('');

  // Totales (excluyendo cancelados, igual que en Pedidos)
  const computables = ventas.filter(v => v.estadoPedido !== "cancelado");
  const totComprado = computables.reduce((s, v) => s + (v.total || 0), 0);
  const totAdeudado = computables.reduce((s, v) => s + (v.saldo || 0), 0);
  const nCancelados = ventas.length - computables.length;

  $cont.innerHTML = `
    <div style="font-size: 12px; color: var(--gris-suave); margin-bottom: 4px;">
      ${computables.length} ${computables.length === 1 ? 'compra' : 'compras'} · Total ${formatoMoneda(totComprado)} · Adeuda ${formatoMoneda(totAdeudado)}${nCancelados > 0 ? ` · ${nCancelados} cancelada${nCancelados === 1 ? '' : 's'}` : ''}
    </div>
    ${filas}`;
}

function cerrarFicha() {
  $modalFicha.classList.remove('abierto');
  if (mapaFicha) { mapaFicha.remove(); mapaFicha = null; }
  if (window.location.search) {
    history.replaceState(null, '', window.location.pathname);
  }
}

$('#cerrar-ficha').addEventListener('click', cerrarFicha);
$('#ficha-cerrar-btn').addEventListener('click', cerrarFicha);
$modalFicha.addEventListener('click', (e) => {
  if (e.target === $modalFicha) cerrarFicha();
});

$('#ficha-editar').addEventListener('click', async (e) => {
  const id = e.currentTarget.dataset.id;
  const cliente = clientesData.find(c => c.id === id) || await obtenerCliente(id);
  cerrarFicha();
  setTimeout(() => abrirModalForm(cliente), 200);
});

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
    } catch (err) { toast('No se pudo dar de baja: ' + err.message, 'error'); }
  } else {
    if (!confirm("¿Reactivar este cliente?")) return;
    try {
      await reactivarCliente(id);
      toast('Cliente reactivado.', 'ok');
      cerrarFicha();
      await recargar();
    } catch (err) { toast('No se pudo reactivar: ' + err.message, 'error'); }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($modalForm.classList.contains('abierto')) cerrarModalForm();
    else if ($modalFicha.classList.contains('abierto')) cerrarFicha();
  }
});

// Soporte para ?id= y ?filtro=
const params = new URLSearchParams(window.location.search);
const idQS    = params.get('id');
const filtroQS = params.get('filtro');
if (filtroQS) $filtroEstado.value = filtroQS;

await recargar();
if (idQS) setTimeout(() => abrirFicha(idQS), 300);
