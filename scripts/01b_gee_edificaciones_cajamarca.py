# -*- coding: utf-8 -*-
"""
01b_gee_edificaciones_cajamarca.py
------------------------------------------------------------------------------
Exporta desde Google Earth Engine los CENTROIDES de las edificaciones de
Cajamarca (Google Open Buildings V3, cobertura América Latina, inferido en
mayo de 2023, licencia CC-BY-4.0) como CSV (lon, lat) en tu Google Drive.

Se divide el departamento en celdas para que ninguna tarea exceda los límites de GEE.
Siguiente paso: descargar los CSV de Drive y correr 08_exportar_edificaciones_web.py
------------------------------------------------------------------------------
"""
import ee

PROJECT_ID = "botaderos-cajamarca"
DRIVE_FOLDER = "GEE_Cajamarca_Edificaciones"
CONFIANZA_MIN = 0.70      # 0.70 = valor habitual; se sube a 0.75 para menos falsos positivos
NX, NY = 4, 5             # celdas (columnas x filas). Si una tarea falla por tiempo, aumenta

ee.Initialize(project=PROJECT_ID)

roi = ee.FeatureCollection("FAO/GAUL/2025/level1").filter(
    ee.Filter.And(ee.Filter.eq("GAUL0_NAME", "Peru"), ee.Filter.eq("GAUL1_NAME", "Cajamarca"))
).geometry()

edif = ee.FeatureCollection("GOOGLE/Research/open-buildings/v3/polygons").filter(
    ee.Filter.gte("confidence", CONFIANZA_MIN)
)

# Rectángulo que envuelve al departamento
esq = roi.bounds().coordinates().get(0).getInfo()
xs, ys = [c[0] for c in esq], [c[1] for c in esq]
xmin, xmax, ymin, ymax = min(xs), max(xs), min(ys), max(ys)
print(f"Extensión ROI: lon {xmin:.4f}..{xmax:.4f} | lat {ymin:.4f}..{ymax:.4f}")


def a_centroide(f):
    c = f.geometry().centroid(maxError=1).coordinates()
    return ee.Feature(ee.Geometry.Point(c), {"lon": c.get(0), "lat": c.get(1)})


n = 0
for i in range(NX):
    for j in range(NY):
        x0, x1 = xmin + (xmax - xmin) * i / NX, xmin + (xmax - xmin) * (i + 1) / NX
        y0, y1 = ymin + (ymax - ymin) * j / NY, ymin + (ymax - ymin) * (j + 1) / NY
        celda = ee.Geometry.Rectangle([x0, y0, x1, y1], proj="EPSG:4326", geodesic=False)
        pts = (
            edif.filterBounds(celda).map(a_centroide)
            .filterBounds(celda)   # el centroide debe caer en la celda (evita duplicados)
            .filterBounds(roi)     # y dentro de Cajamarca
        )
        tarea = ee.batch.Export.table.toDrive(
            collection=pts,
            description=f"EDIF_Cajamarca_{i}_{j}",
            folder=DRIVE_FOLDER,
            fileNamePrefix=f"EDIF_Cajamarca_{i}_{j}",
            fileFormat="CSV",
            selectors=["lon", "lat"],
        )
        tarea.start()
        n += 1
print(f"{n} tareas enviadas. Sigue el avance en https://code.earthengine.google.com/tasks")
