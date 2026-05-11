// =====================================================================
// Emanuel Cosméticos · Dashboard (js/pages/dashboard.js)
// =====================================================================

import { requireAuth } from "../auth.js";
import { renderLayout } from "../layout.js";
import {
  obtenerKPIsDashboard,
  rankingProductos,
  rankingDeudores,
  evolucionVentasUltimosDias,
  distribucionPorCategoria
} from "../db.js";
import {
  formatoMoneda, formatoMonedaPartes, formatoFecha,
  RANGOS, escapeHTML, toast, $, $$
} from "../utils.js";

// =====================================================================
// 1. Bootstrap
// =====================================================================
const usuario = await requireAuth();

document.getElementById('pantalla-carga').style.display = 'none';
document.getElementById('app').style.display = 'grid';

renderLayout({ usuario, paginaActiva: "dashboard" });

document.getElementById('saludo-usuario').textContent =
  `Hola ${usuario.nombre || usuario.email.split('@')[0]}. Acá está el resumen del negocio.`;

// =====================================================================
// 2. Estado de la página
// =====================================================================
let rangoActual = "esteMes";
let chartEvolucion = null;
let chartCategorias = null;

// Paleta para gráficos (consistente con el design system)
const PALETA = [
  '#a8786b', '#c89c8e', '#8a5448', '#e8c6b3',
  '#5e7c5b', '#b88a3a', '#4a6c7a', '#b8413a'
];

// =====================================================================
// 3. Render de KPIs principales
// =====================================================================
function renderKPIs(data) {
  const $grid = document.getElementById('kpis-principales');

  const totalMoneda = (n) => {
    const { simbolo, valor } = formatoMonedaPartes(n);
    return `<span class="moneda">${simbolo}</span>${valor}`;
  };

  const kpis = [
    {
      etiqueta: "Vendido en el período",
      valor: totalMoneda(data.totalVendidoMes),
      pie: `${data.cantVentasMes} ${data.cantVentasMes === 1 ? 'venta' : 'ventas'}`,
      acento: ""
    },
    {
      etiqueta: "Cobrado en el período",
      valor: totalMoneda(data.totalCobradoMes),
      pie: data.totalVendidoMes > 0
        ? `${Math.round((data.totalCobradoMes / data.totalVendidoMes) * 100)}% de lo vendido`
        : "—",
      acento: "ok"
    },
    {
      etiqueta: "Pendiente de cobro",
      valor: totalMoneda(data.totalPendiente),
      pie: `${data.clientesConDeuda} ${data.clientesConDeuda === 1 ? 'cliente debe' : 'clientes deben'}`,
      acento: data.totalPendiente > 0 ? "warn" : ""
    },
    {
      etiqueta: "Deuda total acumulada",
      valor: totalMoneda(data.deudaTotal),
      pie: "Histórico completo",
      acento: data.deudaTotal > 0 ? "error" : ""
    },
    {
      etiqueta: "Vendido hoy",
      valor: totalMoneda(data.totalVendidoHoy),
      pie: `${data.cantVentasHoy} ${data.cantVentasHoy === 1 ? 'venta' : 'ventas'}`,
      acento: "info"
    },
    {
      etiqueta: "Pedidos pendientes",
      valor: data.pedidosPendientes,
      pie: `${data.pedidosEntregados} entregados`,
      acento: data.pedidosPendientes > 0 ? "warn" : "ok"
    },
    {
      etiqueta: "Clientes",
      valor: data.cantClientes,
      pie: `${data.clientesConDeuda} con deuda`,
      acento: ""
    },
    {
      etiqueta: "Productos en catálogo",
      valor: data.cantProductos,
      pie: data.productosARevisar > 0
        ? `${data.productosARevisar} a revisar`
        : "Todos verificados",
      acento: data.productosARevisar > 0 ? "warn" : "ok"
    }
  ];

  $grid.innerHTML = kpis.map(k => `
    <div class="kpi">
      ${k.acento ? `<div class="kpi-acento ${k.acento}"></div>` : ''}
      <div class="kpi-etiqueta">${escapeHTML(k.etiqueta)}</div>
      <div class="kpi-valor">${k.valor}</div>
      <div class="kpi-pie">${escapeHTML(k.pie)}</div>
    </div>
  `).join('');
}

// =====================================================================
// 4. Gráfico de evolución diaria
// =====================================================================
async function renderEvolucion() {
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

  const labels = datos.map(d => d.etiqueta);
  const totales = datos.map(d => d.total);

  if (chartEvolucion) chartEvolucion.destroy();
  const ctx = $canvas.getContext('2d');

  // Gradiente como fondo del área
  const gradiente = ctx.createLinearGradient(0, 0, 0, 240);
  gradiente.addColorStop(0, 'rgba(168, 120, 107, 0.35)');
  gradiente.addColorStop(1, 'rgba(168, 120, 107, 0.0)');

  chartEvolucion = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Ventas',
        data: totales,
        borderColor: '#8a5448',
        backgroundColor: gradiente,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#8a5448',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#3a2a25',
          titleColor: '#f8f1e9',
          bodyColor: '#f8f1e9',
          borderColor: '#8a5448',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => '  ' + formatoMoneda(ctx.parsed.y)
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#b8a89e',
            font: { size: 10, family: 'Outfit' },
            maxRotation: 0,
            autoSkipPadding: 12
          }
        },
        y: {
          grid: { color: 'rgba(168, 120, 107, 0.1)', drawBorder: false },
          ticks: {
            color: '#b8a89e',
            font: { size: 10, family: 'Outfit' },
            callback: (v) => formatoMoneda(v, { compacto: true })
          },
          beginAtZero: true
        }
      }
    }
  });
}

// =====================================================================
// 5. Gráfico de distribución por categoría
// =====================================================================
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
    data: {
      labels: datos.map(d => d.categoria),
      datasets: [{
        data: datos.map(d => d.total),
        backgroundColor: PALETA,
        borderColor: '#fdf8f3',
        borderWidth: 2,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#5c463f',
            font: { size: 11, family: 'Outfit' },
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 12,
            boxWidth: 8
          }
        },
        tooltip: {
          backgroundColor: '#3a2a25',
          titleColor: '#f8f1e9',
          bodyColor: '#f8f1e9',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => '  ' + formatoMoneda(ctx.parsed)
          }
        }
      }
    }
  });
}

// =====================================================================
// 6. Listas de ranking
// =====================================================================
async function renderTopProductos({ desde, hasta }) {
  const $cont = document.getElementById('lista-top-productos');
  const productos = await rankingProductos({ desde, hasta, topN: 5 });

  if (productos.length === 0) {
    $cont.innerHTML = `
      <div class="vacio" style="padding: 20px;">
        <p>Todavía no hay ventas en el período.</p>
      </div>`;
    return;
  }

  const maxCant = Math.max(...productos.map(p => p.cantidad));

  $cont.innerHTML = productos.map((p, i) => {
    const pct = Math.round((p.cantidad / maxCant) * 100);
    return `
      <div style="display:flex; align-items:center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--linea);">
        <div style="
          width: 28px; height: 28px;
          background: ${i === 0 ? 'var(--terracota)' : 'var(--crema-oscura)'};
          color: ${i === 0 ? 'white' : 'var(--terracota)'};
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-family: var(--font-serif); font-size: 14px; font-weight: 500;
          flex-shrink: 0;
        ">${i + 1}</div>
        <div style="flex:1; min-width: 0;">
          <div style="font-size: 13px; font-weight: 500; color: var(--tinta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(p.nombre)}</div>
          <div style="font-size: 11px; color: var(--gris-suave); margin-top: 2px;">
            <span class="mono">${escapeHTML(p.codigo)}</span> · ${p.cantidad} ${p.cantidad === 1 ? 'unidad' : 'unidades'}
          </div>
          <div style="margin-top: 6px; height: 3px; background: var(--crema-oscura); border-radius: 999px; overflow: hidden;">
            <div style="height: 100%; width: ${pct}%; background: var(--rose-palo);"></div>
          </div>
        </div>
        <div style="text-align: right; font-family: var(--font-serif); font-size: 16px; color: var(--terracota); white-space: nowrap;">
          ${formatoMoneda(p.ingresos, { compacto: true })}
        </div>
      </div>`;
  }).join('');
}

async function renderDeudores() {
  const $cont = document.getElementById('lista-deudores');
  const deudores = await rankingDeudores(5);

  if (deudores.length === 0) {
    $cont.innerHTML = `
      <div class="vacio" style="padding: 20px;">
        <p>Sin deudas pendientes. <span style="color: var(--estado-ok);">Excelente.</span></p>
      </div>`;
    return;
  }

  $cont.innerHTML = deudores.map(c => {
    const nombre = `${c.nombre || ''} ${c.apellido || ''}`.trim() || 'Sin nombre';
    const inic = nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
    return `
      <a href="clientes.html?id=${encodeURIComponent(c.id)}"
         style="display:flex; align-items:center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--linea); color: inherit;">
        <div style="
          width: 36px; height: 36px;
          background: var(--rose-claro);
          color: var(--terracota);
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-weight: 500; font-size: 13px;
          flex-shrink: 0;
        ">${escapeHTML(inic)}</div>
        <div style="flex:1; min-width: 0;">
          <div style="font-size: 13px; font-weight: 500; color: var(--tinta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(nombre)}</div>
          <div style="font-size: 11px; color: var(--gris-suave); margin-top: 2px;">
            ${escapeHTML(c.zona || c.direccion || 'Sin ubicación')}
          </div>
        </div>
        <div style="text-align: right;">
          <div style="font-family: var(--font-serif); font-size: 18px; color: var(--estado-error); white-space: nowrap;">
            ${formatoMoneda(c.saldoPendiente, { compacto: true })}
          </div>
          <div style="font-size: 10px; color: var(--gris-suave); letter-spacing: 0.1em; text-transform: uppercase; margin-top: 2px;">
            adeudado
          </div>
        </div>
      </a>`;
  }).join('');
}

// =====================================================================
// 7. Orquestación
// =====================================================================
function rangoSeleccionado() {
  return RANGOS[rangoActual]();
}

function actualizarSubtitulos() {
  const rango = rangoSeleccionado();
  document.getElementById('subtit-evolucion').textContent =
    `${formatoFecha(rango.desde, { corta: true })} – ${formatoFecha(rango.hasta, { corta: true })}`;
}

async function cargarDashboard() {
  document.getElementById('aviso-inicial').innerHTML = '';

  // Mostrar skeletons mientras carga
  const $grid = document.getElementById('kpis-principales');
  $grid.innerHTML = Array(8).fill(0).map(() => `
    <div class="kpi">
      <div class="skeleton skeleton-text" style="width: 60%; margin-bottom: 14px;"></div>
      <div class="skeleton skeleton-num"></div>
      <div class="skeleton skeleton-text" style="width: 40%; margin-top: 10px;"></div>
    </div>`).join('');

  try {
    const { desde, hasta } = rangoSeleccionado();
    actualizarSubtitulos();

    // Cargar todo en paralelo
    const [kpis] = await Promise.all([
      obtenerKPIsDashboard({ desde, hasta }),
      renderTopProductos({ desde, hasta }),
      renderDeudores(),
      renderEvolucion(),
      renderCategorias({ desde, hasta }),
    ]);

    renderKPIs(kpis);

  } catch (e) {
    console.error('[dashboard]', e);
    document.getElementById('aviso-inicial').innerHTML = `
      <div class="alerta alerta-error mb-md">
        <strong>No se pudieron cargar los datos.</strong><br>
        ${escapeHTML(e.message || 'Error desconocido')}.
        Verificá que estés autenticado y que las reglas de Firestore estén publicadas.
      </div>`;
    // Vaciar skeletons
    $grid.innerHTML = '';
  }
}

// =====================================================================
// 8. Eventos
// =====================================================================
document.getElementById('selector-periodo').addEventListener('change', (e) => {
  rangoActual = e.target.value;
  cargarDashboard();
});

document.getElementById('btn-refrescar').addEventListener('click', () => {
  toast('Actualizando datos…', 'info');
  cargarDashboard();
});

// =====================================================================
// 9. Carga inicial
// =====================================================================
cargarDashboard();

