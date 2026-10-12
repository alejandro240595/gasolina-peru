package pe.gasolina.voz;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;
import com.google.mediapipe.tasks.genai.llminference.PromptTemplates;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * IA local ("cerebro"): un modelo de lenguaje que corre en el teléfono, sin internet.
 * Modelo: Qwen 2.5 1.5B Instruct (Apache 2.0), formato MediaPipe .task, ~1,6 GB.
 * Se descarga una vez con DownloadManager y se carga en la GPU (o CPU si la GPU falla).
 */
@CapacitorPlugin(name = "Brain")
public class BrainPlugin extends Plugin {

    static final String MODEL_URL = "https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/"
        + "Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.task";
    static final String MODEL_FILE = "qwen2.5-1.5b-instruct-q8.task";
    static final long MODEL_BYTES = 1598556720L;
    static final String STOP = "<|im_end|>";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile LlmInference llm;
    private volatile String backend;
    private volatile boolean loading;
    private volatile String loadError;
    private volatile LlmInferenceSession current;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("brain", Context.MODE_PRIVATE);
    }

    private File modelFile() {
        return new File(getContext().getExternalFilesDir("models"), MODEL_FILE);
    }

    private boolean downloaded() {
        File f = modelFile();
        return f.exists() && f.length() == MODEL_BYTES;
    }

    private DownloadManager dm() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    // ------------------------------------------------------------------ estado y descarga

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject()
            .put("downloaded", downloaded())
            .put("loaded", llm != null)
            .put("loading", loading)
            .put("backend", backend)
            .put("error", loadError)
            .put("totalBytes", MODEL_BYTES);
        long id = prefs().getLong("downloadId", -1);
        if (id >= 0 && !downloaded()) {
            try (Cursor c = dm().query(new DownloadManager.Query().setFilterById(id))) {
                if (c != null && c.moveToFirst()) {
                    int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    long done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                    int reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    String state = status == DownloadManager.STATUS_RUNNING ? "running"
                        : status == DownloadManager.STATUS_PENDING ? "pending"
                        : status == DownloadManager.STATUS_PAUSED
                            ? (reason == DownloadManager.PAUSED_QUEUED_FOR_WIFI || reason == DownloadManager.PAUSED_WAITING_FOR_NETWORK
                                ? "waiting_wifi" : "paused")
                        : status == DownloadManager.STATUS_FAILED ? "failed"
                        : status == DownloadManager.STATUS_SUCCESSFUL ? "verifying" : "unknown";
                    out.put("download", new JSObject().put("state", state).put("bytes", done).put("reason", reason));
                }
            } catch (Exception ignored) { }
        }
        call.resolve(out);
    }

    /** {mobileData: false} — por defecto solo con Wi‑Fi. */
    @PluginMethod
    public void download(PluginCall call) {
        if (downloaded()) {
            call.resolve(new JSObject().put("downloaded", true));
            return;
        }
        long old = prefs().getLong("downloadId", -1);
        if (old >= 0) dm().remove(old);
        File f = modelFile();
        if (f.exists()) f.delete();
        boolean mobile = Boolean.TRUE.equals(call.getBoolean("mobileData", false));
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(MODEL_URL))
            .setTitle("Mi Asistente: IA local")
            .setDescription("Qwen 2.5 · 1,6 GB")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(getContext(), "models", MODEL_FILE)
            .setAllowedOverMetered(mobile)
            .setAllowedOverRoaming(false);
        long id = dm().enqueue(req);
        prefs().edit().putLong("downloadId", id).apply();
        call.resolve(new JSObject().put("downloadId", id));
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        long id = prefs().getLong("downloadId", -1);
        if (id >= 0) dm().remove(id);
        prefs().edit().remove("downloadId").apply();
        worker.execute(() -> {
            closeModel();
            File f = modelFile();
            if (f.exists()) f.delete();
            call.resolve();
        });
    }

    // ------------------------------------------------------------------ cargar y generar

    private void closeModel() {
        if (llm != null) {
            try {
                llm.close();
            } catch (Exception ignored) { }
            llm = null;
            backend = null;
        }
    }

    /** Carga el modelo (solo una vez). Corre en el hilo del worker. */
    private void ensureLoaded() throws Exception {
        if (llm != null) return;
        if (!downloaded()) throw new Exception("El modelo de IA no está descargado");
        loading = true;
        loadError = null;
        try {
            Exception last = null;
            for (LlmInference.Backend b : new LlmInference.Backend[] { LlmInference.Backend.GPU, LlmInference.Backend.CPU }) {
                try {
                    llm = LlmInference.createFromOptions(getContext(), LlmInference.LlmInferenceOptions.builder()
                        .setModelPath(modelFile().getAbsolutePath())
                        .setMaxTokens(2048)
                        .setMaxTopK(40)
                        .setPreferredBackend(b)
                        .build());
                    backend = b.name();
                    return;
                } catch (Exception e) {
                    last = e;
                }
            }
            loadError = last != null ? last.getMessage() : "error desconocido";
            throw new Exception("No se pudo cargar la IA: " + loadError);
        } catch (UnsatisfiedLinkError e) {
            loadError = "este teléfono no es compatible (" + e.getMessage() + ")";
            throw new Exception("No se pudo cargar la IA: " + loadError);
        } finally {
            loading = false;
        }
    }

    @PluginMethod
    public void load(PluginCall call) {
        worker.execute(() -> {
            long t0 = System.currentTimeMillis();
            try {
                ensureLoaded();
                call.resolve(new JSObject().put("backend", backend).put("ms", System.currentTimeMillis() - t0));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /**
     * {prompt, temperature} — el prompt ya viene armado en formato ChatML de Qwen (lo arma brain.js).
     * Emite eventos "token" {text} mientras genera y resuelve con {text} completo.
     */
    @PluginMethod
    public void generate(PluginCall call) {
        final String prompt = call.getString("prompt");
        if (prompt == null) {
            call.reject("Falta el prompt");
            return;
        }
        final float temperature = call.getFloat("temperature", 0.2f);
        worker.execute(() -> {
            long t0 = System.currentTimeMillis();
            LlmInferenceSession session = null;
            final StringBuilder out = new StringBuilder();
            try {
                ensureLoaded();
                // Plantillas vacías: el prompt ya trae <|im_start|>... armado a mano.
                PromptTemplates raw = PromptTemplates.builder()
                    .setUserPrefix("").setUserSuffix("")
                    .setModelPrefix("").setModelSuffix("")
                    .setSystemPrefix("").setSystemSuffix("")
                    .build();
                session = LlmInferenceSession.createFromOptions(llm,
                    LlmInferenceSession.LlmInferenceSessionOptions.builder()
                        .setTopK(20)
                        .setTemperature(temperature)
                        .setPromptTemplates(raw)
                        .build());
                current = session;
                session.addQueryChunk(prompt);
                final LlmInferenceSession s = session;
                try {
                    session.generateResponseAsync((partial, done) -> {
                        if (partial == null || partial.isEmpty()) return;
                        synchronized (out) {
                            if (out.indexOf(STOP) >= 0) return;
                            out.append(partial);
                        }
                        notifyListeners("token", new JSObject().put("text", partial));
                        if (out.indexOf(STOP) >= 0) {
                            try {
                                s.cancelGenerateResponseAsync();
                            } catch (Exception ignored) { }
                        }
                    }).get();
                } catch (Exception cancelledOrDone) {
                    // cancelar al ver <|im_end|> termina la espera con excepción: es normal
                }
                String text;
                synchronized (out) {
                    text = out.toString();
                }
                int stop = text.indexOf(STOP);
                if (stop >= 0) text = text.substring(0, stop);
                call.resolve(new JSObject().put("text", text.trim()).put("ms", System.currentTimeMillis() - t0)
                    .put("backend", backend));
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Error de la IA");
            } finally {
                current = null;
                if (session != null) {
                    try {
                        session.close();
                    } catch (Exception ignored) { }
                }
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        LlmInferenceSession s = current;
        if (s != null) {
            try {
                s.cancelGenerateResponseAsync();
            } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(this::closeModel);
        worker.shutdown();
    }
}
