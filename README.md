# Mi Asistente 🎙️ (antes Gasolina Perú)

Asistente de voz Android **local** (no depende de internet para entender ni para llamar):

| Dices | Hace |
|---|---|
| “Llama a mamá”, “llama al 987 654 321” | Busca el contacto (tolera errores de pronunciación), cuenta 3 s con botón *Cancelar* y llama directo. Si hay varios parecidos, pregunta cuál. |
| “Llévame a Plaza San Miguel”, “cómo llego a …” | Abre la ruta en Google Maps |
| “Farmacias cerca”, “dónde queda …”, “busca …” | Abre la búsqueda en Google Maps |
| “Gasohol 95 en Primax o Repsol” | Grifos cercanos más baratos (precios Osinergmin) |
| “Prende / apaga la linterna” | Linterna (sin internet) |
| “Alarma a las 6 y media”, “despiértame a las 5” | Crea la alarma en el Reloj |
| “Temporizador de 10 minutos” | Inicia el temporizador |
| “WhatsApp a Juan diciendo ya llegué” | Abre el chat con el mensaje escrito (tú tocas *Enviar*) |

### Usarla en lugar de Gemini (Samsung S24 Ultra)

La app se registra como **asistente digital** (`AssistService`, `AssistSessionService`,
`AssistRecognitionService` en `app/native/`).

1. *Ajustes → Aplicaciones → Elegir aplicaciones predeterminadas → Aplicación de asistente digital →
   Asistente digital de dispositivo* → **Mi Asistente**.
2. *Ajustes → Funciones avanzadas → Tecla lateral → Mantener presionado* → **Asistente digital**.
3. Listo: mantén presionada la tecla lateral (o el botón de inicio, o el del audífono Bluetooth) y la app
   abre escuchando, incluso con la pantalla bloqueada.

“Hey Google” no se puede reemplazar: Android reserva la palabra de activación a apps del sistema.
Para volver a Gemini, repite el paso 1 y elige Google.

### “Hola Oso” (manos libres, sin internet)

`WakeService` escucha solo la frase “hola oso” con [Vosk](https://alphacephei.com/vosk/) (modelo
`vosk-model-small-es-0.42`, ~40 MB, se descarga en el workflow) y abre el asistente; suena un bip y dices la orden.
Se activa **solo mientras el celular carga** o **conectado al Bluetooth del auto** (se elige en la app), y se
apaga al desconectar. `AssistService` vigila el cargador y el Bluetooth, por eso Mi Asistente debe ser el
asistente digital. Mientras escucha hay una notificación con *Detener*.

En Samsung conviene: *Ajustes → Batería → Límites de uso en segundo plano → Apps que nunca se suspenden →
Mi Asistente*.

La voz se reconoce **en el teléfono** (Android 12+) con el plugin nativo `app/native/AssistantPlugin.java`.
Si tu teléfono no tiene el español sin conexión, ve a *Ajustes → Google → Voz (o Asistente) →
Reconocimiento de voz sin conexión* y descarga **Español (Estados Unidos)**.

Los precios vienen del archivo oficial de Osinergmin
[`Ultimos-Precios-Registrados-EVPC.xlsx`](https://www.osinergmin.gob.pe/empresas/hidrocarburos/scop/documentos-scop),
que se actualiza a diario.

## Cómo funciona

```
Osinergmin (Excel) ──► GitHub Actions (cada 3 h) ──► data/stations.json ──► App en tu celular
                        · agrupa por grifo                                         · GPS + voz
                        · Google Places → ubicación exacta                         · filtra y ordena
                        · marca (razón social / Google / OSM)                      · lo lee en voz alta
```

| Carpeta | Contenido |
|---|---|
| `pipeline/` | Script Python que genera `data/stations.json`; `pipeline/cache/` guarda las ubicaciones ya encontradas |
| `app/` | App Capacitor (HTML/JS) → APK Android |
| `.github/workflows/` | `datos.yml` actualiza los precios cada 3 horas (6:00–21:00 Perú) · `apk.yml` compila el APK y lo publica en *Releases* |

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

## Estado y actualización manual

Arriba en la app se ve cuándo son los precios (punto verde: menos de 4 h; ámbar: menos de 24 h; rojo: más).
El botón **Actualizar** descarga el Excel directo de Osinergmin desde el celular (~1,5 MB) y aplica los
precios al momento, sin esperar a GitHub. Las ubicaciones y marcas siguen viniendo de GitHub, así que un
grifo nuevo aparece recién cuando corre el workflow.

## Actualizaciones de la app (sin reinstalar)

Cada cambio en `app/` publica en *Releases*: el APK, `www.zip` (la interfaz) y `version.json`.
Al abrir la app se revisa `version.json`:

- **Cambió solo la interfaz** (HTML/JS/CSS): la app descarga `www.zip` en segundo plano y muestra
  *"Nueva versión lista → Reiniciar"*. No hay que bajar el APK.
- **Cambió la parte nativa** (plugins, permisos, `capacitor.config.json`): hay que subir
  `gasolina.nativeLevel` en `app/package.json`; la app mostrará *"hay que reinstalar → Descargar"*.

Si una versión nueva falla al arrancar, el plugin (`@capgo/capacitor-updater`) vuelve solo a la anterior.

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
