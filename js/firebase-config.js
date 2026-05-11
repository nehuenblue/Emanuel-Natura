// =====================================================================
// Emanuel Cosméticos — Firebase Config
//
// COMPLETAR los valores marcados con TODO con los datos del NUEVO
// proyecto Firebase (emanuel-cosmeticos).
//
// Cómo obtenerlos:
//   1. Firebase Console → Project Settings → General → Your apps
//   2. Si todavía no creaste una app Web, hacé clic en "Add app" → "</>"
//   3. Copiá los valores de firebaseConfig
//
// IMPORTANTE:
//   - Estas keys son PÚBLICAS por diseño en Firebase Web. La seguridad
//     real está en firestore.rules y en la restricción de la API key
//     por dominio HTTP Referrer (Google Cloud Console → Credentials).
//   - Antes de subir a producción, restringir la API key a tu dominio.
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, serverTimestamp, GeoPoint }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// TODO: reemplazar con la config del NUEVO proyecto emanuel-cosmeticos
const firebaseConfig = {
  apiKey:            "AIza...REEMPLAZAR",
  authDomain:        "emanuel-cosmeticos.firebaseapp.com",
  projectId:         "emanuel-cosmeticos",
  storageBucket:     "emanuel-cosmeticos.firebasestorage.app",
  messagingSenderId: "REEMPLAZAR",
  appId:             "REEMPLAZAR"
};

export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
export { serverTimestamp, GeoPoint };

// Persistencia local: el usuario queda logueado entre recargas/cierres
// del navegador hasta que haga logout explícito.
setPersistence(auth, browserLocalPersistence).catch(err => {
  console.error("[firebase-config] No se pudo establecer persistencia:", err);
});

// Metadatos de la app (constantes globales)
export const APP_INFO = Object.freeze({
  nombre:     "Emanuel Cosméticos",
  cicloActual: "C07",
  moneda:     "ARS",
  simbolo:    "$",
  zonaHoraria: "America/Argentina/Buenos_Aires"
});
