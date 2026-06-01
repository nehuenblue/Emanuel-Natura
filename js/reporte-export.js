// =====================================================================
// Emanuel Cosméticos · Módulo de exportación de reportes (reporte-export.js)
// ---------------------------------------------------------------------
// Genera un reporte completo del período (vendido, cobrado, deuda,
// deudores, ganancia, ventas) y lo exporta en PDF, Word o Excel.
// Cada formato ofrece: descargar (celular + compu) y compartir por
// WhatsApp/otras apps vía Web Share API (en celular).
//
// Uso desde una página:
//   import { abrirExportador } from "../reporte-export.js";
//   abrirExportador({ desde, hasta, etiqueta });
// =====================================================================

import {
  obtenerKPIsDashboard, gananciaEstimada, rankingDeudores, listarVentas,
} from "./db.js";
import {
  formatoMoneda, formatoFecha, toast,
} from "./utils.js";

// ---------------------------------------------------------------------
// Recolección de datos del período
// ---------------------------------------------------------------------
async function recolectarDatos({ desde, hasta }) {
  const [kpis, ganancia, deudores, ventas] = await Promise.all([
    obtenerKPIsDashboard({ desde, hasta }).catch(() => null),
    gananciaEstimada({ desde, hasta }).catch(() => null),
    rankingDeudores(100).catch(() => []),
    listarVentas({ desde, hasta }).catch(() => []),
  ]);

  // Ventas computables (sin canceladas) para el detalle
  const ventasComputables = (ventas || []).filter(v => v.estadoPedido !== "cancelado");
  const canceladas = (ventas || []).length - ventasComputables.length;

  return { kpis, ganancia, deudores: deudores || [], ventas: ventasComputables, canceladas };
}

// ---------------------------------------------------------------------
// Helpers de archivo
// ---------------------------------------------------------------------
function fechaArchivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nombreCliente(c) {
  return `${c.nombre || ''} ${c.apellido || ''}`.trim() || 'Sin nombre';
}

// Descarga un Blob como archivo
function descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Comparte un archivo vía Web Share API (móvil). Devuelve true si se pudo.
async function compartirArchivo(blob, nombre, tipo, titulo) {
  try {
    const file = new File([blob], nombre, { type: tipo });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: titulo, text: titulo });
      return true;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return true; // el usuario canceló, no es error
    console.warn('[reporte] compartir falló:', err);
  }
  return false;
}

// ---------------------------------------------------------------------
// GENERADORES POR FORMATO
// ---------------------------------------------------------------------

// ----- PDF (jsPDF + autoTable) -----
function generarPDF(datos, meta) {
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor) {
    toast('No se pudo cargar el generador de PDF. Revisá tu conexión.', 'error');
    return null;
  }
  const { kpis, ganancia, deudores, ventas, canceladas } = datos;
  const doc = new jsPDFCtor({ unit: 'pt', format: 'a4' });

  // Encabezado
  doc.setFontSize(20);
  doc.setTextColor(60, 42, 35);
  doc.text('Emanuel Cosméticos', 40, 50);
  doc.setFontSize(13);
  doc.text('Reporte de ventas', 40, 70);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Período: ${meta.etiqueta} (${meta.desdeStr} – ${meta.hastaStr})`, 40, 88);
  doc.text(`Generado: ${new Date().toLocaleString('es-AR')}`, 40, 102);
  doc.setTextColor(0);

  // Resumen (KPIs)
  doc.autoTable({
    startY: 120,
    head: [['Resumen del período', '']],
    body: [
      ['Vendido', formatoMoneda(kpis?.totalVendidoMes || 0)],
      ['Cobrado', formatoMoneda(kpis?.totalCobradoMes || 0)],
      ['Por cobrar (período)', formatoMoneda(kpis?.totalPendiente || 0)],
      ['Deuda total acumulada', formatoMoneda(kpis?.deudaTotal || 0)],
      ['Cantidad de ventas', String(kpis?.cantVentasMes || 0)],
      ['Clientes con deuda', String(kpis?.clientesConDeuda || 0)],
      ['Ganancia estimada', ganancia ? formatoMoneda(ganancia.gananciaBruta) : '—'],
      ['Margen estimado', ganancia ? Math.round(ganancia.margenPct) + '%' : '—'],
    ],
    styles: { fontSize: 10, cellPadding: 5 },
    headStyles: { fillColor: [60, 42, 35], textColor: [248, 241, 233] },
    alternateRowStyles: { fillColor: [253, 248, 243] },
    columnStyles: { 1: { halign: 'right' } },
    margin: { left: 40, right: 40 },
  });

  // Deudores
  if (deudores.length > 0) {
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 20,
      head: [['Deudor', 'Teléfono', 'Compras', 'Debe']],
      body: deudores.map(d => [
        nombreCliente(d),
        d.telefono || '—',
        String(d.cantidadCompras || 0),
        formatoMoneda(d.saldoPendiente || 0),
      ]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [138, 84, 72], textColor: [248, 241, 233] },
      alternateRowStyles: { fillColor: [253, 248, 243] },
      columnStyles: { 3: { halign: 'right' } },
      margin: { left: 40, right: 40 },
      didDrawPage: (d) => {
        doc.setFontSize(11);
        doc.setTextColor(60, 42, 35);
        doc.text('Deudores', 40, d.settings.startY - 6);
        doc.setTextColor(0);
      },
    });
  }

  // Detalle de ventas
  if (ventas.length > 0) {
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 20,
      head: [['Fecha', 'Cliente', 'Total', 'Pagado', 'Saldo']],
      body: ventas.map(v => [
        formatoFecha(v.fechaVenta, { corta: true }),
        v.clienteNombre || '—',
        formatoMoneda(v.total || 0),
        formatoMoneda(v.pagado || 0),
        formatoMoneda(v.saldo || 0),
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [60, 42, 35], textColor: [248, 241, 233] },
      alternateRowStyles: { fillColor: [253, 248, 243] },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
      margin: { left: 40, right: 40 },
      didDrawPage: (d) => {
        doc.setFontSize(11);
        doc.setTextColor(60, 42, 35);
        doc.text(`Detalle de ventas${canceladas > 0 ? ` (${canceladas} cancelada${canceladas === 1 ? '' : 's'} no incluidas)` : ''}`, 40, d.settings.startY - 6);
        doc.setTextColor(0);
      },
    });
  }

  return doc.output('blob');
}

// ----- Excel (CSV multi-sección compatible con Excel) -----
function generarExcel(datos, meta) {
  const { kpis, ganancia, deudores, ventas, canceladas } = datos;
  const esc = (v) => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linea = (arr) => arr.map(esc).join(';');

  const filas = [];
  filas.push(linea(['Emanuel Cosméticos — Reporte de ventas']));
  filas.push(linea([`Período: ${meta.etiqueta} (${meta.desdeStr} - ${meta.hastaStr})`]));
  filas.push(linea([`Generado: ${new Date().toLocaleString('es-AR')}`]));
  filas.push('');

  filas.push(linea(['RESUMEN', 'Valor']));
  filas.push(linea(['Vendido', kpis?.totalVendidoMes || 0]));
  filas.push(linea(['Cobrado', kpis?.totalCobradoMes || 0]));
  filas.push(linea(['Por cobrar (período)', kpis?.totalPendiente || 0]));
  filas.push(linea(['Deuda total acumulada', kpis?.deudaTotal || 0]));
  filas.push(linea(['Cantidad de ventas', kpis?.cantVentasMes || 0]));
  filas.push(linea(['Clientes con deuda', kpis?.clientesConDeuda || 0]));
  filas.push(linea(['Ganancia estimada', ganancia ? ganancia.gananciaBruta : '']));
  filas.push(linea(['Margen %', ganancia ? Math.round(ganancia.margenPct) : '']));
  filas.push('');

  filas.push(linea(['DEUDORES']));
  filas.push(linea(['Nombre', 'Teléfono', 'Compras', 'Debe']));
  if (deudores.length === 0) {
    filas.push(linea(['(nadie debe)']));
  } else {
    deudores.forEach(d => filas.push(linea([
      nombreCliente(d), d.telefono || '', d.cantidadCompras || 0, d.saldoPendiente || 0,
    ])));
  }
  filas.push('');

  filas.push(linea([`DETALLE DE VENTAS${canceladas > 0 ? ` (${canceladas} canceladas no incluidas)` : ''}`]));
  filas.push(linea(['Fecha', 'Cliente', 'Total', 'Pagado', 'Saldo', 'Estado pedido']));
  if (ventas.length === 0) {
    filas.push(linea(['(sin ventas en el período)']));
  } else {
    ventas.forEach(v => filas.push(linea([
      formatoFecha(v.fechaVenta, { corta: true }),
      v.clienteNombre || '',
      v.total || 0, v.pagado || 0, v.saldo || 0,
      v.estadoPedido || '',
    ])));
  }

  const csv = '\uFEFF' + filas.join('\n');
  return new Blob([csv], { type: 'text/csv;charset=utf-8;' });
}

// ----- Word (.doc HTML que Word abre con formato) -----
function generarWord(datos, meta) {
  const { kpis, ganancia, deudores, ventas, canceladas } = datos;
  const m = (n) => formatoMoneda(n || 0);

  const filaDeudores = deudores.length === 0
    ? '<tr><td colspan="4">Nadie debe.</td></tr>'
    : deudores.map(d => `<tr>
        <td>${nombreCliente(d)}</td>
        <td>${d.telefono || '—'}</td>
        <td align="center">${d.cantidadCompras || 0}</td>
        <td align="right">${m(d.saldoPendiente)}</td>
      </tr>`).join('');

  const filaVentas = ventas.length === 0
    ? '<tr><td colspan="5">Sin ventas en el período.</td></tr>'
    : ventas.map(v => `<tr>
        <td>${formatoFecha(v.fechaVenta, { corta: true })}</td>
        <td>${v.clienteNombre || '—'}</td>
        <td align="right">${m(v.total)}</td>
        <td align="right">${m(v.pagado)}</td>
        <td align="right">${m(v.saldo)}</td>
      </tr>`).join('');

  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Reporte</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; color: #3a2a25; }
  h1 { font-size: 22pt; margin: 0; }
  h2 { font-size: 14pt; color: #8a5448; border-bottom: 2px solid #d4a89a; padding-bottom: 4px; margin-top: 24px; }
  .meta { color: #777; font-size: 10pt; margin: 8px 0 20px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 10pt; }
  th { background: #3c2a23; color: #f8f1e9; padding: 6px 8px; text-align: left; }
  td { padding: 5px 8px; border-bottom: 1px solid #eaded3; }
  .kpi-tabla td:last-child { text-align: right; font-weight: bold; }
</style></head>
<body>
  <h1>Emanuel Cosméticos</h1>
  <div style="font-size:13pt; color:#8a5448;">Reporte de ventas</div>
  <div class="meta">
    Período: <strong>${meta.etiqueta}</strong> (${meta.desdeStr} – ${meta.hastaStr})<br>
    Generado: ${new Date().toLocaleString('es-AR')}
  </div>

  <h2>Resumen del período</h2>
  <table class="kpi-tabla">
    <tr><td>Vendido</td><td>${m(kpis?.totalVendidoMes)}</td></tr>
    <tr><td>Cobrado</td><td>${m(kpis?.totalCobradoMes)}</td></tr>
    <tr><td>Por cobrar (período)</td><td>${m(kpis?.totalPendiente)}</td></tr>
    <tr><td>Deuda total acumulada</td><td>${m(kpis?.deudaTotal)}</td></tr>
    <tr><td>Cantidad de ventas</td><td>${kpis?.cantVentasMes || 0}</td></tr>
    <tr><td>Clientes con deuda</td><td>${kpis?.clientesConDeuda || 0}</td></tr>
    <tr><td>Ganancia estimada</td><td>${ganancia ? m(ganancia.gananciaBruta) : '—'}</td></tr>
    <tr><td>Margen estimado</td><td>${ganancia ? Math.round(ganancia.margenPct) + '%' : '—'}</td></tr>
  </table>

  <h2>Deudores</h2>
  <table>
    <tr><th>Deudor</th><th>Teléfono</th><th>Compras</th><th>Debe</th></tr>
    ${filaDeudores}
  </table>

  <h2>Detalle de ventas${canceladas > 0 ? ` <span style="font-size:9pt;color:#999;">(${canceladas} cancelada${canceladas === 1 ? '' : 's'} no incluidas)</span>` : ''}</h2>
  <table>
    <tr><th>Fecha</th><th>Cliente</th><th>Total</th><th>Pagado</th><th>Saldo</th></tr>
    ${filaVentas}
  </table>
</body></html>`;

  return new Blob(['\uFEFF' + html], { type: 'application/msword' });
}

// ---------------------------------------------------------------------
// UI: modal de exportación
// ---------------------------------------------------------------------
const FORMATOS = {
  pdf:   { ext: 'pdf',  tipo: 'application/pdf',                          gen: generarPDF,   label: 'PDF' },
  excel: { ext: 'csv',  tipo: 'text/csv',                                gen: generarExcel, label: 'Excel' },
  word:  { ext: 'doc',  tipo: 'application/msword',                      gen: generarWord,  label: 'Word' },
};

let datosCache = null;
let metaCache = null;

export async function abrirExportador({ desde, hasta, etiqueta }) {
  // Normalizar el período
  const meta = {
    etiqueta: etiqueta || 'Período',
    desdeStr: desde ? formatoFecha(desde) : 'inicio',
    hastaStr: hasta ? formatoFecha(hasta) : 'hoy',
  };
  metaCache = meta;

  // Crear / mostrar el modal
  let $ov = document.getElementById('modal-export-reporte');
  if (!$ov) {
    $ov = document.createElement('div');
    $ov.id = 'modal-export-reporte';
    $ov.className = 'modal-overlay';
    $ov.innerHTML = `
      <div class="modal" style="max-width: 460px;">
        <div class="flex flex-between mb-md">
          <h2 class="titulo-card">Exportar reporte</h2>
          <button class="btn-icono btn-fantasma" id="export-cerrar" aria-label="Cerrar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <p class="subtitulo mb-md" id="export-periodo"></p>
        <div id="export-estado" class="subtitulo mb-md">Preparando datos…</div>
        <div id="export-formatos" style="display:none;">
          <div class="etiqueta mb-sm">Elegí el formato</div>
          <div class="flex flex-gap-sm flex-wrap mb-md" id="export-botones-formato">
            <button class="btn btn-secundario" data-fmt="pdf">📄 PDF</button>
            <button class="btn btn-secundario" data-fmt="excel">📊 Excel</button>
            <button class="btn btn-secundario" data-fmt="word">📝 Word</button>
          </div>
          <div class="flex flex-gap-sm flex-wrap">
            <button class="btn btn-primario" id="export-descargar">⬇ Descargar</button>
            <button class="btn btn-secundario" id="export-compartir">💬 Compartir / WhatsApp</button>
          </div>
          <p class="subtitulo mt-sm" style="font-size:11px;" id="export-hint">El botón Compartir funciona en el celular y permite enviarlo por WhatsApp.</p>
        </div>
      </div>`;
    document.body.appendChild($ov);

    $ov.querySelector('#export-cerrar').addEventListener('click', cerrarExportador);
    $ov.addEventListener('click', (e) => { if (e.target === $ov) cerrarExportador(); });
  }

  $ov.classList.add('abierto');
  $ov.querySelector('#export-periodo').textContent = `${meta.etiqueta} · ${meta.desdeStr} – ${meta.hastaStr}`;
  const $estado = $ov.querySelector('#export-estado');
  const $formatos = $ov.querySelector('#export-formatos');
  $estado.style.display = 'block';
  $estado.textContent = 'Preparando datos…';
  $formatos.style.display = 'none';

  // Recolectar datos
  try {
    datosCache = await recolectarDatos({ desde, hasta });
  } catch (err) {
    console.error('[reporte] error recolectando:', err);
    $estado.textContent = 'No se pudieron cargar los datos del reporte.';
    return;
  }

  $estado.style.display = 'none';
  $formatos.style.display = 'block';

  // Selección de formato
  let fmtSel = 'pdf';
  const marcarFmt = (fmt) => {
    fmtSel = fmt;
    $ov.querySelectorAll('#export-botones-formato button').forEach(b => {
      b.classList.toggle('btn-primario', b.dataset.fmt === fmt);
      b.classList.toggle('btn-secundario', b.dataset.fmt !== fmt);
    });
  };
  marcarFmt('pdf');
  $ov.querySelectorAll('#export-botones-formato button').forEach(b => {
    b.onclick = () => marcarFmt(b.dataset.fmt);
  });

  // Construye el blob del formato elegido
  const construir = () => {
    const cfg = FORMATOS[fmtSel];
    const blob = cfg.gen(datosCache, metaCache);
    if (!blob) return null;
    const nombre = `reporte_${fechaArchivo()}.${cfg.ext}`;
    return { blob, nombre, tipo: cfg.tipo };
  };

  // Descargar
  $ov.querySelector('#export-descargar').onclick = () => {
    const r = construir();
    if (!r) return;
    descargarBlob(r.blob, r.nombre);
    toast(`Reporte ${FORMATOS[fmtSel].label} descargado.`, 'ok');
  };

  // Compartir (Web Share API)
  $ov.querySelector('#export-compartir').onclick = async () => {
    const r = construir();
    if (!r) return;
    const titulo = `Reporte ${metaCache.etiqueta} — Emanuel Cosméticos`;
    const ok = await compartirArchivo(r.blob, r.nombre, r.tipo, titulo);
    if (!ok) {
      // Fallback: descargar y avisar cómo adjuntarlo
      descargarBlob(r.blob, r.nombre);
      toast('Tu dispositivo no permite compartir directo. Descargué el archivo: adjuntalo en WhatsApp manualmente.', 'info');
    }
  };
}

function cerrarExportador() {
  const $ov = document.getElementById('modal-export-reporte');
  if ($ov) $ov.classList.remove('abierto');
}
