// =====================================================================
// Emanuel Cosméticos · Dashboard
// Soporta: hoy, ayer, esta semana, este mes, mes anterior, últimos 7/30
// días, este año, y RANGO PERSONALIZADO con dos selectores de fecha.
// =====================================================================

import { requireAuth } from "../auth.js";
import { renderLayout } from "../layout.js";
import {
  obtenerKPIsDashboard,
  rankingProductos,
  rankingDeudores,
  evolucionVentasUltimosDias,
  distribucionPorCategoria,
  contarProductos
} from "../db.js";
import {
  formatoMoneda, formatoMonedaPartes, formatoFecha,
  RANGOS, escapeHTML, toast, $, $$
} from "../utils.js";

// =====================================================================
// Captura global de errores
// =====================================================================
window.addEventListener('error', (e) => {
  console.error('[dashboard] global error:', e.error || e.message);
  mostrarErrorPantalla(e.error?.message || e.message || 'Error desconocido', e.error?.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[dashboard] unhandled rejection:', e.reason);
  mostrarErrorPantalla(
    e.reason?.message || String(e.reason) || 'Promesa rechazada',
    e.reason?.stack
  );
});

function mostrarErrorPantalla(mensaje, stack) {
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
    <div class="alerta alerta-error" style="margin-bottom: 20px;">
      <strong>Error al cargar el dashboard</strong><br>
      ${escapeHTML(mensaje)}
      ${stack ? `<details style="margin-top:10px;"><summary style="cursor:pointer; font-size:12px;">Detalles técnicos</summary><pre style="font-size:11px; margin-top:8px; background:#fdf8f3; padding:10px; border-radius:6px; overflow:auto; max-height:200px;">${escapeHTML(stack)}</pre></details>` : ''}
    </div>`;
}

// =====================================================================
// Inicialización
// =====================================================================
let usuario;
try {
  usuario = await requireAuth();
} catch (e) {
  mostrarErrorPantalla('No se pudo verificar la sesión: ' + (e.message || e));
  throw e;
}

document.getElementById('pantalla-carga').style.display = 'none';
document.getElementById('app').style.display = 'grid';

try {
  renderLayout({ usuario, paginaActiva: "dashboard" });
} catch (e) {
  console.error('[dashboard] error en layout:', e);
  mostrarErrorPantalla('Error al armar el sidebar: ' + e.message, e.stack);
}

document.getElementById('saludo-usuario').textContent =
  `Hola ${usuario.nombre || usuario.email.split('@')[0]}. Acá está el resumen del negocio.`;

// =====================================================================
// Estado de período (persistido en localStorage)
// =====================================================================
const STORAGE_KEY = 'emanuel.dashboard.periodo';
let rangoActual = "esteMes";
let rangoPersonalizado = null; // { desde: Date, hasta: Date }

function cargarPeriodoGuardado() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.tipo === "personalizado" && data.desde && data.hasta) {
      rangoActual = "personalizado";
      rangoPersonalizado = { desde: new Date(data.desde), hasta: new Date(data.hasta) };
    } else if (data.tipo && RANGOS[data.tipo]) {
      rangoActual = data.tipo;
    }
  } catch (e) { /* ignorar */ }
}

function guardarPeriodo() {
  const data = rangoActual === "personalizado"
    ? { tipo: "personalizado", desde: rangoPersonalizado.desde.toISOString(), hasta: rangoPersonalizado.hasta.toISOString() }
    : { tipo: rangoActual };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

cargarPeriodoGuardado();

// Aplicar valores guardados al UI
const $selector = document.getElementById('selector-periodo');
const $rangoPersonal = document.getElementById('rango-personalizado');
const $fechaDesde = document.getElementById('fecha-desde');
const $fechaHasta = document.getElementById('fecha-hasta');

$selector.value = rangoActual;
if (rangoActual === "personalizado" && rangoPersonalizado) {
  $rangoPersonal.classList.add('visible');
  $fechaDesde.value = rangoPersonalizado.desde.toISOString().substring(0, 10);
  $fechaHasta.value = rangoPersonalizado.hasta.toISOString().substring(0, 10);
} else {
  // Defaults útiles: últimos 7 días en los inputs
  const hoy = new Date();
  const haceSemana = new Date(); haceSemana.setDate(haceSemana.getDate() - 6);
  $fechaDesde.value = haceSemana.toISOString().substring(0, 10);
  $fechaHasta.value = hoy.toISOString().substring(0, 10);
}

let chartEvolucion = null;
let chartCategorias = null;
const PALETA = ['#a8786b', '#c89c8e', '#8a5448', '#e8c6b3', '#5e7c5b', '#b88a3a', '#4a6c7a', '#b8413a'];

// =====================================================================
// Helper: manejo de errores por operación
// =====================================================================
let erroresAcumulados = [];

async function intentar(nombreOperacion, promesa, fallback) {
  try {
    return await promesa;
  } catch (e) {
    console.error(`[dashboard] ${nombreOperacion} falló:`, e);
    erroresAcumulados.push({ operacion: nombreOperacion, error: e });
    return fallback;
  }
}

function mostrarErroresAcumulados() {
  if (erroresAcumulados.length === 0) {
    document.getElementById('aviso-inicial').innerHTML = '';
    return;
  }
  const necesitaIndice = erroresAcumulados.find(e =>
    /index/i.test(e.error?.message || '') || /requires an index/i.test(e.error?.message || '')
  );
  const sinPermisos = erroresAcumulados.find(e =>
    /permission/i.test(e.error?.message || '') || /insufficient/i.test(e.error?.message || '')
  );

  let html = '';
  if (necesitaIndice) {
    const linkMatch = (necesitaIndice.error.message || '').match(/https:\/\/console\.firebase\.google\.com[^\s)"']+/);
    html += `
      <div class="alerta alerta-warn mb-md">
        <strong>Faltan índices de Firestore.</strong><br>
        Es normal la primera vez. Hacé click en el botón para crearlo automáticamente.
        ${linkMatch ? `<br><br><a href="${linkMatch[0]}" target="_blank" class="btn btn-secundario btn-sm" style="margin-top:8px;">Crear índice automáticamente →</a>` : ''}
      </div>`;
  } else if (sinPermisos) {
    html += `
      <div class="alerta alerta-error mb-md">
        <strong>Sin permisos para leer datos.</strong><br>
        Verificá: (1) las reglas de Firestore están publicadas, (2) tu usuario tiene <code>rol: "admin"</code> en <code>/usuarios/{uid}</code>.
      </div>`;
  } else {
    html += `
      <div class="alerta alerta-warn mb-md">
        <strong>Algunas consultas fallaron.</strong>
        ${erroresAcumulados.map(e => `<div style="margin-top:6px;">• <strong>${escapeHTML(e.operacion)}:</strong> ${escapeHTML(e.error.message || String(e.error))}</div>`).join('')}
      </div>`;
  }
  document.getElementById('aviso-inicial').innerHTML = html;
}

// =====================================================================
// Resolver el rango actual (RANGO objeto con desde/hasta/etiqueta)
// =====================================================================
function rangoSeleccionado() {
  if (rangoActual === "personalizado" && rangoPersonalizado) {
    return RANGOS.personalizado(rangoPersonalizado.desde, rangoPersonalizado.hasta);
  }
  return RANGOS[rangoActual]();
}

function actualizarSubtitulos() {
  const rango = rangoSeleccionado();
  document.getElementById('subtit-evolucion').textContent =
    `${rango.etiqueta} · ${formatoFecha(rango.desde, { corta: true })} – ${formatoFecha(rango.hasta, { corta: true })}`;
}

// =====================================================================
// Renderers
// =====================================================================
function renderKPIs(data) {
  const $grid = document.getElementById('kpis-principales');
  const totalMoneda = (n) => {
    const { simbolo, valor } = formatoMonedaPartes(n);
    return `<span class="moneda">${simbolo}</span>${valor}`;
  };

  // Determinar el parámetro de rango para pasarle a las páginas destino.
  // Solo lo pasamos si es un rango "estándar" (no personalizado).
  const rangoParam = rangoActual !== "personalizado" ? `rango=${rangoActual}` : '';

  const kpis = [
    {
      etiqueta: "Vendido en el período",
      valor: totalMoneda(data.totalVendidoMes),
      pie: `${data.cantVentasMes} ${data.cantVentasMes === 1 ? 'venta' : 'ventas'} · ver detalle →`,
      acento: "",
      href: `pedidos.html${rangoParam ? '?' + rangoParam : ''}`
    },
    {
      etiqueta: "Cobrado en el período",
      valor: totalMoneda(data.totalCobradoMes),
      pie: data.totalVendidoMes > 0 ? `${Math.round((data.totalCobradoMes / data.totalVendidoMes) * 100)}% de lo vendido · ver →` : "—",
      acento: "ok",
      href: `pedidos.html?filtro=pagado${rangoParam ? '&' + rangoParam : ''}`
    },
    {
      etiqueta: "Pendiente de cobro",
      valor: totalMoneda(data.totalPendiente),
      pie: `${data.clientesConDeuda} ${data.clientesConDeuda === 1 ? 'cliente debe' : 'clientes deben'} · ver detalle →`,
      acento: data.totalPendiente > 0 ? "warn" : "",
      href: `pedidos.html?filtro=debe${rangoParam ? '&' + rangoParam : ''}`
    },
    {
      etiqueta: "Deuda total acumulada",
      valor: totalMoneda(data.deudaTotal),
      pie: "Histórico completo · ver clientes →",
      acento: data.deudaTotal > 0 ? "error" : "",
      href: `clientes.html?filtro=deudores`
    },
    {
      etiqueta: "Vendido hoy",
      valor: totalMoneda(data.totalVendidoHoy),
      pie: `${data.cantVentasHoy} ${data.cantVentasHoy === 1 ? 'venta' : 'ventas'} · ver →`,
      acento: "info",
      href: `pedidos.html?rango=hoy`
    },
    {
      etiqueta: "Pedidos pendientes",
      valor: data.pedidosPendientes,
      pie: `${data.pedidosEntregados} entregados · ver →`,
      acento: data.pedidosPendientes > 0 ? "warn" : "ok",
      href: `pedidos.html?filtro=pendiente`
    },
    {
      etiqueta: "Clientes",
      valor: data.cantClientes,
      pie: `${data.clientesConDeuda} con deuda · ver todos →`,
      acento: "",
      href: `clientes.html`
    },
    {
      etiqueta: "Productos en catálogo",
      valor: data.cantProductos,
      pie: data.productosARevisar > 0 ? `${data.productosARevisar} a revisar · ver →` : "Todos verificados · ver →",
      acento: data.productosARevisar > 0 ? "warn" : "ok",
      href: data.productosARevisar > 0 ? `productos.html?estado=revisar` : `productos.html`
    }
  ];

  $grid.innerHTML = kpis.map(k => `
    <a class="kpi kpi-link" href="${k.href}" style="text-decoration: none; color: inherit; display: block; cursor: pointer;">
      ${k.acento ? `<div class="kpi-acento ${k.acento}"></div>` : ''}
      <div class="kpi-etiqueta">${escapeHTML(k.etiqueta)}</div>
      <div class="kpi-valor">${k.valor}</div>
      <div class="kpi-pie">${escapeHTML(k.pie)}</div>
    </a>`).join('');
}

async function renderEvolucion() {
  // El gráfico siempre muestra los últimos 30 días independientemente
  // del rango (sirve para ver tendencia general)
  const datos = await evolucionVentasUltimosDias(30);
  const $vacio = document.getElementById('vacio-evolucion');
  const $canvas = document.getElementById('grafico-evolucion');
  const totalPeriodo = datos.reduce((s, d) => s + d.total, 0);

  if (totalPeriodo === 0) {
    $vacio.classList.remove('oculto');
    $canvas.style.display = 'none';
    if (chartEvolucion) { chartEvolucion.destroy(); chartEvolucion = null; }
    return;
  }
  $vacio.classList.add('oculto');
  $canvas.style.display = 'block';

  if (chartEvolucion) chartEvolucion.destroy();
  const ctx = $canvas.getContext('2d');
  const gradiente = ctx.createLinearGradient(0, 0, 0, 240);
  gradiente.addColorStop(0, 'rgba(168, 120, 107, 0.35)');
  gradiente.addColorStop(1, 'rgba(168, 120, 107, 0.0)');

  chartEvolucion = new Chart(ctx, {
    type: 'line',
    data: {
      labels: datos.map(d => d.etiqueta),
      datasets: [{
        label: 'Ventas', data: datos.map(d => d.total),
        borderColor: '#8a5448', backgroundColor: gradiente, fill: true,
        tension: 0.35, pointRadius: 0, pointHoverRadius: 5,
        pointHoverBackgroundColor: '#8a5448', pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2, borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#3a2a25', titleColor: '#f8f1e9', bodyColor: '#f8f1e9',
          borderColor: '#8a5448', borderWidth: 1, padding: 12, cornerRadius: 8,
          callbacks: { label: (c) => '  ' + formatoMoneda(c.parsed.y) }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#b8a89e', font: { size: 10, family: 'Outfit' }, maxRotation: 0, autoSkipPadding: 12 } },
        y: { grid: { color: 'rgba(168, 120, 107, 0.1)', drawBorder: false },
             ticks: { color: '#b8a89e', font: { size: 10, family: 'Outfit' }, callback: (v) => formatoMoneda(v, { compacto: true }) },
             beginAtZero: true }
      }
    }
  });
}

async function renderCategorias({ desde, hasta }) {
  const datos = await distribucionPorCategoria({ desde, hasta });
  const $vacio = document.getElementById('vacio-categorias');
  const $canvas = document.getElementById('grafico-categorias');

  if (datos.length === 0) {
    $vacio.classList.remove('oculto');
    $canvas.style.display = 'none';
    if (chartCategorias) { chartCategorias.destroy(); chartCategorias = null; }
    return;
  }
  $vacio.classList.add('oculto');
  $canvas.style.display = 'block';

  if (chartCategorias) chartCategorias.destroy();
  chartCategorias = new Chart($canvas.getContext('2d'), {
    type: 'doughnut',
    data: { labels: datos.map(d => d.categoria),
            datasets: [{ data: datos.map(d => d.total), backgroundColor: PALETA,
                         borderColor: '#fdf8f3', borderWidth: 2, hoverOffset: 8 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { color: '#5c463f', font: { size: 11, family: 'Outfit' },
                  usePointStyle: true, pointStyle: 'circle', padding: 12, boxWidth: 8 } },
        tooltip: { backgroundColor: '#3a2a25', titleColor: '#f8f1e9', bodyColor: '#f8f1e9',
                   padding: 12, cornerRadius: 8, callbacks: { label: (c) => '  ' + formatoMoneda(c.parsed) } }
      }
    }
  });
}

async function renderTopProductos({ desde, hasta }) {
  const $cont = document.getElementById('lista-top-productos');
  const productos = await rankingProductos({ desde, hasta, topN: 5 });

  if (productos.length === 0) {
    $cont.innerHTML = `<div class="vacio" style="padding: 20px;"><p>Todavía no hay ventas en el período.</p></div>`;
    return;
  }
  const maxCant = Math.max(...productos.map(p => p.cantidad));
  $cont.innerHTML = productos.map((p, i) => {
    const pct = Math.round((p.cantidad / maxCant) * 100);
    return `
      <div style="display:flex; align-items:center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--linea);">
        <div style="width:28px; height:28px; background:${i === 0 ? 'var(--terracota)' : 'var(--crema-oscura)'}; color:${i === 0 ? 'white' : 'var(--terracota)'}; border-radius:50%; display:flex; align-items:center; justify-content:center; font-family:var(--font-serif); font-size:14px; font-weight:500; flex-shrink:0;">${i + 1}</div>
        <div style="flex:1; min-width: 0;">
          <div style="font-size:13px; font-weight:500; color:var(--tinta); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(p.nombre)}</div>
          <div style="font-size:11px; color:var(--gris-suave); margin-top:2px;"><span class="mono">${escapeHTML(p.codigo)}</span> · ${p.cantidad} ${p.cantidad === 1 ? 'unidad' : 'unidades'}</div>
          <div style="margin-top:6px; height:3px; background:var(--crema-oscura); border-radius:999px; overflow:hidden;"><div style="height:100%; width:${pct}%; background:var(--rose-palo);"></div></div>
        </div>
        <div style="text-align:right; font-family:var(--font-serif); font-size:16px; color:var(--terracota); white-space:nowrap;">${formatoMoneda(p.ingresos, { compacto: true })}</div>
      </div>`;
  }).join('');
}

async function renderDeudores() {
  const $cont = document.getElementById('lista-deudores');
  const deudores = await rankingDeudores(5);
  if (deudores.length === 0) {
    $cont.innerHTML = `<div class="vacio" style="padding: 20px;"><p>Sin deudas pendientes. <span style="color: var(--estado-ok);">Excelente.</span></p></div>`;
    return;
  }
  $cont.innerHTML = deudores.map(c => {
    const nombre = `${c.nombre || ''} ${c.apellido || ''}`.trim() || 'Sin nombre';
    const inic = nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
    return `
      <a href="clientes.html?id=${encodeURIComponent(c.id)}" style="display:flex; align-items:center; gap:14px; padding:10px 0; border-bottom:1px solid var(--linea); color:inherit;">
        <div style="width:36px; height:36px; background:var(--rose-claro); color:var(--terracota); border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:500; font-size:13px; flex-shrink:0;">${escapeHTML(inic)}</div>
        <div style="flex:1; min-width: 0;">
          <div style="font-size:13px; font-weight:500; color:var(--tinta); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(nombre)}</div>
          <div style="font-size:11px; color:var(--gris-suave); margin-top:2px;">${escapeHTML(c.zona || c.direccion || 'Sin ubicación')}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:var(--font-serif); font-size:18px; color:var(--estado-error); white-space:nowrap;">${formatoMoneda(c.saldoPendiente, { compacto: true })}</div>
          <div style="font-size:10px; color:var(--gris-suave); letter-spacing:0.1em; text-transform:uppercase; margin-top:2px;">adeudado</div>
        </div>
      </a>`;
  }).join('');
}

// =====================================================================
// Orquestación
// =====================================================================
const KPIS_FALLBACK = {
  totalVendidoMes: 0, totalCobradoMes: 0, totalPendiente: 0, totalVendidoHoy: 0, deudaTotal: 0,
  cantVentasMes: 0, cantVentasHoy: 0, pedidosPendientes: 0, pedidosEntregados: 0,
  cantClientes: 0, clientesConDeuda: 0, cantProductos: 0, productosARevisar: 0, productosStockBajo: 0
};

async function cargarDashboard() {
  erroresAcumulados = [];

  const $grid = document.getElementById('kpis-principales');
  $grid.innerHTML = Array(8).fill(0).map(() => `
    <div class="kpi">
      <div class="skeleton skeleton-text" style="width: 60%; margin-bottom: 14px;"></div>
      <div class="skeleton skeleton-num"></div>
      <div class="skeleton skeleton-text" style="width: 40%; margin-top: 10px;"></div>
    </div>`).join('');

  const { desde, hasta } = rangoSeleccionado();
  actualizarSubtitulos();

  const [kpis] = await Promise.all([
    intentar('Cargar KPIs principales',     obtenerKPIsDashboard({ desde, hasta }), KPIS_FALLBACK),
    intentar('Top productos',               renderTopProductos({ desde, hasta }),  null),
    intentar('Top deudores',                renderDeudores(),                       null),
    intentar('Evolución de ventas',         renderEvolucion(),                      null),
    intentar('Distribución por categoría',  renderCategorias({ desde, hasta }),     null),
  ]);

  renderKPIs(kpis || KPIS_FALLBACK);

  if (kpis === KPIS_FALLBACK) {
    const totalProd = await intentar('Contar productos',  contarProductos(), 0);
    if (totalProd > 0) {
      const datos = { ...KPIS_FALLBACK, cantProductos: totalProd };
      renderKPIs(datos);
    }
  }

  mostrarErroresAcumulados();
}

// =====================================================================
// Eventos del selector de período
// =====================================================================
$selector.addEventListener('change', (e) => {
  const valor = e.target.value;

  if (valor === "personalizado") {
    // Mostrar inputs de fecha sin aplicar todavía
    $rangoPersonal.classList.add('visible');
    return;
  }

  // Rangos predefinidos: aplicar inmediato
  $rangoPersonal.classList.remove('visible');
  rangoActual = valor;
  rangoPersonalizado = null;
  guardarPeriodo();
  cargarDashboard();
});

document.getElementById('btn-aplicar-rango').addEventListener('click', () => {
  const desdeStr = $fechaDesde.value;
  const hastaStr = $fechaHasta.value;

  if (!desdeStr || !hastaStr) {
    toast('Seleccioná las dos fechas.', 'warn');
    return;
  }

  const desde = new Date(desdeStr + 'T00:00:00');
  const hasta = new Date(hastaStr + 'T23:59:59');

  if (desde > hasta) {
    toast('La fecha "Desde" debe ser anterior a "Hasta".', 'warn');
    return;
  }

  // Limitar a 2 años para evitar queries enormes
  const diffDias = Math.floor((hasta - desde) / (1000 * 60 * 60 * 24));
  if (diffDias > 730) {
    toast('El rango máximo es 2 años.', 'warn');
    return;
  }

  rangoActual = "personalizado";
  rangoPersonalizado = { desde, hasta };
  guardarPeriodo();
  toast(`Mostrando ${diffDias + 1} ${diffDias === 0 ? 'día' : 'días'}`, 'ok');
  cargarDashboard();
});

document.getElementById('btn-refrescar').addEventListener('click', () => {
  toast('Actualizando datos…', 'info');
  cargarDashboard();
});

// Carga inicial
cargarDashboard();
