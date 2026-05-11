// =====================================================================
// Emanuel Cosméticos — Capa de Acceso a Datos (db.js)
//
// Versión F0: solo helpers básicos. En F1+ se agregan los CRUDs
// completos de clientes, ventas, pagos, fondos, etc.
//
// Patrón: todas las funciones de I/O de Firestore viven acá. Las páginas
// (pages/*.js) NUNCA llaman a Firestore directo. Esto da:
//   - un único lugar para cambiar índices, denormalizar o agregar caché
//   - separación clara entre lógica de UI y lógica de datos
//   - facilita escribir tests si los agregamos en el futuro
// =====================================================================

import { db, serverTimestamp, GeoPoint } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter,
  addDoc, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- Configuración ----------
export async function obtenerConfig() {
  const snap = await getDoc(doc(db, "configuracion", "app"));
  return snap.exists() ? snap.data() : null;
}

// ---------- Productos ----------
export async function listarProductos({ categoria = null, soloActivos = false } = {}) {
  let q = collection(db, "productos");
  const filtros = [];
  if (categoria)    filtros.push(where("categoria", "==", categoria));
  if (soloActivos)  filtros.push(where("estado", "==", "activo"));
  filtros.push(orderBy("categoria"), orderBy("nombre"));
  q = query(q, ...filtros);
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function obtenerProducto(codigo) {
  const snap = await getDoc(doc(db, "productos", codigo));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function actualizarProducto(codigo, cambios) {
  await updateDoc(doc(db, "productos", codigo), {
    ...cambios,
    actualizadoEn: serverTimestamp()
  });
}

// ---------- Helpers genéricos ----------
export { db, serverTimestamp, GeoPoint };
export { collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter };
export { addDoc, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction };
