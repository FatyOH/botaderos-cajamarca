# IA para la detección de riesgo de botaderos informales · Cajamarca

Dashboard estático
## Estructura
```
index.html
assets/css/style.css · assets/js/app.js · assets/img/ (logos)
data/model_rf.json      ← modelo exportado (≈260 KB)
data/meta.json          ← lo genera scripts/07_exportar_tiles_web.py
data/tiles/*.bin        ← mosaicos de índices (~80 KB c/u), los genera el script 07
scripts/                ← exportar_modelo_json.py, 07_exportar_tiles_web.py
```

## Regenerar datos
1. `python scripts/exportar_modelo_json.py ruta/modelo_optimo_botaderos.joblib data/model_rf.json`
2. `python scripts/07_exportar_tiles_web.py`  (lee tus GeoTIFF de GEE)
3. Probar local: `python -m http.server 8000` y abrir http://localhost:8000

Los GeoTIFF originales NO se suben a GitHub (están en .gitignore).
