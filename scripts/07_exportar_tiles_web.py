# -*- coding: utf-8 -*-
"""
07_exportar_tiles_web.py
------------------------------------------------------------------------------
Convierte los GeoTIFF pesados de GEE (10 m, varios GB) en mosaicos binarios
livianos para la web. La página solo descarga el mosaico (~80 KB) que contiene
la coordenada consultada.

Entrada : GEE_Cajamarca_Botaderos/Cajamarca_S2_indices_LST_secas_2025_2026*.tif
Salida  : data/meta.json  +  data/tiles/{fila}_{col}.bin

Cada .bin = 5 bandas (NDVI, NDBI, BSI, SAVI, LST) x TILE x TILE, uint8 (255 = sin dato).
Resolución de la grilla web: RES grados (0.001° ≈ 110 m). Se promedia el píxel de 10 m.
Uso:  python scripts/07_exportar_tiles_web.py
------------------------------------------------------------------------------
"""
import glob, json, os, sys
import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling, transform_bounds

TIF_PATTERN = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\sthef\Downloads\ING_RESIDUOS\IA-RESIDUOS\Script\GEE_Cajamarca_Botaderos\Cajamarca_S2_indices_LST_secas_2025_2026*.tif"
SALIDA = "data"
RES = 0.0005          # grados por píxel (≈110 m cuando está en 0.001). En 0.0005 para más detalle (4x más archivos)
TILE = 128           # píxeles por mosaico
NODATA = -9999
BANDAS = ["NDVI", "NDBI", "BSI", "SAVI", "LST"]
# Rango de cuantización a uint8 (0..254); 255 = sin dato
RANGOS = {"NDVI": (-1, 1), "NDBI": (-1, 1), "BSI": (-1, 1), "SAVI": (-1, 1.5), "LST": (-10, 60)}

tifs = sorted(glob.glob(TIF_PATTERN))
if not tifs:
    raise SystemExit(f"No se encontraron TIFF con el patrón: {TIF_PATTERN}")
print("TIFF encontrados:", len(tifs))

# Posición de cada banda según su descripción (como en tus scripts 02/03)
with rasterio.open(tifs[0]) as s0:
    desc = [(d or "").upper() for d in s0.descriptions]
    idx = [(desc.index(b) + 1) if b in desc else i + 1 for i, b in enumerate(BANDAS)]
print("Índices de banda usados:", dict(zip(BANDAS, idx)))

# Extensión total en EPSG:4326, alineada a múltiplos de un mosaico
W = E = S = N = None
for p in tifs:
    with rasterio.open(p) as s:
        w, so, e, n = transform_bounds(s.crs, "EPSG:4326", *s.bounds)
    W = w if W is None else min(W, w); S = so if S is None else min(S, so)
    E = e if E is None else max(E, e); N = n if N is None else max(N, n)
paso = RES * TILE
lon0 = np.floor(W / paso) * paso
lat0 = np.ceil(N / paso) * paso                      # esquina superior izquierda
ncols = int(np.ceil((E - lon0) / paso)); nrows = int(np.ceil((lat0 - S) / paso))
print(f"Grilla de mosaicos: {nrows} filas x {ncols} columnas")

os.makedirs(os.path.join(SALIDA, "tiles"), exist_ok=True)
for viejo in glob.glob(os.path.join(SALIDA, "tiles", "*.bin")):   # evita mosaicos obsoletos de corridas previas
    os.remove(viejo)
srcs = [rasterio.open(p) for p in tifs]
guardados, bytes_tot = 0, 0

for r in range(nrows):
    for c in range(ncols):
        x0 = lon0 + c * paso; y0 = lat0 - r * paso
        dst_tr = from_origin(x0, y0, RES, RES)
        out = np.full((len(BANDAS), TILE, TILE), np.nan, dtype="float32")
        for s in srcs:
            l, b, rr, t = transform_bounds("EPSG:4326", s.crs, x0, y0 - paso, x0 + paso, y0)
            if rr < s.bounds.left or l > s.bounds.right or t < s.bounds.bottom or b > s.bounds.top:
                continue
            for k, bi in enumerate(idx):
                tmp = np.full((TILE, TILE), NODATA, dtype="float32")
                reproject(rasterio.band(s, bi), tmp, dst_transform=dst_tr, dst_crs="EPSG:4326",
                          src_nodata=NODATA, dst_nodata=NODATA, resampling=Resampling.average)
                ok = (tmp != NODATA) & np.isnan(out[k])
                out[k][ok] = tmp[ok]
        if np.isnan(out[0]).all():
            continue                                  # mosaico vacío: no se guarda
        q = np.full(out.shape, 255, dtype="uint8")
        for k, nom in enumerate(BANDAS):
            lo, hi = RANGOS[nom]
            v = np.clip((out[k] - lo) / (hi - lo) * 254, 0, 254)
            q[k] = np.where(np.isnan(out[k]), 255, np.round(v)).astype("uint8")
        q.tofile(os.path.join(SALIDA, "tiles", f"{r}_{c}.bin"))
        guardados += 1; bytes_tot += q.nbytes
    print(f"fila {r+1}/{nrows} lista", end="\r")

meta = {"bbox": [round(W, 5), round(S, 5), round(E, 5), round(N, 5)],   # [oeste, sur, este, norte] reales de tus rasters
        "res": RES, "tile": TILE, "lon0": float(lon0), "lat0": float(lat0),
        "ncols": ncols, "nrows": nrows, "bandas": BANDAS,
        "rangos": {k: list(v) for k, v in RANGOS.items()}, "nodata": 255}
with open(os.path.join(SALIDA, "meta.json"), "w") as f:
    json.dump(meta, f)
print(f"\nMosaicos guardados: {guardados} | peso total: {bytes_tot/1e6:.1f} MB")
