// =====================================================================
// Emanuel Cosméticos · Mapa general (js/pages/mapa.js)
// =====================================================================

import { requireAuth } from "../auth.js";
import { renderLayout } from "../layout.js";
import { listarClientes, listarVentas } from "../db.js";
import { ZONAS, CENTRO_DEFAULT } from "../zonas.js";
import { $, $$, escapeHTML, toast, debounce, formatoMoneda } from "../utils.js";

// =====================================================================
// Carga garantizada de Leaflet (+ markercluster)
// ---------------------------------------------------------------------
// Como mapa.js es un módulo, no podemos depender de que los <script>
// clásicos del HTML ya hayan terminado de ejecutarse. Esta función
// espera a que window.L exista; si en pocos segundos no apareció,
// inyecta el script ella misma. Así el mapa funciona aunque cambie el
// orden de carga.
// =====================================================================
function cargarScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

async function asegurarLeaflet() {
  // Esperar hasta ~3s a que el <script> del HTML defina L
  for (let i = 0; i < 30 && typeof window.L === 'undefined'; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  // Si todavía no está, lo cargamos nosotros
  if (typeof window.L === 'undefined') {
    await cargarScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
  }
  // markercluster es opcional: si falta, el mapa igual funciona
  if (typeof window.L !== 'undefined' && typeof window.L.markerClusterGroup !== 'function') {
    try {
      await cargarScript('https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js');
    } catch (e) {
      console.warn('[mapa] markercluster no disponible:', e.message);
    }
  }
}

// =====================================================================
// Captura de errores
// =====================================================================
window.addEventListener('error', (e) => {
  console.error('[mapa] error:', e.error || e.message);
  toast('Error: ' + (e.error?.message || e.message), 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[mapa] unhandled:', e.reason);
  toast('Error: ' + (e.reason?.message || String(e.reason)), 'error');
});

// =====================================================================
// Auth
// =====================================================================
const usuario = await requireAuth();
document.getElementById('pantalla-carga').style.display = 'none';
// El CSS de mapa.html ya define .app como pantalla completa (height:100vh).
// Usamos 'block' (no 'grid') para no romper ese layout: el mapa va a
// pantalla completa con su panel lateral propio, sin el sidebar global.
document.getElementById('app').style.display = 'block';

// Renderizar el layout (sidebar + topbar mobile con el menú hamburguesa),
// igual que el resto de las páginas. En mobile esto da el botón de menú
// "≡" y el título "Mapa" arriba para poder navegar a las otras secciones.
renderLayout({ usuario, paginaActiva: "mapa" });

// =====================================================================
// Estado
// =====================================================================
let clientesData = [];           // todos los clientes con ubicación
let clientesPendientes = new Set(); // IDs de clientes con pedidos pendientes
let mapa = null;
let cluster = null;              // capa de cluster de markers
let zonaActiva = null;           // id de la zona resaltada

// Refs
const $buscador     = $('#buscador');
const $filtroEstado = $('#filtro-estado');
const $filtroZona   = $('#filtro-zona');
const $checkPendientes = $('#check-pendientes');
const $btnLimpiar   = $('#btn-limpiar');
const $resumen      = $('#resumen-mapa');
const $statVisibles = $('#stat-visibles');
const $statAdeudado = $('#stat-adeudado');
const $botonesZonas = $('#botones-zonas-mapa');

// =====================================================================
// INIT MAPA LEAFLET (espera a que el contenedor tenga tamaño real)
// =====================================================================
function esperarContenedorConTamano() {
  return new Promise(resolve => {
    const el = document.getElementById('mapa-container');
    if (!el) { resolve(null); return; }

    // Si ya tiene tamaño, listo
    if (el.offsetWidth > 0 && el.offsetHeight > 0) {
      resolve(el);
      return;
    }

    // Sino, observamos hasta que tenga
    const obs = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        obs.disconnect();
        resolve(el);
      }
    });
    obs.observe(el);

    // Timeout de seguridad: si en 3 segundos no tiene tamaño, intentamos igual
    setTimeout(() => {
      obs.disconnect();
      resolve(el);
    }, 3000);
  });
}

function inicializarMapa() {
  // Verificar que Leaflet esté cargado
  if (typeof L === 'undefined') {
    document.getElementById('mapa-container').innerHTML = `
      <div style="padding: 40px; text-align: center; color: var(--estado-error);">
        <p><strong>No se pudo cargar la librería del mapa.</strong></p>
        <p style="font-size: 13px; margin-top: 10px;">Revisá tu conexión y recargá la página (Ctrl+Shift+R).</p>
      </div>
    `;
    throw new Error('Leaflet no está disponible');
  }

  const el = document.getElementById('mapa-container');
  console.log('[mapa] Creando con tamaño:', el.offsetWidth, 'x', el.offsetHeight);

  mapa = L.map('mapa-container', {
    // Opciones críticas para evitar el bug del scale 8x
    zoomControl: true,
    zoomSnap: 1,
    zoomDelta: 1,
    fadeAnimation: false,
    zoomAnimation: false,    // CRÍTICO: desactivar animación de zoom evita el bug del scale
    markerZoomAnimation: false,
  }).setView(
    [CENTRO_DEFAULT.lat, CENTRO_DEFAULT.lng],
    CENTRO_DEFAULT.zoom
  );

  // Capa de tiles
  const proveedores = [
    {
      nombre: 'CartoDB Voyager',
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      opts: {
        attribution: '© OpenStreetMap, © CartoDB',
        subdomains: 'abcd',
        maxZoom: 19,
      }
    }
  ];

  const proveedor = proveedores[0];
  console.log('[mapa] Usando proveedor de tiles:', proveedor.nombre);
  const tileLayer = L.tileLayer(proveedor.url, proveedor.opts);

  let tilesOK = 0;
  let tilesERR = 0;
  tileLayer.on('tileload', () => { tilesOK++; });
  tileLayer.on('tileerror', () => { tilesERR++; });

  setTimeout(() => {
    if (tilesOK === 0 && tilesERR > 0) {
      console.error('[mapa] Ningún tile cargó. Total errores:', tilesERR);
      toast(`No se pudieron cargar las imágenes del mapa.`, 'error');
    } else {
      console.log('[mapa] Tiles cargados:', tilesOK, '| Errores:', tilesERR);
    }
  }, 5000);

  tileLayer.addTo(mapa);

  // Cluster (opcional)
  if (typeof L.markerClusterGroup === 'function') {
    cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      animate: false,    // Sin animación = sin bug de scale
      animateAddingMarkers: false,
    });
  } else {
    console.warn('[mapa] markercluster no disponible, usando FeatureGroup simple');
    cluster = L.featureGroup();
  }
  mapa.addLayer(cluster);

  // FIX CRÍTICO: forzar invalidate y reseteo de vista después de un frame
  // Esto elimina el bug del scale 8x que aparece cuando el mapa se crea
  // con dimensiones que cambian después.
  requestAnimationFrame(() => {
    mapa.invalidateSize(true);
    // Re-aplicar la vista para resetear cualquier estado raro de zoom
    mapa.setView([CENTRO_DEFAULT.lat, CENTRO_DEFAULT.lng], CENTRO_DEFAULT.zoom, {
      animate: false,
      reset: true,
    });
  });
}

// =====================================================================
// BOTONES DE ZONAS RÁPIDAS
// =====================================================================
function renderBotonesZonas() {
  const html = ZONAS.map(z => `
    <button class="btn-zona-mapa" data-zona-id="${escapeHTML(z.id)}">${escapeHTML(z.nombre)}</button>
  `).join('') + `
    <button class="btn-zona-mapa todas activo" data-zona-id="">📍 Ver todo</button>
  `;
  $botonesZonas.innerHTML = html;

  $$('.btn-zona-mapa').forEach($btn => {
    $btn.addEventListener('click', () => {
      const zonaId = $btn.dataset.zonaId;
      $$('.btn-zona-mapa').forEach(b => b.classList.remove('activo'));
      $btn.classList.add('activo');

      if (!zonaId) {
        // Ver todo: ajustar al bounding box de todos los clientes filtrados
        zonaActiva = null;
        ajustarVistaATodo();
      } else {
        const z = ZONAS.find(x => x.id === zonaId);
        if (z) {
          zonaActiva = z;
          mapa.setView([z.lat, z.lng], z.zoom, { animate: true });
        }
      }
    });
  });
}

function ajustarVistaATodo() {
  const clientesVisibles = aplicarFiltrosATodos();
  if (clientesVisibles.length === 0) {
    mapa.setView([CENTRO_DEFAULT.lat, CENTRO_DEFAULT.lng], CENTRO_DEFAULT.zoom, { animate: true });
    return;
  }
  if (clientesVisibles.length === 1) {
    const c = clientesVisibles[0];
    const lat = c.ubicacion.latitude ?? c.ubicacion._lat;
    const lng = c.ubicacion.longitude ?? c.ubicacion._long;
    mapa.setView([lat, lng], 15, { animate: true });
    return;
  }
  const bounds = L.latLngBounds(clientesVisibles.map(c => [
    c.ubicacion.latitude ?? c.ubicacion._lat,
    c.ubicacion.longitude ?? c.ubicacion._long,
  ]));
  mapa.fitBounds(bounds, { padding: [40, 40], maxZoom: 14, animate: true });
}

// =====================================================================
// CARGA DE DATOS
// =====================================================================
async function cargarDatos() {
  try {
    // En paralelo: clientes + ventas pendientes (para saber quién tiene pedidos pendientes)
    const [clientes, ventas] = await Promise.all([
      listarClientes({ soloActivos: false }),
      listarVentas({ estadoPedido: "pendiente", maxResultados: 500 }),
    ]);

    // Solo clientes con ubicación
    clientesData = clientes.filter(c => c.ubicacion);

    // Set de IDs de clientes con pedidos pendientes
    clientesPendientes = new Set(ventas.map(v => v.clienteId).filter(Boolean));

    // Llenar dropdown de zonas con las que tienen los clientes + las predefinidas
    const zonasClientes = clientesData.map(c => c.zona).filter(Boolean);
    const zonasPredef = ZONAS.map(z => z.nombre);
    const todasZonas = [...new Set([...zonasPredef, ...zonasClientes])].sort();
    $filtroZona.innerHTML = '<option value="">Todas las zonas</option>' +
      todasZonas.map(z => `<option value="${escapeHTML(z)}">${escapeHTML(z)}</option>`).join('');

    actualizarMarcadores();
    ajustarVistaATodo();
  } catch (e) {
    console.error(e);
    toast('Error cargando datos: ' + e.message, 'error');
  }
}

// =====================================================================
// FILTROS
// =====================================================================
function aplicarFiltrosATodos() {
  const texto = ($buscador.value || '').toLowerCase().trim();
  const estado = $filtroEstado.value;
  const zona = $filtroZona.value;
  const soloPendientes = $checkPendientes.checked;

  return clientesData.filter(c => {
    // Estado
    if (estado === "deudores"  && !((c.saldoPendiente || 0) > 0)) return false;
    if (estado === "al-dia"    && ((c.saldoPendiente || 0) > 0 || c.estado === "inactivo")) return false;
    if (estado === "inactivos" && c.estado !== "inactivo") return false;
    if (!estado && c.estado === "inactivo") return false; // por default no muestra inactivos
    if (estado === "todos") {/* incluye todos */}

    // Zona
    if (zona && c.zona !== zona) return false;

    // Pedidos pendientes
    if (soloPendientes && !clientesPendientes.has(c.id)) return false;

    // Texto
    if (texto) {
      const blob = [c.nombre, c.apellido, c.telefono, c.direccion, c.zona]
        .filter(Boolean).join(' ').toLowerCase();
      if (!blob.includes(texto)) return false;
    }

    return true;
  });
}

function actualizarMarcadores() {
  if (!cluster) return;
  cluster.clearLayers();

  const filtrados = aplicarFiltrosATodos();
  const adeudado = filtrados.reduce((s, c) => s + (c.saldoPendiente || 0), 0);

  $statVisibles.textContent = filtrados.length;
  $statAdeudado.textContent = formatoMoneda(adeudado, { compacto: true });
  $resumen.textContent = `${clientesData.length} con ubicación · mostrando ${filtrados.length}`;

  for (const c of filtrados) {
    const lat = c.ubicacion.latitude ?? c.ubicacion._lat;
    const lng = c.ubicacion.longitude ?? c.ubicacion._long;
    if (!lat || !lng) continue;

    const tienePedido = clientesPendientes.has(c.id);
    const marker = crearMarker(c, lat, lng, tienePedido);
    cluster.addLayer(marker);
  }
}

function crearMarker(cliente, lat, lng, tienePedido) {
  const debe = (cliente.saldoPendiente || 0) > 0;
  const inactivo = cliente.estado === "inactivo";

  // Determinar clase del marker
  let claseMarker;
  let icono = '';
  if (inactivo)      { claseMarker = 'inactivo'; icono = '○'; }
  else if (debe)     { claseMarker = 'debe';     icono = '$'; }
  else               { claseMarker = 'aldia';    icono = '✓'; }
  if (tienePedido)   { icono = '!'; }

  const iconHTML = `
    <div class="marker-custom ${claseMarker}">
      <span>${icono}</span>
    </div>
  `;
  const customIcon = L.divIcon({
    html: iconHTML,
    className: 'marker-wrapper',
    iconSize: [26, 26],
    iconAnchor: [13, 26],
    popupAnchor: [0, -26],
  });

  const marker = L.marker([lat, lng], { icon: customIcon });
  marker.bindPopup(generarPopup(cliente, tienePedido), {
    maxWidth: 280,
  });

  return marker;
}

function generarPopup(cliente, tienePedido) {
  const nombre = `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim() || 'Sin nombre';
  const debe = (cliente.saldoPendiente || 0) > 0;
  const inactivo = cliente.estado === "inactivo";

  const lat = cliente.ubicacion.latitude ?? cliente.ubicacion._lat;
  const lng = cliente.ubicacion.longitude ?? cliente.ubicacion._long;

  let badges = '';
  if (inactivo)    badges += '<span class="badge badge-neutral" style="font-size: 10px;">Inactivo</span> ';
  if (tienePedido) badges += '<span class="badge badge-warn" style="font-size: 10px;">Pedido pendiente</span> ';
  if (debe)        badges += '<span class="badge badge-error" style="font-size: 10px;">Deuda</span> ';
  if (!debe && !inactivo) badges += '<span class="badge badge-ok" style="font-size: 10px;">Al día</span> ';

  return `
    <div>
      <div class="popup-nombre">${escapeHTML(nombre)}</div>
      <div style="margin-bottom: 8px;">${badges}</div>
      <div class="popup-meta">
        ${cliente.telefono ? `📱 ${escapeHTML(cliente.telefono)}<br>` : ''}
        ${cliente.zona ? `📍 ${escapeHTML(cliente.zona)}<br>` : ''}
        ${cliente.direccion ? `${escapeHTML(cliente.direccion)}` : ''}
      </div>
      <div class="popup-saldo ${debe ? 'debe' : ''}">
        <span>${debe ? 'Adeuda' : 'Total comprado'}</span>
        <strong>${formatoMoneda(debe ? cliente.saldoPendiente : (cliente.totalComprado || 0))}</strong>
      </div>
      <div class="popup-acciones">
        <a class="popup-btn" href="clientes.html?id=${encodeURIComponent(cliente.id)}">Ver ficha</a>
        <a class="popup-btn primary" href="ventas.html?cliente=${encodeURIComponent(cliente.id)}">+ Venta</a>
      </div>
      <div class="popup-acciones" style="margin-top: 6px;">
        <a class="popup-btn" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" style="font-size: 10px;">🗺️ Cómo llegar</a>
      </div>
    </div>
  `;
}

// =====================================================================
// LISTENERS
// =====================================================================
$buscador.addEventListener('input', debounce(actualizarMarcadores, 200));
$filtroEstado.addEventListener('change', actualizarMarcadores);
$filtroZona.addEventListener('change', actualizarMarcadores);
$checkPendientes.addEventListener('change', actualizarMarcadores);

$btnLimpiar.addEventListener('click', () => {
  $buscador.value = '';
  $filtroEstado.value = '';
  $filtroZona.value = '';
  $checkPendientes.checked = false;
  actualizarMarcadores();
  ajustarVistaATodo();
});

// =====================================================================
// INIT
// =====================================================================

// CLAVE: esperar a que Leaflet esté disponible y a que el contenedor
// tenga tamaño real antes de crear el mapa
await asegurarLeaflet();
await esperarContenedorConTamano();

inicializarMapa();
renderBotonesZonas();

// Soporte: ?filtro=deudores desde el dashboard
const params = new URLSearchParams(location.search);
const filtroQS = params.get('filtro');
if (filtroQS) $filtroEstado.value = filtroQS;
const zonaQS = params.get('zona');
if (zonaQS) $filtroZona.value = zonaQS;

await cargarDatos();

// Forzar refresh final después de cargar los marcadores
requestAnimationFrame(() => mapa?.invalidateSize(true));

// Refrescos extra: el layout de escritorio (sidebar + main) a veces termina
// de acomodarse unos ms después. Reaplicamos el tamaño para que el mapa
// pinte los tiles en toda el área disponible.
setTimeout(() => mapa?.invalidateSize(true), 250);
setTimeout(() => mapa?.invalidateSize(true), 600);
window.addEventListener('load', () => mapa?.invalidateSize(true));

// También al cambiar el tamaño de ventana
window.addEventListener('resize', () => {
  mapa?.invalidateSize();
});
