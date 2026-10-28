# -*- coding: utf-8 -*-
"""
Convierte modelo_optimo_botaderos.joblib (RandomForest de scikit-learn) a JSON
para ejecutarlo en el navegador (GitHub Pages no corre Python).
Uso:  python scripts/exportar_modelo_json.py ruta/modelo_optimo_botaderos.joblib data/model_rf.json
"""
import sys, json, joblib, numpy as np

ruta_in = sys.argv[1] if len(sys.argv) > 1 else "modelo_optimo_botaderos.joblib"
ruta_out = sys.argv[2] if len(sys.argv) > 2 else "data/model_rf.json"

m = joblib.load(ruta_in)
assert hasattr(m, "estimators_"), "Este script exporta RandomForest (tu modelo óptimo fue RF)."

arboles = []
for est in m.estimators_:
    t = est.tree_
    v = t.value[:, 0, :]
    p1 = v[:, 1] / v.sum(axis=1)              # P(clase 1) en cada nodo
    hoja = t.children_left == -1
    arboles.append({
        "l": t.children_left.tolist(),
        "r": t.children_right.tolist(),
        "f": np.where(hoja, -1, t.feature).tolist(),
        "t": [round(float(x), 6) for x in t.threshold],
        "p": [round(float(x), 5) for x in p1],
    })

out = {"features": list(m.feature_names_in_), "n_trees": len(arboles), "trees": arboles}
with open(ruta_out, "w") as f:
    json.dump(out, f, separators=(",", ":"))
print("OK ->", ruta_out)

# Verificación contra scikit-learn
rng = np.random.default_rng(0)
X = np.c_[rng.uniform(-.2, .9, 500), rng.uniform(-.4, .4, 500), rng.uniform(-.4, .4, 500),
          rng.uniform(0, .7, 500), rng.uniform(10, 45, 500)]
ref = m.predict_proba(X)[:, 1]
def pred(x):
    s = 0
    for a in arboles:
        n = 0
        while a["f"][n] != -1:
            n = a["l"][n] if x[a["f"][n]] <= a["t"][n] else a["r"][n]
        s += a["p"][n]
    return s / len(arboles)
mine = np.array([pred(x) for x in X])
print("Diferencia máxima vs scikit-learn:", float(np.abs(ref - mine).max()))
