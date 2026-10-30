/* Funciones puras (sin DOM) para validar coordenadas y calcular exposición a viviendas.
   Se usan en el navegador (window.Geo) y se pueden probar con Node (require). */
(function (root) {
  "use strict";
  const Geo = {};

  // Rango aproximado del departamento (fuentes: SINIA/Gobierno Regional y literatura geográfica).
  // La web lo reemplaza por la extensión real de tus rasters (meta.json -> bbox).
  Geo.BBOX_DEFECTO = { latMin: -8.04, latMax: -4.55, lonMin: -79.34, lonMax: -77.74 };

  Geo.enBBox = (lat, lon, b) => lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;

  /** Revisa si la coordenada tiene sentido para Cajamarca y propone una corrección si se puede. */
  Geo.validar = function (lat, lon, b) {
    if (!isFinite(lat) || !isFinite(lon))
      return { ok: false, motivo: "formato", fix: null };
    if (Geo.enBBox(lat, lon, b)) return { ok: true };
    // Errores típicos: olvidar el signo negativo, o poner longitud en el campo de latitud
    const candidatos = [
      { c: [-Math.abs(lat), -Math.abs(lon)], motivo: "signo" },
      { c: [-Math.abs(lon), -Math.abs(lat)], motivo: "invertidas" },
    ];
    for (const k of candidatos)
      if (Geo.enBBox(k.c[0], k.c[1], b)) return { ok: false, motivo: k.motivo, fix: k.c };
    return { ok: false, motivo: "fuera", fix: null };
  };

  // Exposición a viviendas según distancia (m). Criterio del equipo: ver README / "Acerca del modelo".
  Geo.UMBRALES_EXPOSICION = [
    { max: 20, nivel: 3, clase: "alto", etiqueta: "ALTA" },
    { max: 100, nivel: 2, clase: "medio", etiqueta: "MODERADA" },
    { max: 200, nivel: 1, clase: "bajo", etiqueta: "BAJA" },
  ];
  Geo.nivelExposicion = function (d, umbrales) {
    for (const u of umbrales || Geo.UMBRALES_EXPOSICION) if (d <= u.max) return u;
    return { max: Infinity, nivel: 0, clase: "ninguna", etiqueta: "SIN VIVIENDAS CERCANAS" };
  };

  /** Combina nivel de probabilidad del modelo (0 bajo, 1 moderado, 2 alto) con exposición (0..3). */
  Geo.prioridad = function (pNivel, eNivel) {
    if (pNivel === 0) return { txt: "Baja", clase: "bajo" };
    if (pNivel === 2 && eNivel >= 2) return { txt: "Muy alta", clase: "alto" };
    if ((pNivel === 2 && eNivel === 1) || (pNivel === 1 && eNivel >= 2)) return { txt: "Alta", clase: "alto" };
    if (pNivel === 2 || (pNivel === 1 && eNivel === 1)) return { txt: "Media", clase: "medio" };
    return { txt: "Baja", clase: "bajo" };
  };

  /** Distancia (m) al punto más cercano. tiles = [{x0, y0, paso, arr}], arr = Uint16 [x,y,x,y…]
      donde x = (lon - x0)/paso e y = (y0 - lat)/paso, cuantizados a 0..65535. */
  Geo.distanciaMasCercana = function (lat, lon, tiles) {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
    let best = Infinity, pt = null;
    for (const t of tiles) {
      const a = t.arr;
      for (let i = 0; i < a.length; i += 2) {
        const px = t.x0 + (a[i] / 65535) * t.paso, py = t.y0 - (a[i + 1] / 65535) * t.paso;
        const ex = (px - lon) * kx, ey = (py - lat) * ky, d2 = ex * ex + ey * ey;
        if (d2 < best) { best = d2; pt = [py, px]; }
      }
    }
    return { dist: Math.sqrt(best), punto: pt };
  };

  // ---------------- Guía de interpretación de índices ----------------
  // Cada rango: valor < max. Fuentes (rangos genéricos pensados sobre todo para cultivos):
  // NDVI: EOS Data Analytics y Cropler (se unificaron sus cortes) · NDBI: Farmonaut · SAVI y BSI: guías generales.
  Geo.GUIA = [
    { k: "NDVI", nombre: "Índice de vegetación (NDVI)", rango: "−1 a 1",
      desc: "Mide cuánta vegetación verde y activa hay: la vegetación refleja mucho infrarrojo cercano y absorbe rojo.",
      rangos: [
        { max: 0, txt: "Sin vegetación (agua, nieve, nubes o superficies construidas)", lim: "< 0" },
        { max: 0.1, txt: "Suelo desnudo o rocoso", lim: "0 – 0,1" },
        { max: 0.3, txt: "Vegetación escasa (matorral, pasto ralo)", lim: "0,1 – 0,3" },
        { max: 0.6, txt: "Vegetación moderada (puede incluir cultivos con estrés)", lim: "0,3 – 0,6" },
        { max: Infinity, txt: "Vegetación densa y sana", lim: "> 0,6" }],
      nota: "EOS y Cropler difieren levemente (p. ej. 0,2–0,5 vs 0,3–0,6 para vegetación moderada); aquí se usan los cortes de Cropler." },
    { k: "NDBI", nombre: "Índice de áreas construidas (NDBI)", rango: "−1 a 1",
      desc: "Resalta superficies construidas o muy intervenidas (techos, concreto, vías) usando infrarrojo de onda corta (SWIR) frente al infrarrojo cercano.",
      rangos: [
        { max: 0.2, txt: "Sin construcciones densas (vegetación, agua, cultivos o suelo desnudo)", lim: "< 0,2" },
        { max: Infinity, txt: "Zona construida o muy intervenida", lim: "0,2 – 0,7" }],
      nota: "El suelo desnudo y las construcciones pueden confundirse en el NDBI; por eso se interpreta junto al BSI y al NDVI." },
    { k: "SAVI", nombre: "Vegetación ajustada al suelo (SAVI)", rango: "−1 a 1,5",
      desc: "Como el NDVI, pero corrige el brillo del suelo; es más fiable donde la vegetación es dispersa.",
      rangos: [
        { max: 0, txt: "Sin vegetación (agua, nieve, hielo o zona urbana)", lim: "< 0" },
        { max: 0.2, txt: "Suelo desnudo, rocas o vegetación mínima", lim: "0 – 0,2" },
        { max: 0.5, txt: "Vegetación escasa a moderada (arbustos, matorral, cultivos en desarrollo)", lim: "0,2 – 0,5" },
        { max: Infinity, txt: "Vegetación densa y saludable", lim: "> 0,5" }],
      nota: "" },
    { k: "BSI", nombre: "Índice de suelo desnudo (BSI)", rango: "−1 a 1",
      desc: "Destaca suelo expuesto: combina SWIR y rojo (que suben con el suelo mineral) frente a azul e infrarrojo cercano (que suben con la vegetación).",
      rangos: [
        { max: -0.1, txt: "Cobertura vegetal desarrollada", lim: "< −0,1" },
        { max: 0.1, txt: "Zona de transición: suelo con poca vegetación o superficie mixta", lim: "−0,1 – 0,1" },
        { max: Infinity, txt: "Suelo expuesto (arado, erosionado) o superficie construida", lim: "> 0,1" }],
      nota: "Las fuentes describen los rangos solo de forma cualitativa (negativo / cercano a 0 / positivo); los cortes en ±0,1 son un criterio práctico de este tablero. El asfalto y el cemento también dan valores altos." },
    { k: "LST", nombre: "Temperatura superficial (LST)", rango: "°C",
      desc: "Temperatura de la superficie del terreno medida por Landsat 8/9 (banda térmica), no la del aire. Es una mediana de las temporadas secas 2025–2026, con imágenes de la mañana.",
      rangos: [{ max: Infinity, txt: "Temperatura de la superficie del terreno (no del aire)", lim: "—" }],
      nota: "Las superficies desnudas o construidas suelen calentarse más que las cubiertas de vegetación; la altitud y la orientación de la ladera también influyen. No se clasifica en rangos porque su lectura depende del contexto." },
  ];

  /** Texto interpretativo de un valor de índice según la guía. */
  Geo.interpretar = function (k, v) {
    const g = Geo.GUIA.find((x) => x.k === k);
    if (!g || v === null || v === undefined || !isFinite(v)) return "";
    return g.rangos.find((r) => v < r.max).txt;
  };

  // ---------------- Distancia a líneas (agua, vías) ----------------
  // Cada mosaico guarda segmentos (x1,y1,x2,y2) en uint16 con f = q/65535*SPAN + LO (fracción del mosaico).
  Geo.SEG_LO = -0.06; Geo.SEG_SPAN = 1.12;

  /** Distancia mínima (m) del punto a los segmentos del mosaico y punto más cercano [lat, lon]. */
  Geo.distanciaSegmentos = function (lat, lon, t) {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
    const a = t.arr, f = (q) => (q / 65535) * Geo.SEG_SPAN + Geo.SEG_LO;
    let best = Infinity, pt = null;
    for (let i = 0; i < a.length; i += 4) {
      const x1 = (t.x0 + f(a[i]) * t.paso - lon) * kx, y1 = (t.y0 - f(a[i + 1]) * t.paso - lat) * ky;
      const x2 = (t.x0 + f(a[i + 2]) * t.paso - lon) * kx, y2 = (t.y0 - f(a[i + 3]) * t.paso - lat) * ky;
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      let u = L2 > 0 ? -(x1 * dx + y1 * dy) / L2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const cx = x1 + u * dx, cy = y1 + u * dy, d2 = cx * cx + cy * cy;
      if (d2 < best) { best = d2; pt = [lat + cy / ky, lon + cx / kx]; }
    }
    return { dist: Math.sqrt(best), punto: pt };
  };

  /** Punto más cercano de una lista [{lat, lon, props}] (p. ej. botaderos OEFA). */
  Geo.masCercano = function (lat, lon, lista) {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
    let best = Infinity, item = null;
    for (const p of lista) {
      const ex = (p.lon - lon) * kx, ey = (p.lat - lat) * ky, d2 = ex * ex + ey * ey;
      if (d2 < best) { best = d2; item = p; }
    }
    return { dist: Math.sqrt(best), item };
  };

  root.Geo = Geo;
  if (typeof module !== "undefined" && module.exports) module.exports = Geo;
})(typeof window !== "undefined" ? window : globalThis);
