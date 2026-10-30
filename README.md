# IA para la detección de riesgo de botaderos informales · Cajamarca  (v3)

Dashboard estático (HTML + Leaflet + Random Forest en JavaScript) publicado con GitHub Pages.

## Novedades
- v2: GeoBot (asistente de coordenadas) y exposición a viviendas (≤20 / ≤100 / ≤200 m).
- v3: guía de interpretación de índices, botaderos registrados por OEFA en el mapa, y entorno cercano
  (agua y vías a ≤ 500 m, solo informativo: no entra al cálculo del riesgo).

## Estructura
```
index.html · assets/css · assets/js (geo.js, app.js) · assets/img
data/model_rf.json            modelo exportado
data/meta.json                lo genera el script 07 (los demás scripts le agregan sus capas)
data/tiles/*.bin              índices espectrales (07)
data/edif/*.bin               edificaciones (08)
data/agua/*.bin, data/vias/*.bin   líneas de agua y vías (10)
data/botaderos_oefa.geojson   botaderos OEFA en lat/lon (09)
scripts/                      exportar_modelo_json · 07 · 01b (GEE) · 08 · 09 · 10
```

## Orden para generar los datos (IMPORTANTE: el 07 va primero, porque crea meta.json desde cero)
1. `python scripts/07_exportar_tiles_web.py`
2. `python scripts/01b_gee_edificaciones_cajamarca.py` → bajar CSV de Drive → `python scripts/08_exportar_edificaciones_web.py "ruta\EDIF_Cajamarca_*.csv"`
3. `python scripts/09_exportar_botaderos_oefa.py "ruta\lista_oefa.xlsx"`
4. `python scripts/10_exportar_agua_vias_web.py agua "ruta\hidrografia.shp"`
   `python scripts/10_exportar_agua_vias_web.py vias "ruta\vias.shp" --query "fclass != 'footway'"`
5. Probar local: `python -m http.server 8000` → http://localhost:8000

Cada capa es opcional: si falta, esa tarjeta simplemente no aparece.

## Criterios y límites
- Exposición a viviendas: 20 / 100 / 200 m es un criterio propuesto por el equipo, no una norma (las guías del MINAM para
  infraestructura formal piden ≥ 1 km a poblaciones). Verificar con OEFA / MINAM / DIRESA / municipalidad.
- Agua y vías: informativo; dependen de la completitud de la cartografía de origen.
- Los botaderos OEFA se usaron para entrenar el modelo: cerca de ellos el resultado no es validación independiente.
- Verifica que la lista OEFA sea de acceso público antes de subirla a un repositorio público.
