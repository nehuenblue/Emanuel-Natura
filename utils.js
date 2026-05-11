// =====================================================================
// Emanuel Cosméticos · Utilidades transversales (utils.js)
// =====================================================================

import { APP_INFO } from "./firebase-config.js";

// ---------- Formato de moneda (ARS) ----------
export function formatoMoneda(n, opts = {}) {
  const { conSimbolo = true, decimales = 0, compacto = false } = opts;
  if (n === null || n === undefined || isNaN(n)) return conSimbolo ? "$ —" : "—";

  if (compacto && Math.abs(n) >= 1000) {
    if (Math.abs(n) >= 1_000_000) {
      const v = (n / 1_000_000).toFixed(1).replace('.', ',');
      return (conSimbolo ? '$ ' : '') + v + 'M';
    }
    const v = Math.round(n / 1000);
    return (conSimbolo ? '$ ' : '') + v + 'K';
  }

  const s = Number(n).toLocaleString('es-AR', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales
  });
  return conSimbolo ? `${APP_INFO.simbolo} ${s}` : s;
}

// Útil cuando queremos estilar símbolo y valor por separado en el KPI
export function formatoMonedaPartes(n) {
  if (n === null || n === undefined || isNaN(n)) return { simbolo: '$', valor: '—' };
  return {
    simbolo: APP_INFO.simbolo,
    valor: Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 })
  };
}

// ---------- Fechas ----------
export function aDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  if (typeof d?.toDate === "function") return d.toDate();
  if (typeof d === "string") return new Date(d);
  if (typeof d === "number") return new Date(d);
  return null;
}

export function formatoFecha(d, { conHora = false, corta = false } = {}) {
  const date = aDate(d);
  if (!date || isNaN(date)) return "—";
  if (corta) {
    return date.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
  }
  const opts = conHora
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' };
  return date.toLocaleString('es-AR', opts);
}

export function fechaRelativa(d) {
  const date = aDate(d);
  if (!date) return "—";
  const ahora = new Date();
  const diff = ahora - date;
  const dias = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (dias === 0) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 7)   return `hace ${dias} días`;
  if (dias < 30)  return `hace ${Math.floor(dias / 7)} sem.`;
  if (dias < 365) return `hace ${Math.floor(dias / 30)} meses`;
  return `hace ${Math.floor(dias / 365)} años`;
}

// ---------- Rangos predefinidos ----------
export const RANGOS = {
  hoy() {
    const d = new Date(); d.setHours(0,0,0,0);
    const f = new Date(); f.setHours(23,59,59,999);
    return { desde: d, hasta: f, etiqueta: "Hoy" };
  },
  ayer() {
    const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(0,0,0,0);
    const f = new Date(d); f.setHours(23,59,59,999);
    return { desde: d, hasta: f, etiqueta: "Ayer" };
  },
  estaSemana() {
    const d = new Date();
    const dia = d.getDay() || 7;
    d.setDate(d.getDate() - dia + 1);
    d.setHours(0,0,0,0);
    const f = new Date(); f.setHours(23,59,59,999);
    return { desde: d, hasta: f, etiqueta: "Esta semana" };
  },
  ultimos7Dias() {
    const d = new Date(); d.setDate(d.getDate() - 6); d.setHours(0,0,0,0);
    const f = new Date(); f.setHours(23,59,59,999);
    return { desde: d, hasta: f, etiqueta: "Últimos 7 días" };
  },
  esteMes() {
    const ahora = new Date();
    const d = new Date(ahora.getFullYear(), ahora.getMonth(), 1, 0, 0, 0, 0);
    const f = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0, 23, 59, 59, 999);
    return { desde: d, hasta: f, etiqueta: "Este mes" };
  },
  mesAnterior() {
    const ahora = new Date();
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1, 0, 0, 0, 0);
    const f = new Date(ahora.getFullYear(), ahora.getMonth(), 0, 23, 59, 59, 999);
    return { desde: d, hasta: f, etiqueta: "Mes anterior" };
  },
  ultimos30Dias() {
    const d = new Date(); d.setDate(d.getDate() - 29); d.setHours(0,0,0,0);
    const f = new Date(); f.setHours(23,59,59,999);
    return { desde: d, hasta: f, etiqueta: "Últimos 30 días" };
  },
  esteAnio() {
    const ahora = new Date();
    const d = new Date(ahora.getFullYear(), 0, 1, 0, 0, 0, 0);
    const f = new Date(ahora.getFullYear(), 11, 31, 23, 59, 59, 999);
    return { desde: d, hasta: f, etiqueta: "Este año" };
  },
  personalizado(desde, hasta) {
    const d = aDate(desde); d.setHours(0,0,0,0);
    const f = aDate(hasta); f.setHours(23,59,59,999);
    return { desde: d, hasta: f, etiqueta: "Personalizado" };
  }
};

export function agruparPorDia(docs, campoFecha = "fechaVenta") {
  const grupos = {};
  for (const d of docs) {
    const fecha = aDate(d[campoFecha]);
    if (!fecha) continue;
    const clave = fecha.toISOString().substring(0, 10);
    if (!grupos[clave]) grupos[clave] = [];
    grupos[clave].push(d);
  }
  return grupos;
}

export function ultimosDias(n) {
  const arr = [];
  const ahora = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(ahora);
    d.setDate(d.getDate() - i);
    arr.push({
      iso: d.toISOString().substring(0, 10),
      etiqueta: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })
    });
  }
  return arr;
}

// ---------- Validaciones ----------
export function esTelefonoArgentino(tel) {
  if (!tel) return false;
  const limpio = String(tel).replace(/[\s\-\(\)\+]/g, "");
  return /^(54)?9?\d{8,11}$/.test(limpio);
}

export function normalizarTelefono(tel) {
  if (!tel) return "";
  let limpio = String(tel).replace(/[\s\-\(\)]/g, "");
  if (!limpio.startsWith("+")) {
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

// ---------- DOM ----------
export const $  = (sel, ctx = document) => ctx.querySelector(sel);
export const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

export function crearElemento(tag, props = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const k in props) {
    if (k === "class") el.className = props[k];
    else if (k === "html") el.innerHTML = props[k];
    else if (k.startsWith("on")) el.addEventListener(k.substring(2), props[k]);
    else el.setAttribute(k, props[k]);
  }
  for (const h of hijos.flat()) {
    if (h == null) continue;
    el.appendChild(typeof h === "string" ? document.createTextNode(h) : h);
  }
  return el;
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function confirmar(mensaje) {
  return window.confirm(mensaje);
}

// ---------- Toast ----------
let toastTimer = null;
export function toast(mensaje, tipo = "info") {
  let $t = document.getElementById("__toast");
  if (!$t) {
    $t = document.createElement("div");
    $t.id = "__toast";
    $t.style.cssText = `
      position: fixed; bottom: 24px; left: 50%;
      transform: translateX(-50%) translateY(10px);
      padding: 12px 20px; border-radius: 12px; font-size: 14px;
      box-shadow: 0 20px 60px -20px rgba(58,42,37,.25);
      z-index: 110; opacity: 0;
      transition: opacity .2s, transform .2s;
      max-width: 90vw; text-align: center;
      border: 1px solid transparent;
    `;
    document.body.appendChild($t);
  }
  const colores = {
    info:  ["#e0eaef", "#4a6c7a", "rgba(74,108,122,.2)"],
    ok:    ["#e6efe4", "#5e7c5b", "rgba(94,124,91,.2)"],
    warn:  ["#faefd9", "#b88a3a", "rgba(184,138,58,.25)"],
    error: ["#f9e7e5", "#b8413a", "rgba(184,65,58,.2)"],
  };
  const [bg, fg, borde] = colores[tipo] || colores.info;
  $t.style.background = bg;
  $t.style.color = fg;
  $t.style.borderColor = borde;
  $t.textContent = mensaje;
  requestAnimationFrame(() => {
    $t.style.opacity = "1";
    $t.style.transform = "translateX(-50%) translateY(0)";
  });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $t.style.opacity = "0";
    $t.style.transform = "translateX(-50%) translateY(10px)";
  }, 3000);
}

// ---------- Misc ----------
export function abreviarId(id, len = 8) {
  if (!id) return "—";
  return String(id).substring(0, len).toUpperCase();
}

export function porcentaje(parte, total, decimales = 0) {
  if (!total || isNaN(total)) return 0;
  return Number(((parte / total) * 100).toFixed(decimales));
}

export function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
