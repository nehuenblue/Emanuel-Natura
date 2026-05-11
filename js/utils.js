// =====================================================================
// Emanuel Cosméticos — Utilidades transversales (utils.js)
// =====================================================================

import { APP_INFO } from "./firebase-config.js";

// ---------- Formato de moneda (ARS) ----------
export function formatoMoneda(n, opts = {}) {
  const { conSimbolo = true, decimales = 0 } = opts;
  if (n === null || n === undefined || isNaN(n)) return conSimbolo ? "$ —" : "—";
  const s = Number(n).toLocaleString('es-AR', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales
  });
  return conSimbolo ? `${APP_INFO.simbolo} ${s}` : s;
}

// ---------- Fechas ----------
export function formatoFecha(d, { conHora = false } = {}) {
  if (!d) return "—";
  // Soporta Date, Timestamp de Firestore, o string ISO
  let date = d;
  if (typeof d?.toDate === "function") date = d.toDate();
  else if (typeof d === "string")      date = new Date(d);
  if (!(date instanceof Date) || isNaN(date)) return "—";

  const opts = conHora
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' };
  return date.toLocaleString('es-AR', opts);
}

// ---------- Validaciones ----------
export function esTelefonoArgentino(tel) {
  if (!tel) return false;
  // Acepta: +54 9 299 555 1234, 02942-555-1234, 2995551234, etc.
  const limpio = String(tel).replace(/[\s\-\(\)\+]/g, "");
  return /^(54)?9?\d{8,11}$/.test(limpio);
}

export function normalizarTelefono(tel) {
  if (!tel) return "";
  let limpio = String(tel).replace(/[\s\-\(\)]/g, "");
  if (!limpio.startsWith("+")) {
    // Si arranca con 54, lo dejamos. Si no, asumimos AR
    if (limpio.startsWith("54")) limpio = "+" + limpio;
    else limpio = "+54" + limpio.replace(/^0/, "");
  }
  return limpio;
}

export function esMontoValido(m) {
  if (m === null || m === undefined || m === "") return false;
  const n = Number(m);
  return !isNaN(n) && isFinite(n) && n >= 0;
}

// ---------- DOM helpers ----------
export const $  = (sel, ctx = document) => ctx.querySelector(sel);
export const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

// ---------- Debounce simple para inputs ----------
export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Confirmación con look más prolijo que alert ----------
// (En F1 reemplazaremos por modal real; por ahora confirm nativo)
export function confirmar(mensaje) {
  return window.confirm(mensaje);
}

// ---------- IDs legibles para mostrar en UI ----------
export function abreviarId(id, len = 8) {
  if (!id) return "—";
  return String(id).substring(0, len).toUpperCase();
}
