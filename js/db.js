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
    imagen:        producto.imagen || null,
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
    "stock", "observaciones", "estado", "ciclo", "imagen"
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
//  IMPORTADOR DE CATÁLOGO
// ---------------------------------------------------------------------
// Compara catálogo nuevo (JSON entrante) contra catálogo en Firestore
// y genera un "diff" para vista previa antes de aplicar.
// =====================================================================

/**
 * Calcula el diff entre el catálogo actual en Firestore y un catálogo
 * nuevo entrante.
 *
 * @param {Array} catalogoNuevo Array de productos del JSON nuevo
 * @returns {Promise<Object>} Diff con clasificación
 */
export async function calcularDiffCatalogo(catalogoNuevo) {
  if (!Array.isArray(catalogoNuevo) || catalogoNuevo.length === 0) {
    throw new Error("El catálogo nuevo está vacío o no es un array.");
  }

  // Validar campos mínimos del primer producto (para detectar JSON mal formado)
  const muestra = catalogoNuevo[0];
  if (!muestra.id && !muestra.codigo) {
    throw new Error("El JSON no tiene el campo 'id' o 'codigo'. Verificá el formato.");
  }
  if (typeof muestra.nombre !== "string") {
    throw new Error("El JSON no tiene el campo 'nombre' como texto. Verificá el formato.");
  }

  // Normalizar el catálogo nuevo (usar id como key)
  const nuevoPorId = {};
  for (const p of catalogoNuevo) {
    const id = String(p.id || p.codigo || "").trim();
    if (!id) continue;
    nuevoPorId[id] = {
      id,
      nombre:        (p.nombre || "").trim(),
      categoria:     (p.categoria || "Otros").trim(),
      precio:        Number(p.precio) || 0,
      costo:         Number(p.costo) || 0,
      puntos:        Number(p.puntos) || 0,
      stock:         typeof p.stock === "number" ? p.stock : 0,
      observaciones: (p.observaciones || "").trim(),
      estado:        p.estado || "activo",
      ciclo:         (p.ciclo || "").trim(),
    };
  }

  // Cargar catálogo actual de Firestore
  const actual = await listarProductos();
  const actualPorId = {};
  for (const p of actual) {
    actualPorId[p.id] = p;
  }

  // Clasificar
  const nuevos       = [];     // están en nuevo pero NO en actual
  const cambiados    = [];     // están en ambos PERO con datos diferentes
  const sinCambios   = [];     // están en ambos con mismos datos
  const discontinuados = [];   // están en actual pero NO en nuevo

  for (const idNuevo in nuevoPorId) {
    const np = nuevoPorId[idNuevo];
    const ap = actualPorId[idNuevo];

    if (!ap) {
      nuevos.push(np);
    } else {
      // Detectar si cambió algo relevante
      const precioCambio   = (ap.precio || 0) !== np.precio;
      const nombreCambio   = (ap.nombre || "") !== np.nombre;
      const categoriaCambio = (ap.categoria || "") !== np.categoria;
      const puntosCambio   = (ap.puntos || 0) !== np.puntos;

      if (precioCambio || nombreCambio || categoriaCambio || puntosCambio) {
        cambiados.push({
          ...np,
          // Guardamos los valores anteriores para mostrar en el diff
          _anterior: {
            precio:    ap.precio || 0,
            nombre:    ap.nombre || "",
            categoria: ap.categoria || "",
            puntos:    ap.puntos || 0,
          },
          _delta: {
            precio:     np.precio - (ap.precio || 0),
            precioPct:  (ap.precio || 0) > 0 ? ((np.precio - ap.precio) / ap.precio) * 100 : 0,
          }
        });
      } else {
        sinCambios.push(np);
      }
    }
  }

  // Buscar discontinuados (en actual pero no en nuevo)
  for (const idActual in actualPorId) {
    if (!nuevoPorId[idActual]) {
      const ap = actualPorId[idActual];
      // Si ya estaba inactivo, no contamos
      if (ap.estado === "inactivo") continue;
      discontinuados.push(ap);
    }
  }

  // Top cambios de precio (mayores aumentos y mayores bajas)
  const conCambioPrecio = cambiados.filter(p => p._delta.precio !== 0);
  const topAumentos = [...conCambioPrecio]
    .sort((a, b) => b._delta.precioPct - a._delta.precioPct)
    .slice(0, 10);
  const topBajas = [...conCambioPrecio]
    .sort((a, b) => a._delta.precioPct - b._delta.precioPct)
    .filter(p => p._delta.precio < 0)
    .slice(0, 5);

  return {
    resumen: {
      totalNuevo:        Object.keys(nuevoPorId).length,
      nuevos:            nuevos.length,
      cambiados:         cambiados.length,
      sinCambios:        sinCambios.length,
      discontinuados:    discontinuados.length,
      conCambioPrecio:   conCambioPrecio.length,
    },
    nuevos,
    cambiados,
    sinCambios,
    discontinuados,
    topAumentos,
    topBajas,
  };
}

/**
 * Aplica el diff calculado: actualiza, crea, inactiva en batches.
 *
 * @param {Object} diff Resultado de calcularDiffCatalogo()
 * @param {string} cicloNuevo Ej: "C08"
 * @param {Function} onProgreso Callback opcional (cargados, total)
 * @returns {Promise<Object>} Reporte de la operación
 */
export async function aplicarDiffCatalogo(diff, cicloNuevo, onProgreso) {
  if (!cicloNuevo || typeof cicloNuevo !== "string") {
    throw new Error("Especificá un ciclo nuevo (ej: 'C08').");
  }
  cicloNuevo = cicloNuevo.trim().toUpperCase();

  const email = auth.currentUser?.email || "desconocido";
  const ts = serverTimestamp();
  const TAMANO_LOTE = 500;

  // Construir todas las operaciones
  const operaciones = [];

  // 1. Crear los nuevos
  for (const p of diff.nuevos) {
    operaciones.push({
      tipo: "set",
      codigo: p.id,
      datos: {
        ...p,
        ciclo:       cicloNuevo,
        cicloAlta:   cicloNuevo,
        creadoEn:    ts,
        creadoPor:   email,
      }
    });
  }

  // 2. Actualizar los cambiados
  for (const p of diff.cambiados) {
    operaciones.push({
      tipo: "update",
      codigo: p.id,
      datos: {
        nombre:    p.nombre,
        categoria: p.categoria,
        precio:    p.precio,
        puntos:    p.puntos,
        ciclo:     cicloNuevo,
        actualizadoEn:  ts,
        actualizadoPor: email,
      }
    });
  }

  // 3. Inactivar los discontinuados (NO se borran, solo se marcan)
  for (const p of diff.discontinuados) {
    operaciones.push({
      tipo: "update",
      codigo: p.id,
      datos: {
        estado:           "inactivo",
        descontinuadoEn:  cicloNuevo,
        actualizadoEn:    ts,
        actualizadoPor:   email,
      }
    });
  }

  // 4. Actualizar ciclo en los que están sin cambios (para que también pasen al ciclo nuevo)
  for (const p of diff.sinCambios) {
    operaciones.push({
      tipo: "update",
      codigo: p.id,
      datos: {
        ciclo:          cicloNuevo,
        actualizadoEn:  ts,
        actualizadoPor: email,
      }
    });
  }

  // Ejecutar en batches
  const total = operaciones.length;
  let procesados = 0;
  let errores = [];

  for (let i = 0; i < operaciones.length; i += TAMANO_LOTE) {
    const lote = operaciones.slice(i, i + TAMANO_LOTE);
    const batch = writeBatch(db);

    for (const op of lote) {
      const ref = doc(db, "productos", op.codigo);
      if (op.tipo === "set") batch.set(ref, op.datos);
      else if (op.tipo === "update") batch.update(ref, op.datos);
    }

    try {
      await batch.commit();
      procesados += lote.length;
      if (onProgreso) onProgreso(procesados, total);
    } catch (err) {
      errores.push({ lote: i / TAMANO_LOTE + 1, error: err.message });
    }
  }

  // Guardar registro de la importación
  try {
    await addDoc(collection(db, "configuracion", "importaciones-catalogo".split(":")[0], "log"), {
      fecha:      ts,
      por:        email,
      cicloViejo: diff.nuevos.length > 0 ? "varios" : "",
      cicloNuevo,
      resumen:    diff.resumen,
    }).catch(() => {});  // No bloqueante si falla
  } catch (e) { /* no crítico */ }

  return {
    procesados,
    total,
    errores,
    cicloNuevo,
    timestamp: new Date(),
  };
}

// =====================================================================
//  VENTAS
// =====================================================================

/**
 * Crea una venta nueva con sus items, registra el pago inicial (si hay),
 * y actualiza los contadores del cliente. Todo en una transacción atómica.
 *
 * @param {Object} venta
 * @param {string} venta.clienteId      ID del cliente
 * @param {string} venta.clienteNombre  Nombre completo (denormalizado)
 * @param {Array}  venta.items          [{codigo, nombre, categoria, cantidad, precioUnit, subtotal}]
 * @param {number} venta.total          Total de la venta
 * @param {number} venta.pagado         Monto pagado en el momento de la venta
 * @param {string} venta.formaPago      'efectivo' | 'transferencia' | 'mercadopago' | 'otro'
 * @param {string} venta.estadoPedido   'pendiente' | 'entregado'
 * @param {string} venta.observaciones
 * @param {Date}   venta.fechaEntrega   Opcional
 * @returns {Promise<string>} ID de la venta creada
 */
export async function crearVenta(venta) {
  // Validaciones
  if (!venta.clienteId)                 throw new Error("Falta el cliente.");
  if (!Array.isArray(venta.items))      throw new Error("Items inválidos.");
  if (venta.items.length === 0)         throw new Error("Agregá al menos un producto.");
  if (typeof venta.total !== "number" || venta.total <= 0) throw new Error("El total debe ser mayor a 0.");
  const pagado = Number(venta.pagado) || 0;
  if (pagado < 0)                       throw new Error("El monto pagado no puede ser negativo.");
  if (pagado > venta.total)             throw new Error("El monto pagado no puede ser mayor al total.");

  const saldo = venta.total - pagado;
  const email = auth.currentUser?.email || "desconocido";

  // Determinar estado de pago
  let estadoPago;
  if (saldo === 0)        estadoPago = "pagado";
  else if (pagado === 0)  estadoPago = "debe";
  else                    estadoPago = "parcial";

  const estadoPedido = venta.estadoPedido || "pendiente";

  // Documento de venta
  const ventaDoc = {
    clienteId:      venta.clienteId,
    clienteNombre:  venta.clienteNombre || "",
    items:          venta.items.map(it => ({
      codigo:     String(it.codigo || ""),
      nombre:     String(it.nombre || ""),
      categoria:  String(it.categoria || ""),
      cantidad:   Number(it.cantidad) || 1,
      precioUnit: Number(it.precioUnit) || 0,
      subtotal:   Number(it.subtotal) || 0,
    })),
    total:          Number(venta.total),
    pagado:         pagado,
    saldo:          saldo,
    estadoPedido,
    estadoPago,
    formaPago:      venta.formaPago || "efectivo",
    observaciones:  (venta.observaciones || "").trim(),
    fechaVenta:     serverTimestamp(),
    fechaEntrega:   venta.fechaEntrega
                      ? Timestamp.fromDate(aDate(venta.fechaEntrega))
                      : null,
    ubicacion:      venta.ubicacion || null,
    creadoPor:      email,
  };

  // Transacción: crear venta + crear pago (si hubo) + actualizar cliente
  const ventaRef = doc(collection(db, "ventas"));
  const clienteRef = doc(db, "clientes", venta.clienteId);
  let pagoRef = null;

  await runTransaction(db, async (transaction) => {
    // Leer cliente (necesario antes de cualquier write en transacción)
    const clienteSnap = await transaction.get(clienteRef);
    if (!clienteSnap.exists()) {
      throw new Error("El cliente no existe o fue eliminado.");
    }
    const cliente = clienteSnap.data();

    // 1. Crear la venta
    transaction.set(ventaRef, ventaDoc);

    // 2. Si hubo pago inicial, crear el documento de pago
    if (pagado > 0) {
      pagoRef = doc(collection(db, "pagos"));
      transaction.set(pagoRef, {
        clienteId:   venta.clienteId,
        ventaId:     ventaRef.id,
        monto:       pagado,
        formaPago:   venta.formaPago || "efectivo",
        observaciones: "Pago en el momento de la venta",
        fecha:       serverTimestamp(),
        creadoPor:   email,
      });
    }

    // 3. Actualizar contadores del cliente (denormalización)
    transaction.update(clienteRef, {
      totalComprado:   (cliente.totalComprado || 0) + venta.total,
      totalPagado:     (cliente.totalPagado || 0) + pagado,
      saldoPendiente:  (cliente.saldoPendiente || 0) + saldo,
      cantidadCompras: (cliente.cantidadCompras || 0) + 1,
      ultimaCompra:    serverTimestamp(),
      actualizadoEn:   serverTimestamp(),
    });
  });

  return ventaRef.id;
}

/**
 * Obtiene una venta por su ID.
 */
export async function obtenerVenta(ventaId) {
  const snap = await getDoc(doc(db, "ventas", ventaId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Cambia el estado de un pedido (pendiente, entregado, cancelado).
 * Solo modifica campos permitidos por las reglas de Firestore.
 */
export async function cambiarEstadoPedido(ventaId, nuevoEstado, observaciones = null) {
  const estadosValidos = ["pendiente", "entregado", "cancelado"];
  if (!estadosValidos.includes(nuevoEstado)) {
    throw new Error(`Estado inválido: ${nuevoEstado}`);
  }

  const cambios = {
    estadoPedido:   nuevoEstado,
    actualizadoEn:  serverTimestamp(),
  };
  if (nuevoEstado === "entregado") {
    cambios.fechaEntrega = serverTimestamp();
  }
  if (observaciones !== null) {
    cambios.observaciones = observaciones;
  }

  // Si se cancela, hay que revertir los contadores del cliente
  if (nuevoEstado === "cancelado") {
    const ventaSnap = await getDoc(doc(db, "ventas", ventaId));
    if (!ventaSnap.exists()) throw new Error("La venta no existe.");
    const venta = ventaSnap.data();
    if (venta.estadoPedido === "cancelado") return; // ya estaba cancelada

    const clienteRef = doc(db, "clientes", venta.clienteId);

    await runTransaction(db, async (transaction) => {
      const clienteSnap = await transaction.get(clienteRef);
      if (clienteSnap.exists()) {
        const cliente = clienteSnap.data();
        transaction.update(clienteRef, {
          totalComprado:   Math.max(0, (cliente.totalComprado || 0) - (venta.total || 0)),
          totalPagado:     Math.max(0, (cliente.totalPagado || 0) - (venta.pagado || 0)),
          saldoPendiente:  Math.max(0, (cliente.saldoPendiente || 0) - (venta.saldo || 0)),
          cantidadCompras: Math.max(0, (cliente.cantidadCompras || 0) - 1),
          actualizadoEn:   serverTimestamp(),
        });
      }
      transaction.update(doc(db, "ventas", ventaId), cambios);
    });
    return;
  }

  // Para otros estados, update simple
  await updateDoc(doc(db, "ventas", ventaId), cambios);
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

/**
 * Registra un pago contra una venta específica.
 * Actualiza la venta (pagado, saldo, estadoPago) y el cliente en una transacción.
 *
 * @param {Object} datos
 * @param {string} datos.ventaId       ID de la venta
 * @param {number} datos.monto         Monto del pago
 * @param {string} datos.formaPago     'efectivo' | 'transferencia' | 'mercadopago' | 'otro'
 * @param {string} datos.observaciones (opcional)
 * @returns {Promise<string>} ID del pago creado
 */
export async function registrarPago(datos) {
  if (!datos.ventaId) throw new Error("Falta la venta.");
  const monto = Number(datos.monto);
  if (!monto || monto <= 0) throw new Error("El monto debe ser mayor a 0.");

  const email = auth.currentUser?.email || "desconocido";
  const ventaRef = doc(db, "ventas", datos.ventaId);
  const pagoRef  = doc(collection(db, "pagos"));

  let pagoId;

  await runTransaction(db, async (transaction) => {
    const ventaSnap = await transaction.get(ventaRef);
    if (!ventaSnap.exists()) throw new Error("La venta no existe.");
    const venta = ventaSnap.data();

    if (venta.estadoPedido === "cancelado") {
      throw new Error("No se puede pagar una venta cancelada.");
    }

    const nuevoPagado = (venta.pagado || 0) + monto;
    const nuevoSaldo  = (venta.total || 0) - nuevoPagado;

    if (nuevoSaldo < 0) {
      throw new Error(`El pago excede el saldo. Saldo actual: ${(venta.saldo || 0)}.`);
    }

    let nuevoEstadoPago;
    if (nuevoSaldo === 0)      nuevoEstadoPago = "pagado";
    else if (nuevoPagado > 0)  nuevoEstadoPago = "parcial";
    else                       nuevoEstadoPago = "debe";

    const clienteRef = doc(db, "clientes", venta.clienteId);
    const clienteSnap = await transaction.get(clienteRef);
    if (!clienteSnap.exists()) throw new Error("El cliente no existe.");
    const cliente = clienteSnap.data();

    // 1. Crear el pago
    transaction.set(pagoRef, {
      clienteId:     venta.clienteId,
      ventaId:       datos.ventaId,
      monto,
      formaPago:     datos.formaPago || "efectivo",
      observaciones: (datos.observaciones || "").trim(),
      fecha:         serverTimestamp(),
      creadoPor:     email,
    });
    pagoId = pagoRef.id;

    // 2. Actualizar la venta (solo campos permitidos por las reglas)
    transaction.update(ventaRef, {
      pagado:        nuevoPagado,
      saldo:         nuevoSaldo,
      estadoPago:    nuevoEstadoPago,
      actualizadoEn: serverTimestamp(),
    });

    // 3. Actualizar contadores del cliente
    transaction.update(clienteRef, {
      totalPagado:    (cliente.totalPagado || 0) + monto,
      saldoPendiente: Math.max(0, (cliente.saldoPendiente || 0) - monto),
      actualizadoEn:  serverTimestamp(),
    });
  });

  return pagoId;
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
