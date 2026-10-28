/* Detección de riesgo de botaderos informales · Cajamarca
   Todo corre en el navegador: mosaicos binarios + Random Forest exportado a JSON. */
(() => {
  "use strict";

  // ---------------- Configuración (ajustable) ----------------
  const UMBRAL_ALTO = 0.50;   // = umbral por defecto de predict() con que se evaluó el modelo
  const UMBRAL_MEDIO = 0.30;  // por debajo de esto: riesgo bajo
  const LST_IMPUTADA = 27.0;  // °C, mediana aprox. del entrenamiento; solo si falta LST en el píxel
  const ZOOM_ANALISIS = 16;
  const RUTA = { modelo: "data/model_rf.json", meta: "data/meta.json", tiles: "data/tiles/" };

  // Rango visual de cada barra
  const RANGO_BARRA = { NDVI: [0, 1], NDBI: [-0.5, 0.5], SAVI: [0, 1], BSI: [-0.5, 0.5], LST: [10, 45] };

  // ---------------- Estado ----------------
  let modelo = null, meta = null;
  const cacheTiles = new Map();
  let marcador = null, celda = null;

  const $ = (id) => document.getElementById(id);

  // ---------------- Mapa ----------------
  const mapa = L.map("mapa", { zoomControl: true, minZoom: 6 }).setView([-6.5, -78.6], 8);
  const satelite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18, attribution: "Imágenes © Esri, Maxar, Earthstar Geographics" }).addTo(mapa);
  const etiquetas = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18, opacity: 0.9 });
  L.control.layers({ "Satélite": satelite }, { "Nombres de lugares": etiquetas }, { collapsed: true }).addTo(mapa);
  L.control.scale({ imperial: false }).addTo(mapa);

  // ---------------- Carga inicial (en paralelo) ----------------
  const listo = Promise.all([
    fetch(RUTA.modelo).then((r) => r.json()),
    fetch(RUTA.meta).then((r) => r.json()),
  ]).then(([m, mt]) => { modelo = m; meta = mt; })
    .catch(() => mostrarError("No se pudo cargar el modelo o los datos. Revisa la carpeta data/."));

  // ---------------- Random Forest en JS ----------------
  function predecir(x) {
    let s = 0;
    for (const a of modelo.trees) {
      let n = 0;
      while (a.f[n] !== -1) n = x[a.f[n]] <= a.t[n] ? a.l[n] : a.r[n];
      s += a.p[n];
    }
    return s / modelo.n_trees;
  }

  // ---------------- Lectura de mosaicos ----------------
  async function cargarTile(fila, col) {
    const k = fila + "_" + col;
    if (cacheTiles.has(k)) return cacheTiles.get(k);
    const p = fetch(RUTA.tiles + k + ".bin").then((r) => {
      if (!r.ok) return null;
      return r.arrayBuffer().then((b) => new Uint8Array(b));
    }).catch(() => null);
    cacheTiles.set(k, p);
    return p;
  }

  async function leerPixel(lat, lon) {
    const T = meta.tile, paso = meta.res * T;
    const dx = lon - meta.lon0, dy = meta.lat0 - lat;
    if (dx < 0 || dy < 0) return null;
    const col = Math.floor(dx / paso), fila = Math.floor(dy / paso);
    if (col >= meta.ncols || fila >= meta.nrows) return null;
    const tile = await cargarTile(fila, col);
    if (!tile) return null;
    const px = Math.min(T - 1, Math.floor((dx - col * paso) / meta.res));
    const py = Math.min(T - 1, Math.floor((dy - fila * paso) / meta.res));
    const out = {};
    meta.bandas.forEach((b, i) => {
      const q = tile[i * T * T + py * T + px];
      if (q === meta.nodata) { out[b] = null; return; }
      const [lo, hi] = meta.rangos[b];
      out[b] = lo + (q / 254) * (hi - lo);
    });
    // límites geográficos del píxel (para dibujarlo)
    const w = meta.lon0 + col * paso + px * meta.res, n = meta.lat0 - fila * paso - py * meta.res;
    out._bounds = [[n - meta.res, w], [n, w + meta.res]];
    return out;
  }

  // ---------------- Interfaz ----------------
  function setVeredicto(clase, icono, titulo, texto, prob) {
    $("veredicto").className = "veredicto " + clase;
    $("veredicto").querySelector(".icono").textContent = icono;
    $("veredicto").querySelector(".v-titulo").textContent = titulo;
    $("veredicto").querySelector(".v-texto").textContent = texto;
    $("v-prob").innerHTML = prob || "";
  }
  function mostrarError(msg) { setVeredicto("error", "!", "SIN RESULTADO", msg, ""); resetBarras(); }
  function resetBarras() {
    document.querySelectorAll(".ind").forEach((e) => {
      e.querySelector(".val").textContent = "—"; e.querySelector(".barra i").style.width = "0";
    });
    $("nota-datos").textContent = "";
  }
  function pintarBarras(v) {
    document.querySelectorAll(".ind").forEach((e) => {
      const k = e.dataset.k, val = v[k];
      const [lo, hi] = RANGO_BARRA[k];
      const pct = Math.max(3, Math.min(100, ((val - lo) / (hi - lo)) * 100));
      e.querySelector(".val").textContent = k === "LST" ? val.toFixed(1) + " °C" : val.toFixed(3);
      e.querySelector(".barra i").style.width = pct + "%";
    });
  }
  const COLOR = { alto: "#ff3b4a", medio: "#f5a524", bajo: "#16c47a" };

  function dibujar(lat, lon, bounds, clase) {
    if (marcador) mapa.removeLayer(marcador);
    if (celda) mapa.removeLayer(celda);
    const icono = L.divIcon({ className: "", html: `<div class="pin" style="background:${COLOR[clase]}"></div>`, iconSize: [0, 0] });
    marcador = L.marker([lat, lon], { icon: icono }).addTo(mapa);
    celda = L.rectangle(bounds, { color: COLOR[clase], weight: 2, fillColor: COLOR[clase], fillOpacity: 0.18 }).addTo(mapa);
  }

  async function analizar(lat, lon) {
    $("btn").disabled = true; $("btn").textContent = "Analizando…";
    setVeredicto("neutro", "…", "ANALIZANDO", "Leyendo índices espectrales de la zona", "");
    try {
      await listo;
      if (!modelo) return;
      mapa.flyTo([lat, lon], ZOOM_ANALISIS, { duration: 1.6 });
      const v = await leerPixel(lat, lon);
      if (!v) return mostrarError("La coordenada está fuera del área de estudio (departamento de Cajamarca) o no tiene cobertura.");
      const faltan = ["NDVI", "NDBI", "BSI", "SAVI"].filter((k) => v[k] === null);
      if (faltan.length) return mostrarError("Este píxel no tiene dato válido (probable nubosidad persistente). Prueba con un punto cercano.");

      const lstImputada = v.LST === null;
      if (lstImputada) v.LST = LST_IMPUTADA;
      const p = predecir([v.NDVI, v.NDBI, v.BSI, v.SAVI, v.LST]);   // orden = FEATURES del entrenamiento
      const pct = Math.round(p * 100);
      const prob = `Probabilidad estimada: <b>${pct}%</b>`;

      let clase;
      if (p >= UMBRAL_ALTO) { clase = "alto"; setVeredicto("alto", "!", "ALTO RIESGO:", "Probable botadero informal detectado", prob); }
      else if (p >= UMBRAL_MEDIO) { clase = "medio"; setVeredicto("medio", "!", "RIESGO MODERADO:", "Zona con señales parciales; conviene verificar", prob); }
      else { clase = "bajo"; setVeredicto("bajo", "✓", "BAJO RIESGO:", "Área sin señales de botadero", prob); }

      pintarBarras(v);
      $("nota-datos").textContent = lstImputada
        ? "Sin dato de temperatura en este píxel: se usó un valor típico (27 °C) y el resultado es menos fiable." : "";
      dibujar(lat, lon, v._bounds, clase);
      history.replaceState(null, "", `?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
    } finally {
      $("btn").disabled = false; $("btn").textContent = "🔍 Analizar Zona";
    }
  }

  // ---------------- Eventos ----------------
  const num = (s) => parseFloat(String(s).replace(",", ".").trim());
  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const lat = num($("lat").value), lon = num($("lon").value);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return mostrarError("Coordenadas no válidas. Ejemplo: Latitud -7.1517, Longitud -78.5128.");
    analizar(lat, lon);
  });
  mapa.on("click", (e) => {
    $("lat").value = e.latlng.lat.toFixed(5); $("lon").value = e.latlng.lng.toFixed(5);
    analizar(e.latlng.lat, e.latlng.lng);
  });

  // Enlace compartible: ?lat=-7.15&lon=-78.51
  const q = new URLSearchParams(location.search);
  if (q.has("lat") && q.has("lon")) {
    $("lat").value = q.get("lat"); $("lon").value = q.get("lon");
    $("form").requestSubmit();
  }
})();
