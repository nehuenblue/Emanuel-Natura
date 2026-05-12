// =====================================================================
// Emanuel Cosméticos · Zonas / Localidades (js/zonas.js)
// ---------------------------------------------------------------------
// Lista central de localidades para los botones de acceso rápido en
// los mapas (alta de cliente y mapa general).
//
// Para agregar / quitar / mover una localidad, editá SOLO este archivo
// y se actualiza en todos lados.
//
// Cada zona tiene:
//   - id          identificador interno (sin espacios, sin acentos)
//   - nombre      lo que se muestra en el botón
//   - lat, lng    coordenadas del centro
//   - zoom        nivel de zoom de Leaflet (12 lejos, 17 muy cerca)
// =====================================================================

export const ZONAS = [
  {
    id: "villa-pehuenia",
    nombre: "Villa Pehuenia",
    lat:    -38.879801,
    lng:    -71.185758,
    zoom:   15
  },
  {
    id: "moquehue",
    nombre: "Moquehue",
    lat:    -38.948764,
    lng:    -71.329742,
    zoom:   15
  },
  {
    id: "lonco-luan",
    nombre: "Lonco Luan",
    lat:    -39.046000,
    lng:    -71.080500,
    zoom:   14
  },
  {
    id: "alumine",
    nombre: "Aluminé",
    lat:    -39.231560,
    lng:    -70.914290,
    zoom:   14
  },
  {
    id: "zapala",
    nombre: "Zapala",
    lat:    -38.898000,
    lng:    -70.061600,
    zoom:   13
  }
];

// Centro y zoom default cuando el mapa abre sin ubicación previa.
// Lo centramos en Villa Pehuenia porque es donde más vendés.
export const CENTRO_DEFAULT = {
  lat:  -38.879801,
  lng:  -71.185758,
  zoom: 12      // un zoom más alejado para ver toda la región
};

// Helper: encuentra una zona por su ID
export function zonaPorId(id) {
  return ZONAS.find(z => z.id === id) || null;
}
