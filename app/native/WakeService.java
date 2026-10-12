package pe.gasolina.voz;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.StorageService;

import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * "Hola Oso": escucha la palabra de activación sin internet (Vosk, modelo español pequeño) mientras
 * el teléfono carga o está conectado al Bluetooth del auto. Al oírla abre el asistente.
 * Se detiene solo al desconectar el cargador / el auto, o con el botón "Detener" de la notificación.
 *
 * Lee el micrófono directamente (AudioRecord) para poder medir el nivel: si Android entrega silencio
 * absoluto (micrófono bloqueado para apps en segundo plano) lo detecta y pide reactivarlo con un toque.
 */
public class WakeService extends Service {

    static final String ACTION_START = "pe.gasolina.voz.WAKE_START";
    static final String ACTION_STOP = "pe.gasolina.voz.WAKE_STOP";
    static final String EXTRA_REASON = "reason";
    // Gramática cerrada: solo estas frases u "otra cosa" ([unk]); así casi no se activa por error.
    private static final String GRAMMAR = "[\"hola oso\", \"ola oso\", \"hola osito\", \"oye oso\", \"[unk]\"]";
    private static final Pattern WAKE = Pattern.compile("\\b(hola|ola|oye) (oso|osito)\\b");
    private static final String CHANNEL = "hola_oso";
    private static final int NOTIFICATION_ID = 7001;
    static final int TAP_NOTIFICATION_ID = 7002;
    private static final int RATE = 16000;
    private static final long SAFETY_RESUME_MS = 60000;
    private static final long MUTED_AFTER_MS = 4000;

    static volatile WakeService instance;
    static volatile String reason;
    private static Model model;

    // ---- diagnóstico (lo muestra la app)
    static volatile String state = "apagado";
    static volatile int level;            // pico del último ~1 s (0-32767)
    static volatile boolean muted;        // Android entrega silencio absoluto
    static volatile String lastHeard = "";
    static volatile long lastHeardAt;     // SystemClock.elapsedRealtime()
    static volatile long lastWakeAt;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable resumeRunnable = this::resumeListening;
    private Thread loop;
    private volatile boolean looping;
    private boolean triggered;
    private boolean mutedNotified;
    private BroadcastReceiver stopReceiver;

    // ------------------------------------------------------------------ API para el resto de la app

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("wake", Context.MODE_PRIVATE);
    }

    static Set<String> carDevices(Context c) {
        return new HashSet<>(prefs(c).getStringSet("devices", new HashSet<>()));
    }

    static Intent startIntent(Context c, String reason) {
        return new Intent(c, WakeService.class).setAction(ACTION_START).putExtra(EXTRA_REASON, reason);
    }

    /** Puede lanzar excepción si Android no permite iniciar el servicio desde segundo plano. */
    static void start(Context c, String reason) {
        ContextCompat.startForegroundService(c, startIntent(c, reason));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, WakeService.class));
    }

    static boolean isRunning() {
        return instance != null;
    }

    /** La app va a usar el micrófono: soltarlo ya (se llama desde el hilo principal). */
    static void pauseForApp() {
        final WakeService s = instance;
        if (s == null) return;
        Runnable r = () -> {
            s.handler.removeCallbacks(s.resumeRunnable);
            s.pauseListening("pausado (escuchando la orden)");
        };
        if (Looper.myLooper() == Looper.getMainLooper()) r.run(); else s.handler.post(r);
    }

    /** La app terminó: volver a escuchar "Hola Oso" en un momento. */
    static void resumeLater(final long ms) {
        final WakeService s = instance;
        if (s == null) return;
        s.handler.post(() -> {
            s.handler.removeCallbacks(s.resumeRunnable);
            s.handler.postDelayed(s.resumeRunnable, ms);
        });
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Hola Oso", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Escucha la palabra de activación mientras cargas o manejas");
                nm.createNotificationChannel(ch);
            }
        }
    }

    static PendingIntent openAppIntent(Context c) {
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Notificación "toca para activar": iniciar desde una notificación sí permite usar el micrófono. */
    static void postTapToStart(Context c, String reason, String text) {
        ensureChannel(c);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent start = Build.VERSION.SDK_INT >= 26
            ? PendingIntent.getForegroundService(c, 2, startIntent(c, reason), flags)
            : PendingIntent.getService(c, 2, startIntent(c, reason), flags);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.notify(TAP_NOTIFICATION_ID, new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Hola Oso")
            .setContentText(text)
            .setContentIntent(start)
            .setAutoCancel(true)
            .build());
    }

    // ------------------------------------------------------------------ servicio

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String r = intent != null ? intent.getStringExtra(EXTRA_REASON) : null;
        reason = r != null ? r : (reason != null ? reason : "manual");
        instance = this;
        getSystemService(NotificationManager.class).cancel(TAP_NOTIFICATION_ID);
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(),
            Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
        registerStopReceiver();
        // (re)iniciar la escucha: si venía silenciada, al tocar la notificación vuelve a abrir el micrófono
        pauseListening("iniciando");
        if (model == null) loadModel(); else resumeListening();
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        ensureChannel(this);
        String when = "charging".equals(reason) ? "mientras carga"
            : "car".equals(reason) ? "mientras estás en el auto" : "hasta que lo detengas";
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, WakeService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Di «Hola Oso»")
            .setContentText("Escuchando " + when + " · sin internet")
            .setOngoing(true)
            .setContentIntent(openAppIntent(this))
            .addAction(0, "Detener", stop)
            .build();
    }

    private void registerStopReceiver() {
        if (stopReceiver != null) return;
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
        filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
        stopReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String a = intent.getAction();
                if (Intent.ACTION_POWER_DISCONNECTED.equals(a) && "charging".equals(reason)) {
                    stopSelf();
                } else if (BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(a) && "car".equals(reason)
                        && AssistService.isCarDevice(context, intent)) {
                    stopSelf();
                }
            }
        };
        ContextCompat.registerReceiver(this, stopReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
    }

    private void loadModel() {
        state = "cargando modelo de voz";
        // Copia el modelo (assets/model-es) al almacenamiento la primera vez; luego es instantáneo.
        StorageService.unpack(this, "model-es", "model",
            (Model m) -> {
                model = m;
                resumeListening();
            },
            (java.io.IOException e) -> {
                state = "error: no se pudo cargar el modelo de voz";
                stopSelf();
            });
    }

    private boolean inCall() {
        int mode = getSystemService(AudioManager.class).getMode();
        return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
            || mode == AudioManager.MODE_RINGTONE;
    }

    @SuppressLint("MissingPermission")
    private void resumeListening() {
        if (instance != this || model == null || loop != null) return;
        if (inCall()) {   // en llamada el micrófono es de la llamada; reintentar después
            state = "en llamada (espera)";
            handler.postDelayed(resumeRunnable, 5000);
            return;
        }
        final Recognizer recognizer;
        final AudioRecord rec;
        try {
            recognizer = new Recognizer(model, RATE, GRAMMAR);
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                rec.release();
                recognizer.close();
                throw new IllegalStateException("micrófono no disponible");
            }
            rec.startRecording();
        } catch (Exception e) {
            state = "error: " + e.getMessage() + " (reintento en 10 s)";
            handler.postDelayed(resumeRunnable, 10000);
            return;
        }
        triggered = false;
        muted = false;
        state = "escuchando";
        looping = true;
        loop = new Thread(() -> listenLoop(rec, recognizer), "hola-oso");
        loop.start();
    }

    private void listenLoop(AudioRecord rec, Recognizer recognizer) {
        short[] buf = new short[RATE / 10];   // 100 ms
        long lastSound = SystemClock.elapsedRealtime();
        long windowStart = lastSound;
        int windowPeak = 0;
        try {
            while (looping) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) {
                    if (n < 0) break;
                    continue;
                }
                long now = SystemClock.elapsedRealtime();
                int peak = 0;
                for (int i = 0; i < n; i++) {
                    int v = Math.abs(buf[i]);
                    if (v > peak) peak = v;
                }
                if (peak > windowPeak) windowPeak = peak;
                if (now - windowStart >= 1000) {
                    level = windowPeak;
                    windowPeak = 0;
                    windowStart = now;
                }
                if (peak > 0) lastSound = now;
                boolean silent = now - lastSound > MUTED_AFTER_MS;
                if (silent != muted) {
                    muted = silent;
                    handler.post(this::onMutedChanged);
                }
                boolean isFinal = recognizer.acceptWaveForm(buf, n);
                String json = isFinal ? recognizer.getResult() : recognizer.getPartialResult();
                check(json, isFinal ? "text" : "partial");
            }
        } catch (Exception e) {
            state = "error: " + e.getMessage();
        } finally {
            try {
                rec.stop();
            } catch (Exception ignored) { }
            rec.release();
            recognizer.close();
        }
    }

    // Silencio absoluto (todo ceros) = Android bloqueó el micrófono a la app en segundo plano.
    private void onMutedChanged() {
        if (muted) {
            state = "micrófono bloqueado por Android";
            if (!mutedNotified) {
                mutedNotified = true;
                postTapToStart(this, reason, "Android silenció el micrófono. Toca aquí para reactivar «Hola Oso».");
            }
        } else {
            state = "escuchando";
            mutedNotified = false;
            getSystemService(NotificationManager.class).cancel(TAP_NOTIFICATION_ID);
        }
    }

    private void pauseListening(String newState) {
        looping = false;
        Thread t = loop;
        loop = null;
        if (t != null) {
            try {
                t.join(500);
            } catch (InterruptedException ignored) { }
        }
        if (newState != null) state = newState;
        level = 0;
    }

    private void check(String json, String key) {
        String text;
        try {
            text = new JSONObject(json).optString(key, "").trim();
        } catch (Exception e) {
            return;
        }
        if (text.isEmpty()) return;
        if (!text.equals(lastHeard)) {
            lastHeard = text;
            lastHeardAt = SystemClock.elapsedRealtime();
        }
        if (WAKE.matcher(text).find()) {
            handler.post(this::trigger);
        }
    }

    private void trigger() {
        if (triggered) return;
        triggered = true;
        lastWakeAt = SystemClock.elapsedRealtime();
        pauseListening("abriendo el asistente");
        if (!AssistService.launch(this)) {
            Intent open = new Intent(this, MainActivity.class)
                .setAction(AssistantPlugin.ACTION_ASSIST_LAUNCH)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            try {
                startActivity(open);
            } catch (Exception ignored) { }
        }
        // si la app no avisa que terminó, volver a escuchar igual
        handler.postDelayed(resumeRunnable, SAFETY_RESUME_MS);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        pauseListening("apagado");
        if (stopReceiver != null) {
            try {
                unregisterReceiver(stopReceiver);
            } catch (Exception ignored) { }
            stopReceiver = null;
        }
        getSystemService(NotificationManager.class).cancel(TAP_NOTIFICATION_ID);
        instance = null;
        reason = null;
        muted = false;
        super.onDestroy();
    }
}
