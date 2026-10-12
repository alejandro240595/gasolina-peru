# Gasolina Perú 🎙️⛽

App Android que, con tu voz y tu GPS, te dice qué grifos cercanos tienen el combustible
que buscas al mejor precio. Por ejemplo: *“Gasohol 95 en Primax o Repsol”*.

Los precios vienen del archivo oficial de Osinergmin
[`Ultimos-Precios-Registrados-EVPC.xlsx`](https://www.osinergmin.gob.pe/empresas/hidrocarburos/scop/documentos-scop),
que se actualiza a diario.

## Cómo funciona

```
Osinergmin (Excel) ──► GitHub Actions (2 veces al día) ──► data/stations.json ──► App en tu celular
                        · agrupa por grifo                                         · GPS + voz
                        · Google Places → ubicación exacta                         · filtra y ordena
                        · marca (razón social / Google / OSM)                      · lo lee en voz alta
```

| Carpeta | Contenido |
|---|---|
| `pipeline/` | Script Python que genera `data/stations.json`; `pipeline/cache/` guarda las ubicaciones ya encontradas |
| `app/` | App Capacitor (HTML/JS) → APK Android |
| `.github/workflows/` | `datos.yml` actualiza los precios · `apk.yml` compila el APK y lo publica en *Releases* |

## Puesta en marcha

1. **Crea un repositorio público en GitHub** (la app descarga los datos desde `raw.githubusercontent.com`)
   y sube esta carpeta.
2. **Secretos** (*Settings → Secrets and variables → Actions → New repository secret*):
   - `DEBUG_KEYSTORE_B64`: el contenido de `keystore/debug.keystore.b64` (generado localmente, no se sube
     al repo). Sirve para que cada APK nuevo se instale encima del anterior.
   - `GOOGLE_MAPS_API_KEY` (opcional pero recomendado): ver abajo.
3. En *Actions*, ejecuta **Actualizar precios** y luego **Compilar APK** (*Run workflow*).
4. En el celular abre *Releases* del repo, descarga `gasolina-peru.apk` e instálalo
   (Android pedirá permitir “instalar apps desconocidas” para el navegador).

## Ubicación exacta con Google Maps

El Excel no trae coordenadas. Cada grifo se ubica así, en orden:

1. **Google Places** (`g`): busca la dirección del grifo; el resultado se guarda en caché y no se vuelve a consultar.
2. **OpenStreetMap** (`o`): estación cercana cuyo nombre coincide con la razón social.
3. **Centro del distrito** (`c`): aproximado; la app lo marca como “ubicación aproximada” y para
   “Cómo llegar” usa la dirección escrita en vez de las coordenadas.

Para activar Google:
1. En [Google Cloud Console](https://console.cloud.google.com/) crea un proyecto y activa la facturación
   (pide tarjeta, pero Places Text Search incluye 5.000 consultas gratis al mes).
2. Habilita **Places API (New)** y crea una *API key* restringida a esa API.
3. Guárdala como secreto `GOOGLE_MAPS_API_KEY`.

El script respeta un tope de **4.800 consultas/mes** (`GOOGLE_MONTHLY_LIMIT`) y **1.000 por ejecución**
(`GOOGLE_MAX_PER_RUN`). Con ~5.700 grifos, la primera ubicación completa toma unos 5 días del primer mes
y el resto el mes siguiente; después solo se consultan grifos nuevos o con dirección cambiada.

## Frases que entiende

| Dices | Entiende |
|---|---|
| “gasohol 95”, “premium”, “noventa y siete” | Premium (95/97) |
| “regular”, “noventa”, “gasohol 90” | Regular (90) |
| “84” | Gasolina 84 |
| “diésel”, “petróleo” | Diésel B5 |
| “GLP”, “gas licuado” · “GNV”, “gas natural” | GLP · GNV |
| “Primax”, “Repsol”, “Petroperú”, “Pecsa”, “Mobil”, “Shell”… | filtro de marca (varias a la vez) |
| “a 5 kilómetros” | radio (si no lo dices, se amplía solo hasta encontrar 3 grifos) |
| “más cerca” / “más cercano” | ordena por distancia en vez de precio |

## Limitaciones

- La **marca** no viene en el Excel: se deduce de la razón social (p. ej. COESTI → Primax,
  REPSOL COMERCIAL → Repsol), del nombre en Google y de OSM. Grifos con franquicia de terceros sin
  ubicación de Google pueden quedar sin marca y no salen al filtrar por marca.
- Los precios son los que cada grifo reporta a Osinergmin; algunos llevan días sin actualizarse
  (la app muestra la fecha de cada precio).
- GitHub desactiva los workflows programados si el repositorio pasa 60 días sin actividad.

## Desarrollo local

```bash
pip install -r pipeline/requirements.txt
python pipeline/build_data.py            # genera data/stations.json
python -m http.server -d app/www 8000    # probar la interfaz en el navegador
```

Para probar en local, cambia `app/www/config.js` a `dataUrl: '/stations.json'` y copia
`data/stations.json` a `app/www/` (no lo subas así; el workflow de APK reescribe `config.js`).
