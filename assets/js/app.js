/* Detección de riesgo de botaderos informales · Cajamarca  (v2)
   Todo corre en el navegador: mosaicos binarios + Random Forest en JSON + distancia a edificaciones. */
(() => {
  "use strict";

  // ---------------- Configuración (ajustable) ----------------
  const UMBRAL_ALTO = 0.50;   // = umbral por defecto de predict() con que se evaluó el modelo
  const UMBRAL_MEDIO = 0.30;
  const LST_IMPUTADA = 27.0;  // °C, solo si falta LST en el píxel
  const ZOOM_ANALISIS = 16;
  const MARGEN_VECINOS = 0.004;                         // ° (≈440 m): mosaicos vecinos a revisar
  const RADIOS = [[200, "#16c47a"], [100, "#f5a524"], [20, "#ff3b4a"]]; // anillos de exposición (m)
  const RUTA = { modelo: "data/model_rf.json", meta: "data/meta.json", tiles: "data/tiles/", edif: "data/edif/", oefa: "data/botaderos_oefa.geojson", agua: "data/agua/", vias: "data/vias/" };
  const RADIO_ENTORNO = 500;      // m: búsqueda de agua y vías
  const OEFA_COINCIDE_M = 100;    // m: se considera "el mismo" botadero registrado
  const RANGO_BARRA = { NDVI: [0, 1], NDBI: [-0.5, 0.5], SAVI: [0, 1], BSI: [-0.5, 0.5], LST: [10, 45] };
  const EJEMPLO = [-7.1517, -78.5128];

  // ---------------- Estado ----------------
  let modelo = null, meta = null, bbox = Geo.BBOX_DEFECTO;
  const cacheTiles = new Map(), cacheEdif = new Map();
  let marcador = null, celda = null, capaExpo = null, oefaLista = [];
  const cacheLineas = new Map();
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const $ = (id) => document.getElementById(id);
  const f2 = (n) => n.toFixed(2).replace("-", "−");

  // ---------------- GeoBot ----------------
  const bot = {
    abrir(titulo, html, acciones = [], aviso = false) {
      $("bot-titulo").textContent = titulo;
      $("bot-texto").innerHTML = html;
      $("bot-bubble").classList.toggle("aviso", aviso);
      const box = $("bot-acciones"); box.innerHTML = "";
      acciones.forEach((a) => {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = a.label; if (a.sec) b.className = "sec";
        b.addEventListener("click", () => { bot.cerrar(); a.fn && a.fn(); });
        box.appendChild(b);
      });
      $("bot-bubble").hidden = false;
    },
    cerrar() { $("bot-bubble").hidden = true; },
    rango() {
      return `Latitud: <b>${f2(bbox.latMax)}</b> a <b>${f2(bbox.latMin)}</b><br>Longitud: <b>${f2(bbox.lonMax)}</b> a <b>${f2(bbox.lonMin)}</b>`;
    },
    bienvenida() {
      bot.abrir("¡Hola! Soy GeoBot 🤖",
        `Esta herramienta <b>solo analiza el departamento de Cajamarca</b>. Usa coordenadas en grados decimales (WGS84) dentro de este rango:<br><br>${bot.rango()}<br><br>
         Como Perú está al sur y al oeste, <b>ambos valores llevan signo negativo</b>. Ejemplo: <code>${EJEMPLO[0]}, ${EJEMPLO[1]}</code>`,
        [{ label: "Usar ejemplo", fn: () => poner(EJEMPLO[0], EJEMPLO[1], true) }, { label: "Entendido", sec: true }]);
    },
  };
  $("bot-btn").addEventListener("click", () => ($("bot-bubble").hidden ? bot.bienvenida() : bot.cerrar()));
  $("bot-cerrar").addEventListener("click", bot.cerrar);

  function poner(lat, lon, analizarYa) {
    $("lat").value = lat; $("lon").value = lon;
    if (analizarYa) $("form").requestSubmit();
  }

  /** Muestra el mensaje adecuado del robot según el tipo de error de coordenadas. */
  function avisoCoordenadas(v, lat, lon) {
    const fix = v.fix;
    const corregir = fix ? [{ label: `Corregir y analizar (${fix[0]}, ${fix[1]})`, fn: () => poner(fix[0], fix[1], true) }, { label: "Cerrar", sec: true }] : [{ label: "Entendido", sec: true }];
    if (v.motivo === "formato")
      bot.abrir("Revisa los números 🧐", `No entendí esas coordenadas. Escribe solo números en formato decimal, por ejemplo <code>${EJEMPLO[0]}</code> y <code>${EJEMPLO[1]}</code> (no uses grados° ′ ″).`, corregir, true);
    else if (v.motivo === "signo")
      bot.abrir("¿Falta el signo negativo?", `En Cajamarca la latitud y la longitud son <b>negativas</b> (sur y oeste). ¿Quisiste decir <code>${fix[0]}, ${fix[1]}</code>?`, corregir, true);
    else if (v.motivo === "invertidas")
      bot.abrir("¿Latitud y longitud intercambiadas?", `Parece que pusiste la longitud en el campo de latitud. La <b>latitud</b> va primero (≈ −4.5 a −8.0). ¿Quisiste decir <code>${fix[0]}, ${fix[1]}</code>?`, corregir, true);
    else
      bot.abrir("Fuera de Cajamarca 📍", `Ese punto está fuera del rango del departamento de Cajamarca. Esta herramienta solo funciona aquí:<br><br>${bot.rango()}<br><br>Pruébalo con <code>${EJEMPLO[0]}, ${EJEMPLO[1]}</code> o haz clic sobre el mapa dentro de Cajamarca.`,
        [{ label: "Usar ejemplo", fn: () => poner(EJEMPLO[0], EJEMPLO[1], true) }, { label: "Cerrar", sec: true }], true);
  }

  // ---------------- Mapa ----------------
  const mapa = L.map("mapa", { zoomControl: true, minZoom: 6 }).setView([-6.5, -78.6], 8);
  const satelite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18, attribution: "Imágenes © Esri, Maxar, Earthstar Geographics" }).addTo(mapa);
  const etiquetas = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18, opacity: 0.9 });
  const ctrlCapas = L.control.layers({ "Satélite": satelite }, { "Nombres de lugares": etiquetas }, { collapsed: true }).addTo(mapa);
  L.control.scale({ imperial: false }).addTo(mapa);

  // ---------------- Carga inicial ----------------
  const listo = Promise.all([
    fetch(RUTA.modelo).then((r) => r.json()),
    fetch(RUTA.meta).then((r) => r.json()),
  ]).then(([m, mt]) => {
    modelo = m; meta = mt;
    if (mt.bbox) { const [w, s, e, n] = mt.bbox; bbox = { latMin: s, latMax: n, lonMin: w, lonMax: e }; }
    if (mt.edif && mt.edif.ok) $("card-expo").hidden = false;
    const hayAgua = !!(mt.agua && mt.agua.ok), hayVias = !!(mt.vias && mt.vias.ok);
    $("ent-agua").hidden = !hayAgua; $("ent-vias").hidden = !hayVias;
    $("card-entorno").hidden = !(hayAgua || hayVias);
    cargarOefa();
  }).catch(() => mostrarError("No se pudo cargar el modelo o los datos. Revisa la carpeta data/."));

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
  const traer = (cache, url, tipo) => {
    if (cache.has(url)) return cache.get(url);
    const p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new tipo(b) : null)).catch(() => null);
    cache.set(url, p);
    return p;
  };

  async function leerPixel(lat, lon) {
    const T = meta.tile, paso = meta.res * T;
    const dx = lon - meta.lon0, dy = meta.lat0 - lat;
    if (dx < 0 || dy < 0) return null;
    const col = Math.floor(dx / paso), fila = Math.floor(dy / paso);
    if (col >= meta.ncols || fila >= meta.nrows) return null;
    const tile = await traer(cacheTiles, `${RUTA.tiles}${fila}_${col}.bin`, Uint8Array);
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
    const w = meta.lon0 + col * paso + px * meta.res, n = meta.lat0 - fila * paso - py * meta.res;
    out._bounds = [[n - meta.res, w], [n, w + meta.res]];
    return out;
  }

  /** Distancia a la edificación más cercana (revisa el mosaico del punto y los vecinos si está cerca del borde). */
  async function leerExposicion(lat, lon) {
    const T = meta.tile, paso = meta.res * T, M = MARGEN_VECINOS;
    const dx = lon - meta.lon0, dy = meta.lat0 - lat;
    const pedidos = [];
    for (let f = Math.floor((dy - M) / paso); f <= Math.floor((dy + M) / paso); f++)
      for (let c = Math.floor((dx - M) / paso); c <= Math.floor((dx + M) / paso); c++) {
        if (f < 0 || c < 0 || f >= meta.nrows || c >= meta.ncols) continue;
        pedidos.push(traer(cacheEdif, `${RUTA.edif}${f}_${c}.bin`, Uint16Array)
          .then((arr) => arr && { arr, x0: meta.lon0 + c * paso, y0: meta.lat0 - f * paso, paso }));
      }
    const tiles = (await Promise.all(pedidos)).filter(Boolean);
    return tiles.length ? Geo.distanciaMasCercana(lat, lon, tiles) : { dist: Infinity, punto: null };
  }

  // ---------------- Interfaz ----------------
  function setVeredicto(clase, icono, titulo, texto, prob) {
    $("veredicto").className = "veredicto " + clase;
    $("veredicto").querySelector(".icono").textContent = icono;
    $("veredicto").querySelector(".v-titulo").textContent = titulo;
    $("veredicto").querySelector(".v-texto").textContent = texto;
    $("v-prob").innerHTML = prob || "";
  }
  function resetExpo() {
    $("expo").className = "expo neutro"; $("expo-dist").textContent = "—";
    $("expo-nivel").textContent = "Esperando análisis"; $("expo-det").textContent = "Distancia a la edificación más cercana.";
    $("prioridad").hidden = true;
  }
  function mostrarError(msg) { setVeredicto("error", "!", "SIN RESULTADO", msg, ""); resetBarras(); resetExpo(); resetEntorno(); $("oefa-cerca").hidden = true; }
  function resetBarras() {
    document.querySelectorAll(".ind").forEach((e) => {
      e.querySelector(".val").textContent = "—"; e.querySelector(".barra i").style.width = "0"; e.querySelector(".ind-txt").textContent = "—";
    });
    $("nota-datos").textContent = "";
  }
  function pintarBarras(v) {
    document.querySelectorAll(".ind").forEach((e) => {
      const k = e.dataset.k, val = v[k];
      const [lo, hi] = RANGO_BARRA[k];
      e.querySelector(".val").textContent = k === "LST" ? val.toFixed(1) + " °C" : val.toFixed(3);
      e.querySelector(".ind-txt").textContent = Geo.interpretar(k, val);
      e.querySelector(".barra i").style.width = Math.max(3, Math.min(100, ((val - lo) / (hi - lo)) * 100)) + "%";
    });
  }
  const COLOR = { alto: "#ff3b4a", medio: "#f5a524", bajo: "#16c47a" };

  function dibujar(lat, lon, bounds, clase, expo, ent) {
    [marcador, celda, capaExpo].forEach((l) => l && mapa.removeLayer(l));
    const icono = L.divIcon({ className: "", html: `<div class="pin" style="background:${COLOR[clase]}"></div>`, iconSize: [0, 0] });
    marcador = L.marker([lat, lon], { icon: icono }).addTo(mapa);
    celda = L.rectangle(bounds, { color: COLOR[clase], weight: 2, fillColor: COLOR[clase], fillOpacity: 0.15 }).addTo(mapa);
    capaExpo = L.layerGroup().addTo(mapa);
    dibujarEntorno(lat, lon, ent);
    if (expo) {
      RADIOS.forEach(([r, c]) => L.circle([lat, lon], { radius: r, color: c, weight: 1.5, dashArray: "5 5", fill: false, interactive: false }).addTo(capaExpo));
      if (expo.punto && expo.dist <= 400) {
        L.polyline([[lat, lon], expo.punto], { color: "#fff", weight: 1.5, dashArray: "2 4", interactive: false }).addTo(capaExpo);
        L.circleMarker(expo.punto, { radius: 5, color: "#fff", weight: 2, fillColor: "#22d3ee", fillOpacity: 1 }).addTo(capaExpo)
          .bindTooltip("Edificación más cercana", { direction: "top" });
      }
    }
  }

  // ---- Botaderos registrados por OEFA ----
  function cargarOefa() {
    fetch(RUTA.oefa).then((r) => (r.ok ? r.json() : null)).then((gj) => {
      if (!gj || !gj.features) return;
      oefaLista = gj.features.map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], props: f.properties || {} }));
      const capa = L.geoJSON(gj, {
        pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 5.5, color: "#fff", weight: 1.5, fillColor: "#d946ef", fillOpacity: 0.95, bubblingMouseEvents: false }),
        onEachFeature: (f, l) => {
          const p = f.properties || {};
          l.bindPopup(`<b>Botadero registrado (OEFA)</b><br>Código: ${esc(p.cod || "s/c")}` +
            (p.dist ? `<br>Distrito: ${esc(p.dist)}` : "") + (p.prov ? `<br>Provincia: ${esc(p.prov)}` : "") +
            (p.area_ha != null ? `<br>Área: ${esc(p.area_ha)} ha` : ""));
        },
      }).addTo(mapa);
      ctrlCapas.addOverlay(capa, "Botaderos registrados (OEFA)");
    }).catch(() => {});
  }
  function avisoOefa(lat, lon) {
    const box = $("oefa-cerca");
    if (!oefaLista.length) { box.hidden = true; return; }
    const { dist, item } = Geo.masCercano(lat, lon, oefaLista);
    const nom = esc(item.props.cod || "s/c") + (item.props.dist ? ` (${esc(item.props.dist)})` : "");
    box.hidden = false;
    box.innerHTML = dist <= OEFA_COINCIDE_M
      ? `📌 Coincide con un botadero <b>registrado por OEFA</b>: ${nom}, a ${Math.round(dist)} m. Estos puntos se usaron para entrenar el modelo, así que aquí el resultado no es una validación independiente.`
      : `📌 Botadero OEFA más cercano: <b>${nom}</b>, a ${dist >= 1000 ? (dist / 1000).toFixed(1) + " km" : Math.round(dist) + " m"}.`;
  }

  // ---- Entorno: agua y vías (informativo) ----
  async function leerLineas(tipo, lat, lon) {
    const paso = meta.res * meta.tile, dx = lon - meta.lon0, dy = meta.lat0 - lat;
    const col = Math.floor(dx / paso), fila = Math.floor(dy / paso);
    if (col < 0 || fila < 0 || col >= meta.ncols || fila >= meta.nrows) return { dist: Infinity, punto: null };
    const arr = await traer(cacheLineas, `${RUTA[tipo]}${fila}_${col}.bin`, Uint16Array);
    if (!arr) return { dist: Infinity, punto: null };
    return Geo.distanciaSegmentos(lat, lon, { arr, x0: meta.lon0 + col * paso, y0: meta.lat0 - fila * paso, paso });
  }
  function resetEntorno() {
    ["agua", "vias"].forEach((k) => { const e = $("ent-" + k + "-v"); e.textContent = "—"; e.className = "ent-v"; });
  }
  function pintarEntorno(ent) {
    [["agua", "No se detecta recurso hídrico a ≤ 500 m", (d) => `Hay un recurso hídrico a ${Math.round(d)} m`],
     ["vias", "No se detecta vía a ≤ 500 m", (d) => `Hay una vía a ${Math.round(d)} m`]].forEach(([k, no, si]) => {
      const r = ent[k], e = $("ent-" + k + "-v");
      if (!r) return;
      const cerca = r.dist <= RADIO_ENTORNO;
      e.textContent = cerca ? si(r.dist) : no; e.className = "ent-v " + (cerca ? "si" : "no");
    });
  }
  function dibujarEntorno(lat, lon, ent) {
    if (!ent) return;
    [["agua", "#38bdf8", "Recurso hídrico más cercano"], ["vias", "#e5e7eb", "Vía más cercana"]].forEach(([k, color, tip]) => {
      const r = ent[k];
      if (!r || !r.punto || r.dist > RADIO_ENTORNO) return;
      L.polyline([[lat, lon], r.punto], { color, weight: 2, dashArray: "6 4", interactive: false }).addTo(capaExpo);
      L.circleMarker(r.punto, { radius: 5, color: "#0b1b33", weight: 1.5, fillColor: color, fillOpacity: 1 }).addTo(capaExpo).bindTooltip(tip, { direction: "top" });
    });
  }

  // ---- Guía de índices ----
  function pintarGuia() {
    $("guia").innerHTML = Geo.GUIA.map((g) => `<div class="guia-item"><h3>${g.nombre} <small>· ${g.rango}</small></h3><p>${g.desc}</p>
      <table>${g.rangos.map((r) => `<tr><td>${r.lim}</td><td>${r.txt}</td></tr>`).join("")}</table>${g.nota ? `<p class="gnota">${g.nota}</p>` : ""}</div>`).join("") +
      `<p class="guia-fuente">Rangos genéricos de EOS Data Analytics, Cropler y Farmonaut, pensados sobre todo para cultivos; en los Andes los valores pueden variar. Son una guía de lectura, no un diagnóstico.</p>`;
  }

  function pintarExposicion(expo, pNivel) {
    const u = Geo.nivelExposicion(expo.dist);
    $("expo").className = "expo " + u.clase;
    if (!isFinite(expo.dist)) {
      $("expo-dist").textContent = "> 14 km"; $("expo-nivel").textContent = u.etiqueta;
      $("expo-det").textContent = "No hay edificaciones detectadas en el área cercana.";
    } else {
      $("expo-dist").textContent = (expo.dist >= 1000 ? (expo.dist / 1000).toFixed(2) + " km" : Math.round(expo.dist) + " m");
      $("expo-nivel").textContent = u.nivel ? "EXPOSICIÓN " + u.etiqueta : u.etiqueta;
      $("expo-det").textContent = u.nivel
        ? "Edificación detectada a esa distancia (≈ ± 10 m)."
        : "Ninguna edificación a ≤ 200 m. Esto no garantiza cumplir la distancia de 1 km que piden las guías del MINAM para infraestructura formal.";
    }
    const pr = Geo.prioridad(pNivel, u.nivel);
    $("prioridad").hidden = false; $("prioridad").className = "prioridad " + pr.clase; $("prio-txt").textContent = pr.txt;
  }

  async function analizar(lat, lon) {
    $("btn").disabled = true; $("btn").textContent = "Analizando…";
    setVeredicto("neutro", "…", "ANALIZANDO", "Leyendo índices espectrales de la zona", "");
    resetExpo(); resetEntorno(); $("oefa-cerca").hidden = true;
    try {
      await listo;
      if (!modelo) return;
      mapa.flyTo([lat, lon], ZOOM_ANALISIS, { duration: 1.6 });
      const v = await leerPixel(lat, lon);
      if (!v) {
        mostrarError("El punto está dentro del rectángulo de Cajamarca pero fuera de sus límites, o sin cobertura de datos.");
        bot.abrir("No tengo datos ahí 🤔", `Ese punto no tiene datos. Puede estar en un departamento vecino (Amazonas, Lambayeque, La Libertad, Piura) o en el límite del área. Intenta con un punto más al interior de Cajamarca.`, [{ label: "Usar ejemplo", fn: () => poner(EJEMPLO[0], EJEMPLO[1], true) }, { label: "Cerrar", sec: true }], true);
        return;
      }
      if (["NDVI", "NDBI", "BSI", "SAVI"].some((k) => v[k] === null)) {
        mostrarError("Este píxel no tiene dato válido (probable nubosidad persistente). Prueba con un punto cercano.");
        return;
      }
      const lstImputada = v.LST === null;
      if (lstImputada) v.LST = LST_IMPUTADA;
      const p = predecir([v.NDVI, v.NDBI, v.BSI, v.SAVI, v.LST]);
      const prob = `Probabilidad estimada: <b>${Math.round(p * 100)}%</b>`;

      let clase, pNivel;
      if (p >= UMBRAL_ALTO) { clase = "alto"; pNivel = 2; setVeredicto("alto", "!", "ALTO RIESGO:", "Probable botadero informal detectado", prob); }
      else if (p >= UMBRAL_MEDIO) { clase = "medio"; pNivel = 1; setVeredicto("medio", "!", "RIESGO MODERADO:", "Zona con señales parciales; conviene verificar", prob); }
      else { clase = "bajo"; pNivel = 0; setVeredicto("bajo", "✓", "BAJO RIESGO:", "Área sin señales de botadero", prob); }

      pintarBarras(v);
      $("nota-datos").textContent = lstImputada ? "Sin dato de temperatura en este píxel: se usó un valor típico (27 °C) y el resultado es menos fiable." : "";

      let expo = null;
      if (meta.edif && meta.edif.ok) { expo = await leerExposicion(lat, lon); pintarExposicion(expo, pNivel); }
      const ent = {};
      if (meta.agua && meta.agua.ok) ent.agua = await leerLineas("agua", lat, lon);
      if (meta.vias && meta.vias.ok) ent.vias = await leerLineas("vias", lat, lon);
      pintarEntorno(ent);
      avisoOefa(lat, lon);
      dibujar(lat, lon, v._bounds, clase, expo, ent);
      history.replaceState(null, "", `?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
    } finally {
      $("btn").disabled = false; $("btn").textContent = "🔍 Analizar Zona";
    }
  }

  // ---------------- Eventos ----------------
  const num = (s) => parseFloat(String(s).replace(",", ".").trim());
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await listo;
    const lat = num($("lat").value), lon = num($("lon").value);
    const v = Geo.validar(lat, lon, bbox);
    if (!v.ok) { mostrarError("Coordenadas fuera del área de estudio (departamento de Cajamarca)."); avisoCoordenadas(v, lat, lon); return; }
    bot.cerrar();
    analizar(lat, lon);
  });
  mapa.on("click", async (e) => {
    await listo;
    const { lat, lng } = e.latlng;
    if (!Geo.enBBox(lat, lng, bbox)) { avisoCoordenadas({ ok: false, motivo: "fuera", fix: null }, lat, lng); return; }
    $("lat").value = lat.toFixed(5); $("lon").value = lng.toFixed(5);
    analizar(lat, lng);
  });

  // ---------------- Arranque ----------------
  pintarGuia();
  const q = new URLSearchParams(location.search);
  if (q.has("lat") && q.has("lon")) {
    $("lat").value = q.get("lat"); $("lon").value = q.get("lon");
    $("form").requestSubmit();
  } else {
    listo.then(() => setTimeout(bot.bienvenida, 600));
  }
})();
