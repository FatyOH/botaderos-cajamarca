# -*- coding: utf-8 -*-
"""
08_exportar_edificaciones_web.py
------------------------------------------------------------------------------
Convierte los CSV de centroides de edificaciones (script 01b) en mosaicos binarios
livianos alineados con la grilla de data/meta.json (la misma de los índices).
La página descarga solo los mosaicos vecinos al punto consultado y mide la distancia exacta.

Cada .bin = pares (x, y) uint16 little-endian: posición dentro del mosaico (0..65535 ≈ 0,2 m).
Uso:  python scripts/08_exportar_edificaciones_web.py "C:\\ruta\\a\\EDIF_Cajamarca_*.csv"
Requiere haber corrido antes el script 07 (genera data/meta.json).
------------------------------------------------------------------------------
"""
import glob, json, os, sys
import numpy as np
import pandas as pd

PATRON = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\sthef\Downloads\ING_RESIDUOS\IA-RESIDUOS\Script\GEE_Cajamarca_Edificaciones\EDIF_Cajamarca_*.csv"
DATA = "data"

with open(os.path.join(DATA, "meta.json")) as f:
    meta = json.load(f)
T, res = meta["tile"], meta["res"]
paso = res * T
lon0, lat0, ncols, nrows = meta["lon0"], meta["lat0"], meta["ncols"], meta["nrows"]

archivos = sorted(glob.glob(PATRON))
if not archivos:
    raise SystemExit(f"No se encontraron CSV con el patrón: {PATRON}")
df = pd.concat([pd.read_csv(a, usecols=["lon", "lat"]) for a in archivos], ignore_index=True)
n0 = len(df)
df = df.dropna().drop_duplicates()
print(f"Edificaciones leídas: {n0:,} | únicas: {len(df):,}")

col = np.floor((df["lon"].to_numpy() - lon0) / paso).astype(int)
fila = np.floor((lat0 - df["lat"].to_numpy()) / paso).astype(int)
ok = (col >= 0) & (col < ncols) & (fila >= 0) & (fila < nrows)
print(f"Fuera de la grilla (se descartan): {(~ok).sum():,}")
df, col, fila = df[ok], col[ok], fila[ok]

fx = (df["lon"].to_numpy() - (lon0 + col * paso)) / paso
fy = ((lat0 - fila * paso) - df["lat"].to_numpy()) / paso
qx = np.clip(np.round(fx * 65535), 0, 65535).astype("<u2")
qy = np.clip(np.round(fy * 65535), 0, 65535).astype("<u2")

os.makedirs(os.path.join(DATA, "edif"), exist_ok=True)
for viejo in glob.glob(os.path.join(DATA, "edif", "*.bin")):
    os.remove(viejo)

claves = pd.DataFrame({"f": fila, "c": col, "i": np.arange(len(col))}).groupby(["f", "c"])["i"].apply(np.array)
total = 0
for (f, c), idx in claves.items():
    par = np.empty(len(idx) * 2, dtype="<u2")
    par[0::2], par[1::2] = qx[idx], qy[idx]
    par.tofile(os.path.join(DATA, "edif", f"{f}_{c}.bin"))
    total += par.nbytes

meta["edif"] = {"ok": True, "n": int(len(df)), "fuente": "Google Open Buildings V3 (CC-BY-4.0), centroides",
                "confianza_min": 0.70}
with open(os.path.join(DATA, "meta.json"), "w") as f:
    json.dump(meta, f)
print(f"Mosaicos de edificaciones: {len(claves)} | peso total: {total/1e6:.1f} MB")
