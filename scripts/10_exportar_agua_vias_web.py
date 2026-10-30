# -*- coding: utf-8 -*-
"""
10_exportar_agua_vias_web.py
------------------------------------------------------------------------------
Opción A (informativa): prepara capas de RECURSOS HÍDRICOS SUPERFICIALES o de VÍAS DE ACCESO
para que la web indique si hay agua o vías cerca del punto analizado (≤ 500 m).

Cada mosaico guarda los segmentos de línea que caen dentro de él (+ un margen de 660 m),
en la misma grilla de data/meta.json. La página solo descarga el mosaico del punto consultado.

Uso:
  python scripts/10_exportar_agua_vias_web.py agua  "ruta\\waterways.shp" "ruta\\water_a.shp"
  python scripts/10_exportar_agua_vias_web.py vias  "ruta\\roads.shp" --query "fclass != 'footway'"

Acepta shapefile, GeoJSON o GPKG (líneas y polígonos; de los polígonos se usa el borde).
Fuentes posibles (verifica vigencia y licencia): OpenStreetMap vía Geofabrik (extractos por país), hidrografía ANA/IGN,
red vial del MTC. Requiere haber corrido antes el script 07 (data/meta.json).
------------------------------------------------------------------------------
"""
import argparse, glob, json, os
import numpy as np
import geopandas as gpd
import pandas as pd
from shapely.geometry import box
from shapely.ops import linemerge

ap = argparse.ArgumentParser()
ap.add_argument("tipo", choices=["agua", "vias"])
ap.add_argument("archivos", nargs="+")
ap.add_argument("--query", default=None, help="filtro pandas opcional, p. ej. \"fclass != 'footway'\"")
ap.add_argument("--fuente", default=None, help="texto de la fuente para meta.json")
args = ap.parse_args()

DATA = "data"
MARGEN = 0.006                 # grados (≈660 m) alrededor de cada mosaico
LO, SPAN = -0.06, 1.12         # cuantización: fracción del mosaico -0.06..1.06 -> 0..65535 (≈0,25 m)
SIMPL = 0.00002                # simplificación (≈2 m)

with open(os.path.join(DATA, "meta.json")) as f:
    meta = json.load(f)
T, res = meta["tile"], meta["res"]
paso = res * T
lon0, lat0, ncols, nrows = meta["lon0"], meta["lat0"], meta["ncols"], meta["nrows"]
assert MARGEN / paso < -LO, "El margen excede el rango de cuantización"

partes = []
for patron in args.archivos:
    for ruta in glob.glob(patron):
        g = gpd.read_file(ruta)
        if args.query:
            g = g.query(args.query)
        g = g.to_crs(4326)[["geometry"]]
        g["geometry"] = g.geometry.boundary.where(g.geom_type.isin(["Polygon", "MultiPolygon"]), g.geometry)
        partes.append(g[~g.geometry.is_empty & g.geometry.notna()])
if not partes:
    raise SystemExit("No se leyó ningún archivo.")
gdf = gpd.GeoDataFrame(pd.concat(partes, ignore_index=True), crs=4326)
gdf["geometry"] = gdf.geometry.simplify(SIMPL)
print(f"Entidades leídas: {len(gdf):,}")
sidx = gdf.sindex

carpeta = os.path.join(DATA, args.tipo)
os.makedirs(carpeta, exist_ok=True)
for v in glob.glob(os.path.join(carpeta, "*.bin")):
    os.remove(v)

def lineas(geom):
    if geom.is_empty: return []
    if geom.geom_type == "LineString": return [geom]
    if hasattr(geom, "geoms"):
        return [l for g in geom.geoms for l in lineas(g)]
    return []

nseg_total, bytes_total, ntiles = 0, 0, 0
for r in range(nrows):
    for c in range(ncols):
        x0, y0 = lon0 + c * paso, lat0 - r * paso               # esquina superior izquierda
        caja = box(x0 - MARGEN, y0 - paso - MARGEN, x0 + paso + MARGEN, y0 + MARGEN)
        cand = gdf.iloc[list(sidx.query(caja, predicate="intersects"))]
        if cand.empty: continue
        segs = []
        for g in cand.geometry:
            for ln in lineas(g.intersection(caja)):
                xy = np.asarray(ln.coords)
                if len(xy) >= 2:
                    segs.append(np.c_[xy[:-1], xy[1:]])          # x1,y1,x2,y2
        if not segs: continue
        s = np.vstack(segs)
        fx = lambda lon: (lon - x0) / paso
        fy = lambda lat: (y0 - lat) / paso
        q = np.empty((len(s), 4), dtype="<u2")
        for j, (conv, col) in enumerate([(fx, 0), (fy, 1), (fx, 2), (fy, 3)]):
            f = conv(s[:, col])
            q[:, j] = np.clip(np.round((f - LO) / SPAN * 65535), 0, 65535)
        q.tofile(os.path.join(carpeta, f"{r}_{c}.bin"))
        nseg_total += len(s); bytes_total += q.nbytes; ntiles += 1

meta[args.tipo] = {"ok": True, "n": int(nseg_total), "radio_m": 500,
                   "fuente": args.fuente or ", ".join(os.path.basename(a) for a in args.archivos)}
with open(os.path.join(DATA, "meta.json"), "w") as f:
    json.dump(meta, f)
print(f"Mosaicos: {ntiles} | segmentos: {nseg_total:,} | peso total: {bytes_total/1e6:.1f} MB")
