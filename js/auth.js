// =====================================================================
// Emanuel Cosméticos — Módulo de Autenticación
//
// Funcionalidad:
//   - login(email, password)
//   - logout()
//   - resetPassword(email)
//   - onAuthChange(callback): suscripción a cambios
//   - requireAuth(): guard que se llama al inicio de páginas internas
//   - getUsuarioActual(): retorna info del usuario logueado + rol
// =====================================================================

import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- Mapeo de errores Firebase → mensajes claros en español ----------
const MENSAJES_ERROR = {
  "auth/invalid-email":             "El correo electrónico no es válido.",
  "auth/user-disabled":             "Esta cuenta está deshabilitada. Contactá al administrador.",
  "auth/user-not-found":            "No existe una cuenta con ese correo.",
  "auth/wrong-password":            "La contraseña es incorrecta.",
  "auth/invalid-credential":        "Las credenciales son incorrectas.",
  "auth/too-many-requests":         "Demasiados intentos fallidos. Esperá unos minutos.",
  "auth/network-request-failed":    "Sin conexión. Verificá tu acceso a internet.",
  "auth/missing-password":          "Ingresá la contraseña.",
  "auth/missing-email":             "Ingresá el correo electrónico.",
  "auth/weak-password":             "La contraseña es demasiado débil (mínimo 6 caracteres).",
};

export function describirError(err) {
  if (!err) return "Error desconocido.";
  if (typeof err === "string") return err;
  const code = err.code || "";
  return MENSAJES_ERROR[code] || (err.message || "Ocurrió un error inesperado.");
}

// ---------- Login ----------
/**
 * @param {string} email
 * @param {string} password
 * @param {boolean} recordar  Si true, persistencia local; si false, sesión.
 */
export async function login(email, password, recordar = true) {
  await setPersistence(auth, recordar ? browserLocalPersistence : browserSessionPersistence);
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user;
}

// ---------- Logout ----------
export async function logout() {
  await signOut(auth);
  // Limpiar cualquier estado local sensible si lo agregamos en el futuro
  sessionStorage.clear();
}

// ---------- Recuperación de contraseña ----------
export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email.trim());
}

// ---------- Suscripción a cambios ----------
export function onAuthChange(cb) {
  return onAuthStateChanged(auth, cb);
}

// ---------- Datos del usuario actual + rol ----------
/**
 * Retorna el documento /usuarios/{uid} del usuario logueado.
 * Si no existe, retorna { uid, email, rol: null }.
 */
export async function getUsuarioActual() {
  const u = auth.currentUser;
  if (!u) return null;
  const ref = doc(db, "usuarios", u.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    return { uid: u.uid, email: u.email, rol: null, nombre: null };
  }
  return { uid: u.uid, email: u.email, ...snap.data() };
}

// ---------- Guard para páginas internas ----------
/**
 * Llamar al INICIO de cada página interna (dashboard, clientes, etc).
 * Si no hay sesión activa, redirige a index.html.
 * Si requireAdmin=true, además verifica rol "admin".
 *
 * @param {Object} opts
 * @param {boolean} opts.requireAdmin
 * @returns {Promise<Object>} Usuario actual ya verificado.
 */
export function requireAuth({ requireAdmin = false } = {}) {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe();
      if (!user) {
        // Guardar a dónde quería ir para volver después del login
        sessionStorage.setItem("redirectTo", location.pathname + location.search);
        location.replace("index.html");
        return;
      }
      const info = await getUsuarioActual();
      if (requireAdmin && info?.rol !== "admin") {
        alert("No tenés permisos para acceder a esta sección.");
        await logout();
        location.replace("index.html");
        return;
      }
      resolve(info);
    });
  });
}

// ---------- Validador de email ----------
export function esEmailValido(email) {
  if (!email || typeof email !== "string") return false;
  // RFC 5322 simplificado, suficiente para validación de UI
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}
