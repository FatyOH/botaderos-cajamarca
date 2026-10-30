# -*- coding: utf-8 -*-
"""
09_exportar_botaderos_oefa.py
------------------------------------------------------------------------------
Convierte la lista oficial de botaderos OEFA (coordenadas UTM: ESTE, NORTE, ZONA)
a coordenadas geográficas (WGS84, lat/lon) y la guarda como GeoJSON para la web.

Salida: data/botaderos_oefa.geojson   (se carga solo en el mapa)

Uso:  python scripts/09_exportar_botaderos_oefa.py "C:\\ruta\\Inventario_Cajamarca_original.xlsx"
Columnas esperadas: ESTE, NORTE, ZONA  (opcionales: COD_RRSS, DEPARTAMEN, PROVINCIA, DISTRITO, AREA_HA)

IMPORTANTE:
 - Hemisferio SUR: Perú usa EPSG:327xx (32717 = zona 17S, 32718 = 18S). Con 326xx quedarías en otro hemisferio.
 - Datum: se asume WGS84 (igual que en tu script 02). Si la lista oficial está en PSAD56 (EPSG:248xx),
   los puntos quedarían corridos decenas a cientos de metros: confirma el datum en los metadatos del OEFA.
------------------------------------------------------------------------------
"""
import json, os, sys
import pandas as pd
from pyproj import Transformer

RUTA = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\sthef\Downloads\ING_RESIDUOS\IA-RESIDUOS\Script\Inventario_Cajamarca_original.xlsx"
SALIDA = os.path.join("data", "botaderos_oefa.geojson")
DEPARTAMENTO = "Cajamarca"      # pon None para no filtrar
ZONA_POR_DEFECTO = 17


def num(s):
    return pd.to_numeric(pd.Series(s).astype(str).str.replace(",", ".").str.strip(), errors="coerce")


df = pd.read_excel(RUTA) if RUTA.lower().endswith((".xlsx", ".xls")) else pd.read_csv(RUTA)
if DEPARTAMENTO and "DEPARTAMEN" in df.columns:
    df = df[df["DEPARTAMEN"].astype(str).str.strip().str.lower() == DEPARTAMENTO.lower()]
df = df.copy()
for c in ["ESTE", "NORTE"]:
    df[c] = num(df[c])
df["ZONA"] = num(df["ZONA"]).fillna(ZONA_POR_DEFECTO).astype(int)
antes = len(df)
df = df.dropna(subset=["ESTE", "NORTE"])
print(f"Registros: {antes} | con coordenadas válidas: {len(df)} | zonas UTM: {sorted(df['ZONA'].unique())}")

features = []
for zona, sub in df.groupby("ZONA"):
    tr = Transformer.from_crs(f"EPSG:{32700 + int(zona)}", "EPSG:4326", always_xy=True)
    lon, lat = tr.transform(sub["ESTE"].to_numpy(), sub["NORTE"].to_numpy())
    for (_, r), x, y in zip(sub.iterrows(), lon, lat):
        props = {"cod": str(r.get("COD_RRSS", "")), "dist": str(r.get("DISTRITO", "")),
                 "prov": str(r.get("PROVINCIA", ""))}
        a = pd.to_numeric(str(r.get("AREA_HA", "")).replace(",", "."), errors="coerce")
        if pd.notna(a):
            props["area_ha"] = round(float(a), 3)
        features.append({"type": "Feature", "properties": props,
                         "geometry": {"type": "Point", "coordinates": [round(float(x), 6), round(float(y), 6)]}})

# Control de calidad: ¿caen dentro del rango de Cajamarca?
lats = [f["geometry"]["coordinates"][1] for f in features]; lons = [f["geometry"]["coordinates"][0] for f in features]
print(f"Rango resultante -> lat {min(lats):.4f}..{max(lats):.4f} | lon {min(lons):.4f}..{max(lons):.4f}")
print("(Debe estar aprox. en lat -4.5..-8.0 y lon -77.7..-79.4. Si no, revisa ZONA, hemisferio o datum.)")

os.makedirs("data", exist_ok=True)
with open(SALIDA, "w", encoding="utf-8") as f:
    json.dump({"type": "FeatureCollection", "features": features}, f, ensure_ascii=False, separators=(",", ":"))
print("Guardado:", SALIDA)
