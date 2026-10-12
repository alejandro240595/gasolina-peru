"""Genera data/stations.json con los precios de combustible de Osinergmin.

Pasos:
  1. Descarga el Excel "Ultimos-Precios-Registrados-EVPC.xlsx" (actualizado a diario).
  2. Agrupa las filas por grifo (CODIGO_OSINERG) y normaliza los productos.
  3. Ubica cada grifo:
       - Google Places (Text Search) si hay GOOGLE_MAPS_API_KEY  -> exacto  ("g")
       - Coincidencia por nombre con una estación de OpenStreetMap  -> exacto  ("o")
       - Centro del distrito (Nominatim)                            -> aproximado ("c")
  4. Detecta la marca (razón social, nombre en Google, etiqueta brand de OSM).

Todas las consultas externas se guardan en pipeline/cache/ para no repetirlas
y no pasar la cuota gratuita de Google.
"""

import datetime as dt
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import openpyxl
import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "pipeline" / "cache"
OUT_DIR = ROOT / "data"

EXCEL_URL = ("https://www.osinergmin.gob.pe/seccion/centro_documental/hidrocarburos/"
             "SCOP/SCOP-DOCS/{year}/Registro-precios/Ultimos-Precios-Registrados-EVPC.xlsx")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
PLACES_URL = "https://places.googleapis.com/v1/places:searchText"
USER_AGENT = "gasolina-peru/1.0 (app personal de precios de combustible)"

GOOGLE_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
# Text Search (Pro) tiene 5.000 llamadas gratis al mes; dejamos margen.
GOOGLE_MONTHLY_LIMIT = int(os.environ.get("GOOGLE_MONTHLY_LIMIT", "4800"))
GOOGLE_MAX_PER_RUN = int(os.environ.get("GOOGLE_MAX_PER_RUN", "1000"))
GOOGLE_RETRY_DAYS = 90          # reintentar grifos no encontrados cada 90 días
MAX_KM_FROM_DISTRICT = 35       # descartar resultados de Google muy lejos del distrito
NOMINATIM_BUDGET_S = int(os.environ.get("NOMINATIM_BUDGET_S", "2400"))

# código Osinergmin -> clave de combustible en la app
FUELS = {
    "06": "g84",
    "124": "gas90", "125": "gas95",
    "126": "g90", "127": "g95",
    "39": "diesel", "40": "diesel",
    "49": "glp",
    "131": "gnv",
}
FUEL_INFO = {
    "g84": {"label": "Gasolina 84", "unit": "gal"},
    "g90": {"label": "Gasohol Regular (90)", "unit": "gal"},
    "g95": {"label": "Gasohol Premium (95/97)", "unit": "gal"},
    "gas90": {"label": "Gasolina Regular (90)", "unit": "gal"},
    "gas95": {"label": "Gasolina Premium (95/97)", "unit": "gal"},
    "diesel": {"label": "Diésel B5", "unit": "gal"},
    "glp": {"label": "GLP", "unit": "gal"},
    "gnv": {"label": "GNV", "unit": "m3"},
}

# marca -> patrones (sobre texto sin tildes y en mayúsculas)
BRANDS = [
    ("Primax", [r"\bPRIMAX\b", r"\bCOESTI\b"]),
    ("Repsol", [r"\bREPSOL\b"]),
    ("Petroperú", [r"\bPETRO ?-?PERU\b"]),
    ("Pecsa", [r"\bPECSA\b", r"PERUANA DE COMBUSTIBLES"]),
    ("Mobil", [r"\bMOBIL\b"]),
    ("Shell", [r"\bSHELL\b"]),
    ("Terpel", [r"\bTERPEL\b"]),
    ("Puma", [r"\bPUMA\b"]),
    ("Energigas", [r"\bENERGIGAS\b"]),
    ("Limagas", [r"\bLIMAGAS\b"]),
    ("Gazel", [r"\bGAZEL\b"]),
    ("Ava", [r"\bAVA\b"]),
]

STOPWORDS = {"S", "A", "C", "SA", "SAC", "EIRL", "SRL", "SAA", "E", "I", "R", "L", "DE", "DEL", "LA",
             "LAS", "LOS", "EL", "Y", "SOCIEDAD", "ANONIMA", "CERRADA", "EMPRESA", "INDIVIDUAL",
             "RESPONSABILIDAD", "LIMITADA", "COMERCIAL", "ESTACION", "ESTACIONES", "SERVICIO",
             "SERVICIOS", "GRIFO", "GRIFOS", "SERVICENTRO", "MULTISERVICIOS", "INVERSIONES",
             "CORPORACION", "NEGOCIACIONES", "GAS", "GASOCENTRO", "COMBUSTIBLES", "PERU"}


def norm(text):
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(c for c in text if not unicodedata.combining(c)).upper()
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]", " ", text)).strip()


def tokens(text):
    return {t for t in norm(text).split() if t not in STOPWORDS and len(t) > 1}


def km(lat1, lng1, lat2, lng2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lng2 - lng1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def brand_of(*texts):
    for text in texts:
        t = norm(text)
        if not t:
            continue
        for brand, patterns in BRANDS:
            if any(re.search(p, t) for p in patterns):
                return brand
    return None


def load_cache(name):
    path = CACHE_DIR / name
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save_cache(name, data):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / name).write_text(json.dumps(data, ensure_ascii=False, indent=0, sort_keys=True),
                                  encoding="utf-8")


# ---------------------------------------------------------------- 1. Excel

def download_excel():
    year = dt.date.today().year
    for y in (year, year - 1):
        resp = requests.get(EXCEL_URL.format(year=y), headers={"User-Agent": USER_AGENT}, timeout=120)
        if resp.ok and resp.content[:2] == b"PK":
            print(f"Excel {y}: {len(resp.content) // 1024} KB, {resp.headers.get('Last-Modified')}")
            return resp.content, resp.headers.get("Last-Modified")
    sys.exit("No se pudo descargar el Excel de Osinergmin")


def parse_excel(content):
    ws = openpyxl.load_workbook(io.BytesIO(content), read_only=True).active
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() for h in next(rows)]
    col = {h: i for i, h in enumerate(header)}
    stations = {}
    for r in rows:
        sid = str(r[col["CODIGO_OSINERG"]] or "").strip()
        fuel = FUELS.get(str(r[col["COD_PRODUCTO"]] or "").strip())
        price = r[col["PRECIO_VENTA"]]
        if not sid or not fuel or not isinstance(price, (int, float)) or price <= 0:
            continue
        if str(r[col["PRODUCTO_ACTIVO"]] or "SI").upper() != "SI":
            continue
        dep = str(r[col["DEPARTAMENTO"]] or "").strip()
        st = stations.setdefault(sid, {
            "id": sid,
            "n": str(r[col["RAZON"]] or "").strip(),
            "a": str(r[col["DIRECCION"]] or "").strip(),
            "d": str(r[col["DISTRITO"]] or "").strip(),
            "p": str(r[col["PROVINCIA"]] or "").strip(),
            "r": "CALLAO" if "CALLAO" in dep else dep,
            "ruc": str(r[col["RUC"]] or "").strip(),
            "f": {},
        })
        fecha = r[col["FCHA_REGISTRO"]]
        fecha = fecha.strftime("%Y-%m-%d") if isinstance(fecha, dt.datetime) else str(fecha or "")[:10]
        old = st["f"].get(fuel)
        if old is None or price < old[0]:   # dos diésel en el mismo grifo -> el más barato
            st["f"][fuel] = [round(float(price), 2), fecha]
    print(f"Grifos con precios: {len(stations)}")
    return stations


# ---------------------------------------------------------------- 2. Centros de distrito

def district_key(st):
    return f"{st['r']}|{st['p']}|{st['d']}"


def geocode_districts(stations):
    cache = load_cache("districts.json")
    pending = sorted({district_key(s) for s in stations.values()} - cache.keys())
    print(f"Distritos en caché: {len(cache)}, por geocodificar: {len(pending)}")
    start = time.time()
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    for i, key in enumerate(pending):
        if time.time() - start > NOMINATIM_BUDGET_S:
            print("Tiempo de Nominatim agotado; se continúa en la próxima ejecución")
            break
        dep, prov, dist = key.split("|")
        result = None
        for q in (f"{dist}, {prov}, {dep}, Peru", f"{prov}, {dep}, Peru"):
            try:
                resp = session.get(NOMINATIM_URL, params={"q": q, "format": "json", "limit": 1,
                                                         "countrycodes": "pe"}, timeout=30)
                data = resp.json() if resp.ok else []
            except (requests.RequestException, ValueError):
                data = []
            time.sleep(1.1)  # política de uso de Nominatim: máx. 1 petición/segundo
            if data:
                result = [round(float(data[0]["lat"]), 5), round(float(data[0]["lon"]), 5)]
                break
        cache[key] = result
        if i % 50 == 49:
            save_cache("districts.json", cache)
            print(f"  {i + 1}/{len(pending)} distritos")
    save_cache("districts.json", cache)
    return cache


# ---------------------------------------------------------------- 3. OpenStreetMap

def load_osm():
    path = CACHE_DIR / "osm_fuel.json"
    if path.exists() and time.time() - path.stat().st_mtime < 7 * 86400:
        return json.loads(path.read_text(encoding="utf-8"))
    query = ('[out:json][timeout:180];area["ISO3166-1"="PE"]->.pe;'
             'nwr["amenity"="fuel"](area.pe);out center tags;')
    try:
        resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=240,
                             headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
        elements = resp.json()["elements"]
    except (requests.RequestException, ValueError, KeyError) as exc:
        print(f"Overpass falló ({exc}); se usa la copia anterior")
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    osm = []
    for e in elements:
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lng = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None:
            continue
        tags = e.get("tags", {})
        osm.append({"lat": round(lat, 6), "lng": round(lng, 6),
                    "name": " ".join(filter(None, [tags.get("name"), tags.get("operator")])),
                    "brand": tags.get("brand") or ""})
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(osm, ensure_ascii=False), encoding="utf-8")
    print(f"OSM: {len(osm)} estaciones")
    return osm


def nearest_osm(osm, lat, lng, max_km):
    best, best_d = None, max_km
    for o in osm:
        if abs(o["lat"] - lat) > 0.5 or abs(o["lng"] - lng) > 0.5:
            continue
        d = km(lat, lng, o["lat"], o["lng"])
        if d < best_d:
            best, best_d = o, d
    return best


def match_osm_by_name(osm, st, center):
    """Busca una estación OSM cerca del distrito cuyo nombre/operador coincida con la razón social."""
    want = tokens(st["n"])
    if not want or not center:
        return None
    best, best_score = None, 0.0
    for o in osm:
        if abs(o["lat"] - center[0]) > 0.2 or abs(o["lng"] - center[1]) > 0.2:
            continue
        have = tokens(o["name"])
        if not have:
            continue
        score = len(want & have) / len(want | have)
        if score > best_score and km(center[0], center[1], o["lat"], o["lng"]) < 20:
            best, best_score = o, score
    return best if best_score >= 0.5 else None


# ---------------------------------------------------------------- 4. Google Places

def google_query(st):
    return f"{st['a']}, {st['d']}, {st['p']}, {st['r'].title()}, Perú"


def geocode_google(stations, districts):
    cache = load_cache("google_places.json")
    usage = load_cache("google_usage.json")
    month = dt.date.today().strftime("%Y-%m")
    if not GOOGLE_KEY:
        print("Sin GOOGLE_MAPS_API_KEY: se omite Google Places")
        return cache
    used = usage.get(month, 0)
    budget = min(GOOGLE_MAX_PER_RUN, GOOGLE_MONTHLY_LIMIT - used)
    today = dt.date.today()

    def needs_lookup(st):
        hit = cache.get(st["id"])
        if not hit or hit.get("q") != google_query(st):
            return True
        if hit.get("miss"):
            return (today - dt.date.fromisoformat(hit["ts"])).days >= GOOGLE_RETRY_DAYS
        return False

    # Lima y Callao primero (más grifos); luego el resto
    order = sorted((s for s in stations.values() if needs_lookup(s)),
                   key=lambda s: (s["r"] not in ("LIMA", "CALLAO"), s["r"], s["id"]))
    print(f"Google Places: {len(order)} pendientes, presupuesto {max(budget, 0)} "
          f"(usadas este mes: {used}/{GOOGLE_MONTHLY_LIMIT})")
    session = requests.Session()
    session.headers.update({
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.formattedAddress",
        "Content-Type": "application/json",
    })
    calls = 0
    for st in order:
        if calls >= budget:
            break
        center = districts.get(district_key(st))
        body = {"textQuery": google_query(st), "includedType": "gas_station",
                "languageCode": "es", "regionCode": "PE", "maxResultCount": 3}
        if center:
            body["locationBias"] = {"circle": {"center": {"latitude": center[0], "longitude": center[1]},
                                               "radius": 30000.0}}
        try:
            resp = session.post(PLACES_URL, json=body, timeout=30)
        except requests.RequestException as exc:
            print(f"  error de red: {exc}")
            continue
        calls += 1
        if resp.status_code in (401, 403, 429):
            print(f"Google respondió {resp.status_code}: {resp.text[:300]}")
            break
        places = resp.json().get("places", []) if resp.ok else []
        entry = {"q": google_query(st), "ts": today.isoformat(), "miss": True}
        for place in places:
            loc = place.get("location", {})
            lat, lng = loc.get("latitude"), loc.get("longitude")
            if lat is None:
                continue
            if center and km(center[0], center[1], lat, lng) > MAX_KM_FROM_DISTRICT:
                continue
            entry = {"q": entry["q"], "ts": entry["ts"], "lat": round(lat, 6), "lng": round(lng, 6),
                     "name": place.get("displayName", {}).get("text", ""),
                     "addr": place.get("formattedAddress", ""), "pid": place.get("id", "")}
            break
        cache[st["id"]] = entry
        if calls % 100 == 0:
            save_cache("google_places.json", cache)
            print(f"  {calls} consultas")
    usage[month] = used + calls
    save_cache("google_places.json", cache)
    save_cache("google_usage.json", usage)
    print(f"Google Places: {calls} consultas en esta ejecución")
    return cache


# ---------------------------------------------------------------- main

def main():
    content, last_modified = download_excel()
    stations = parse_excel(content)
    districts = geocode_districts(stations)
    osm = load_osm()
    google = geocode_google(stations, districts)

    out, quality = [], {"g": 0, "o": 0, "c": 0, "none": 0}
    branded = 0
    for st in stations.values():
        center = districts.get(district_key(st))
        g = google.get(st["id"])
        lat = lng = None
        osm_hit = None
        if g and not g.get("miss") and g.get("q") == google_query(st):
            lat, lng, q = g["lat"], g["lng"], "g"
            osm_hit = nearest_osm(osm, lat, lng, 0.12)
        else:
            osm_hit = match_osm_by_name(osm, st, center)
            if osm_hit:
                lat, lng, q = osm_hit["lat"], osm_hit["lng"], "o"
            elif center:
                lat, lng, q = center[0], center[1], "c"
        if lat is None:
            quality["none"] += 1
            continue
        quality[q] += 1
        brand = brand_of(st["n"], g.get("name") if g else "", osm_hit["brand"] if osm_hit else "",
                         osm_hit["name"] if osm_hit else "")
        branded += brand is not None
        item = {k: st[k] for k in ("id", "n", "a", "d", "p", "r", "f")}
        item.update({"b": brand, "lat": lat, "lng": lng, "q": q})
        if g and g.get("name") and q == "g":
            item["gn"] = g["name"]
        out.append(item)

    out.sort(key=lambda s: s["id"])
    meta = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source_modified": last_modified,
        "count": len(out),
        "located": quality,
        "branded": branded,
        "fuels": FUEL_INFO,
        "brands": [b for b, _ in BRANDS],
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "stations.json").write_text(
        json.dumps({"meta": meta, "stations": out}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    print(json.dumps({k: meta[k] for k in ("count", "located", "branded")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
