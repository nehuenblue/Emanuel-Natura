// =====================================================================
// Emanuel Cosméticos · Capa de Datos (db.js)
// ---------------------------------------------------------------------
// Toda la interacción con Firestore vive en este archivo.
// Las páginas no llaman directamente a Firestore: usan estas funciones.
// =====================================================================

import { db, serverTimestamp, GeoPoint, auth } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter,
  addDoc, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { aDate } from "./utils.js";

// =====================================================================
//  CONFIGURACIÓN
// =====================================================================
export async function obtenerConfig() {
  const snap = await getDoc(doc(db, "configuracion", "app"));
  return snap.exists() ? snap.data() : null;
}

// =====================================================================
//  PRODUCTOS
// =====================================================================
export async function listarProductos({ categoria = null, soloActivos = false, estado = null } = {}) {
  const filtros = [];
  if (categoria)   filtros.push(where("categoria", "==", categoria));
  if (estado)      filtros.push(where("estado",    "==", estado));
  if (soloActivos) filtros.push(where("estado",    "==", "activo"));
  filtros.push(orderBy("categoria"), orderBy("nombre"));
  const q = query(collection(db, "productos"), ...filtros);
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function obtenerProducto(codigo) {
  const snap = await getDoc(doc(db, "productos", codigo));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function contarProductos() {
  const snap = await getDocs(collection(db, "productos"));
  return snap.size;
}

/**
 * Crea o sobreescribe un producto.
 * Usa setDoc porque el ID del doc es el código del producto.
 */
export async function crearProducto(producto) {
  const codigo = (producto.id || producto.codigo || "").toString().trim();
  if (!codigo) throw new Error("El código del producto es obligatorio.");
  if (!producto.nombre) throw new Error("El nombre es obligatorio.");

  const datos = {
    nombre:        (producto.nombre || "").trim(),
    categoria:     (producto.categoria || "Otros").trim(),
    precio:        Number(producto.precio) || 0,
    costo:         Number(producto.costo) || 0,
    puntos:        Number(producto.puntos) || 0,
    stock:         Number(producto.stock) || 0,
    observaciones: (producto.observaciones || "").trim(),
    estado:        producto.estado || "activo",
    ciclo:         producto.ciclo || "C07",
    creadoEn:      serverTimestamp(),
    creadoPor:     auth.currentUser?.email || "desconocido",
  };
  await setDoc(doc(db, "productos", codigo), datos);
  return codigo;
}

/**
 * Actualiza un producto. Solo toca los campos que vienen en `cambios`.
 */
export async function actualizarProducto(codigo, cambios) {
  const camposEditables = [
    "nombre", "categoria", "precio", "costo", "puntos",
    "stock", "observaciones", "estado", "ciclo"
  ];
  const datos = {};
  for (const campo of camposEditables) {
    if (campo in cambios) {
      const valor = cambios[campo];
      if (["precio", "costo", "puntos", "stock"].includes(campo)) {
        datos[campo] = Number(valor) || 0;
      } else if (typeof valor === "string") {
        datos[campo] = valor.trim();
      } else {
        datos[campo] = valor;
      }
    }
  }
  datos.actualizadoEn = serverTimestamp();
  datos.actualizadoPor = auth.currentUser?.email || "desconocido";
  await updateDoc(doc(db, "productos", codigo), datos);
}

/**
 * Borra un producto definitivamente. Usar con precaución.
 * Para "dar de baja" mejor usar actualizarProducto con estado: "inactivo".
 */
export async function eliminarProducto(codigo) {
  await deleteDoc(doc(db, "productos", codigo));
}

/**
 * Aplica un cambio masivo de precios en lote.
 * @param {string[]} codigos Códigos de productos a afectar
 * @param {Object} ajuste { tipo: 'porcentaje'|'fijo', valor: number }
 *   - 'porcentaje': suma X% al precio actual (ej: 15 = +15%, -10 = -10%)
 *   - 'fijo': establece el precio a este valor exacto
 *   - 'sumar': suma este valor en pesos al precio actual
 * @returns {Promise<number>} Cantidad de productos actualizados
 */
export async function actualizarPreciosEnLote(codigos, ajuste) {
  if (!Array.isArray(codigos) || codigos.length === 0) {
    throw new Error("No hay productos seleccionados.");
  }
  const tipo = ajuste?.tipo;
  const valor = Number(ajuste?.valor);
  if (!tipo || isNaN(valor)) throw new Error("Ajuste inválido.");

  // Firestore: máximo 500 ops por batch
  const TAMANO_LOTE = 500;
  let actualizados = 0;
  const email = auth.currentUser?.email || "desconocido";

  // Necesitamos leer los productos primero para los modos relativos
  for (let i = 0; i < codigos.length; i += TAMANO_LOTE) {
    const grupo = codigos.slice(i, i + TAMANO_LOTE);

    // Leer en paralelo
    const productos = await Promise.all(grupo.map(c => obtenerProducto(c)));

    const batch = writeBatch(db);
    for (let j = 0; j < grupo.length; j++) {
      const cod = grupo[j];
      const prod = productos[j];
      if (!prod) continue;

      let nuevoPrecio = prod.precio || 0;
      if (tipo === "porcentaje")  nuevoPrecio = Math.round(nuevoPrecio * (1 + valor / 100));
      else if (tipo === "sumar")  nuevoPrecio = Math.round(nuevoPrecio + valor);
      else if (tipo === "fijo")   nuevoPrecio = Math.round(valor);

      if (nuevoPrecio < 0) nuevoPrecio = 0;

      batch.update(doc(db, "productos", cod), {
        precio: nuevoPrecio,
        actualizadoEn: serverTimestamp(),
        actualizadoPor: email,
      });
      actualizados++;
    }
    await batch.commit();
  }
  return actualizados;
}

/**
 * Devuelve la lista de categorías existentes en el catálogo, ordenadas.
 */
export async function listarCategorias() {
  const productos = await listarProductos();
  const cats = [...new Set(productos.map(p => p.categoria).filter(Boolean))].sort();
  return cats;
}

// =====================================================================
//  CLIENTES
// =====================================================================

/**
 * Lista todos los clientes con filtros opcionales.
 * @param {Object} opts
 * @param {boolean} opts.soloActivos
 * @param {string}  opts.zona
 * @param {string}  opts.filtro       'todos' | 'deudores' | 'al-dia' | 'inactivos'
 */
export async function listarClientes({ soloActivos = false, zona = null, filtro = null } = {}) {
  // NOTA: filtro 'deudores' y 'al-dia' los aplicamos en memoria porque
  // saldoPendiente puede no estar indexado y filtrar por > 0 requiere índice.
  const filtros = [];
  if (zona) filtros.push(where("zona", "==", zona));
  if (filtro === "inactivos") filtros.push(where("estado", "==", "inactivo"));
  else if (soloActivos)       filtros.push(where("estado", "==", "activo"));

  filtros.push(orderBy("apellido"), orderBy("nombre"));
  const q = query(collection(db, "clientes"), ...filtros);
  const snap = await getDocs(q);
  let clientes = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Filtros en memoria
  if (filtro === "deudores") {
    clientes = clientes.filter(c => (c.saldoPendiente || 0) > 0);
  } else if (filtro === "al-dia") {
    clientes = clientes.filter(c => (c.saldoPendiente || 0) === 0 && c.estado !== "inactivo");
  }

  return clientes;
}

export async function obtenerCliente(clienteId) {
  const snap = await getDoc(doc(db, "clientes", clienteId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function contarClientes() {
  const snap = await getDocs(collection(db, "clientes"));
  return snap.size;
}

/**
 * Crea un nuevo cliente. Devuelve el ID generado.
 * @param {Object} datos { nombre, apellido, telefono, direccion, zona, ubicacion, observaciones }
 */
export async function crearCliente(datos) {
  if (!datos.nombre || !datos.apellido) {
    throw new Error("El nombre y apellido son obligatorios.");
  }
  const doc = {
    nombre:           (datos.nombre    || "").trim(),
    apellido:         (datos.apellido  || "").trim(),
    telefono:         (datos.telefono  || "").trim(),
    direccion:        (datos.direccion || "").trim(),
    zona:             (datos.zona      || "").trim(),
    observaciones:    (datos.observaciones || "").trim(),
    ubicacion:        datos.ubicacion || null,   // GeoPoint
    estado:           "activo",
    // Contadores denormalizados
    totalComprado:    0,
    totalPagado:      0,
    saldoPendiente:   0,
    cantidadCompras:  0,
    // Auditoría
    fechaAlta:        serverTimestamp(),
    creadoPor:        auth.currentUser?.email || "desconocido",
    actualizadoEn:    serverTimestamp(),
  };
  const ref = await addDoc(collection(db, "clientes"), doc);
  return ref.id;
}

/**
 * Actualiza los datos de un cliente. NO toca los contadores (esos los
 * actualizamos solo cuando se registra una venta o un pago).
 */
export async function actualizarCliente(clienteId, cambios) {
  const cambiosPermitidos = {};
  const camposEditables = [
    "nombre", "apellido", "telefono", "direccion", "zona",
    "observaciones", "ubicacion", "estado"
  ];
  for (const campo of camposEditables) {
    if (campo in cambios) {
      cambiosPermitidos[campo] = typeof cambios[campo] === "string"
        ? cambios[campo].trim()
        : cambios[campo];
    }
  }
  cambiosPermitidos.actualizadoEn = serverTimestamp();
  cambiosPermitidos.actualizadoPor = auth.currentUser?.email || "desconocido";
  await updateDoc(doc(db, "clientes", clienteId), cambiosPermitidos);
}

/**
 * "Eliminar" un cliente es marcarlo como inactivo (baja lógica).
 * Esto preserva el historial de ventas y la trazabilidad.
 */
export async function darDeBajaCliente(clienteId) {
  await updateDoc(doc(db, "clientes", clienteId), {
    estado: "inactivo",
    actualizadoEn: serverTimestamp(),
    actualizadoPor: auth.currentUser?.email || "desconocido"
  });
}

export async function reactivarCliente(clienteId) {
  await updateDoc(doc(db, "clientes", clienteId), {
    estado: "activo",
    actualizadoEn: serverTimestamp(),
    actualizadoPor: auth.currentUser?.email || "desconocido"
  });
}

/**
 * Lista las zonas únicas para usar como filtro.
 */
export async function listarZonas() {
  const clientes = await listarClientes();
  const zonas = [...new Set(clientes.map(c => c.zona).filter(Boolean))].sort();
  return zonas;
}

// =====================================================================
//  VENTAS
// =====================================================================
export async function listarVentas(opts = {}) {
  const filtros = [];
  if (opts.desde) filtros.push(where("fechaVenta", ">=", Timestamp.fromDate(aDate(opts.desde))));
  if (opts.hasta) filtros.push(where("fechaVenta", "<=", Timestamp.fromDate(aDate(opts.hasta))));
  if (opts.clienteId)    filtros.push(where("clienteId", "==", opts.clienteId));
  if (opts.estadoPedido) filtros.push(where("estadoPedido", "==", opts.estadoPedido));
  if (opts.estadoPago)   filtros.push(where("estadoPago", "==", opts.estadoPago));
  filtros.push(orderBy("fechaVenta", "desc"));
  if (opts.maxResultados) filtros.push(limit(opts.maxResultados));
  const q = query(collection(db, "ventas"), ...filtros);
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// =====================================================================
//  PAGOS
// =====================================================================
export async function listarPagos({ desde = null, hasta = null, clienteId = null } = {}) {
  const filtros = [];
  if (desde)     filtros.push(where("fecha", ">=", Timestamp.fromDate(aDate(desde))));
  if (hasta)     filtros.push(where("fecha", "<=", Timestamp.fromDate(aDate(hasta))));
  if (clienteId) filtros.push(where("clienteId", "==", clienteId));
  filtros.push(orderBy("fecha", "desc"));
  const q = query(collection(db, "pagos"), ...filtros);
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// =====================================================================
//  MOVIMIENTOS DE FONDOS
// =====================================================================
export async function listarMovimientosFondos({ desde = null, hasta = null, destino = null } = {}) {
  const filtros = [];
  if (desde) filtros.push(where("fecha", ">=", Timestamp.fromDate(aDate(desde))));
  if (hasta) filtros.push(where("fecha", "<=", Timestamp.fromDate(aDate(hasta))));
  if (destino) filtros.push(where("destino", "==", destino));
  filtros.push(orderBy("fecha", "desc"));
  const q = query(collection(db, "movimientosFondos"), ...filtros);
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// =====================================================================
//  ESTADÍSTICAS / DASHBOARD
// =====================================================================
export async function obtenerKPIsDashboard({ desde, hasta } = {}) {
  if (!desde) {
    const ahora = new Date();
    desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1, 0, 0, 0, 0);
  }
  if (!hasta) hasta = new Date();

  const inicioHoy = new Date(); inicioHoy.setHours(0,0,0,0);
  const finHoy    = new Date(); finHoy.setHours(23,59,59,999);

  const [ventasMes, pagosMes, ventasHoy, clientesTodos, productosTodos] = await Promise.all([
    listarVentas({ desde, hasta }),
    listarPagos({ desde, hasta }),
    listarVentas({ desde: inicioHoy, hasta: finHoy }),
    listarClientes(),
    listarProductos(),
  ]);

  const totalVendidoMes = ventasMes.reduce((s, v) => s + (v.total || 0), 0);
  const totalPagadoMes  = ventasMes.reduce((s, v) => s + (v.pagado || 0), 0);
  const totalPendiente  = ventasMes.reduce((s, v) => s + (v.saldo || 0), 0);

  const pedidosPendientes = ventasMes.filter(v => v.estadoPedido === "pendiente").length;
  const pedidosEntregados = ventasMes.filter(v => v.estadoPedido === "entregado").length;

  const totalCobradoMes = pagosMes.reduce((s, p) => s + (p.monto || 0), 0);
  const totalVendidoHoy = ventasHoy.reduce((s, v) => s + (v.total || 0), 0);
  const cantVentasHoy   = ventasHoy.length;

  const cantClientes = clientesTodos.length;
  const clientesConDeuda = clientesTodos.filter(c => (c.saldoPendiente || 0) > 0).length;
  const deudaTotal = clientesTodos.reduce((s, c) => s + (c.saldoPendiente || 0), 0);

  const cantProductos = productosTodos.length;
  const productosARevisar = productosTodos.filter(p => p.estado === "revisar").length;
  const productosStockBajo = productosTodos.filter(p => (p.stock || 0) > 0 && p.stock <= 5).length;

  return {
    periodo: { desde, hasta },
    totalVendidoMes, totalCobradoMes, totalPendiente, totalVendidoHoy, deudaTotal,
    cantVentasMes: ventasMes.length, cantVentasHoy,
    pedidosPendientes, pedidosEntregados,
    cantClientes, clientesConDeuda,
    cantProductos, productosARevisar, productosStockBajo,
    ventasMes, pagosMes,
  };
}

export async function rankingProductos({ desde, hasta, topN = 5 } = {}) {
  const ventas = await listarVentas({ desde, hasta });
  const acumulado = {};
  for (const v of ventas) {
    if (!Array.isArray(v.items)) continue;
    for (const item of v.items) {
      const cod = item.codigo || "?";
      if (!acumulado[cod]) acumulado[cod] = { codigo: cod, nombre: item.nombre || `Producto ${cod}`, cantidad: 0, ingresos: 0 };
      acumulado[cod].cantidad += item.cantidad || 0;
      acumulado[cod].ingresos += item.subtotal || (item.cantidad * item.precioUnit) || 0;
    }
  }
  return Object.values(acumulado).sort((a, b) => b.cantidad - a.cantidad).slice(0, topN);
}

export async function rankingDeudores(topN = 5) {
  const clientes = await listarClientes();
  return clientes
    .filter(c => (c.saldoPendiente || 0) > 0)
    .sort((a, b) => (b.saldoPendiente || 0) - (a.saldoPendiente || 0))
    .slice(0, topN);
}

export async function evolucionVentasUltimosDias(n = 30) {
  const desde = new Date(); desde.setDate(desde.getDate() - (n - 1)); desde.setHours(0,0,0,0);
  const hasta = new Date(); hasta.setHours(23,59,59,999);
  const ventas = await listarVentas({ desde, hasta });

  const mapa = {};
  for (let i = 0; i < n; i++) {
    const d = new Date(desde); d.setDate(d.getDate() + i);
    const iso = d.toISOString().substring(0, 10);
    mapa[iso] = { iso, etiqueta: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }), total: 0, cantidad: 0 };
  }
  for (const v of ventas) {
    const f = aDate(v.fechaVenta);
    if (!f) continue;
    const iso = f.toISOString().substring(0, 10);
    if (mapa[iso]) { mapa[iso].total += (v.total || 0); mapa[iso].cantidad += 1; }
  }
  return Object.values(mapa);
}

export async function distribucionPorCategoria({ desde, hasta } = {}) {
  const ventas = await listarVentas({ desde, hasta });
  const acumulado = {};
  for (const v of ventas) {
    if (!Array.isArray(v.items)) continue;
    for (const item of v.items) {
      const cat = item.categoria || "Sin categoría";
      if (!acumulado[cat]) acumulado[cat] = 0;
      acumulado[cat] += item.subtotal || (item.cantidad * item.precioUnit) || 0;
    }
  }
  return Object.entries(acumulado)
    .map(([categoria, total]) => ({ categoria, total }))
    .sort((a, b) => b.total - a.total);
}

// =====================================================================
//  RE-EXPORTS
// =====================================================================
export {
  db, serverTimestamp, GeoPoint, Timestamp,
  collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter,
  addDoc, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction
};
