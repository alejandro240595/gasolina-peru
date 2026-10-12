package pe.gasolina.voz;

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
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;
import org.vosk.android.StorageService;

import java.util.HashSet;
import java.util.Set;

/**
 * "Hola Oso": escucha la palabra de activación sin internet (Vosk, modelo español pequeño) mientras
 * el teléfono carga o está conectado al Bluetooth del auto. Al oírla abre el asistente.
 * Se detiene solo al desconectar el cargador / el auto, o con el botón "Detener" de la notificación.
 */
public class WakeService extends Service implements RecognitionListener {

    static final String ACTION_START = "pe.gasolina.voz.WAKE_START";
    static final String ACTION_STOP = "pe.gasolina.voz.WAKE_STOP";
    static final String EXTRA_REASON = "reason";
    static final String PHRASE = "hola oso";
    // Gramática cerrada: solo "hola oso" o "otra cosa"; así casi no se activa por error.
    private static final String GRAMMAR = "[\"hola oso\", \"[unk]\"]";
    private static final String CHANNEL = "hola_oso";
    private static final int NOTIFICATION_ID = 7001;
    static final int TAP_NOTIFICATION_ID = 7002;
    private static final long SAFETY_RESUME_MS = 60000;

    static volatile WakeService instance;
    static volatile String reason;
    private static Model model;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable resumeRunnable = this::resumeListening;
    private SpeechService speech;
    private Recognizer recognizer;
    private boolean triggered;
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
            s.pauseListening();
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
        reason = r != null ? r : "manual";
        instance = this;
        getSystemService(NotificationManager.class).cancel(TAP_NOTIFICATION_ID);
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(),
            Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
        registerStopReceiver();
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
        // Copia el modelo (assets/model-es) al almacenamiento la primera vez; luego es instantáneo.
        StorageService.unpack(this, "model-es", "model",
            (Model m) -> {
                model = m;
                resumeListening();
            },
            (java.io.IOException e) -> stopSelf());
    }

    private boolean inCall() {
        int mode = getSystemService(AudioManager.class).getMode();
        return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
            || mode == AudioManager.MODE_RINGTONE;
    }

    private void resumeListening() {
        if (instance != this || model == null || speech != null) return;
        if (inCall()) {   // en llamada el micrófono es de la llamada; reintentar después
            handler.postDelayed(resumeRunnable, 5000);
            return;
        }
        try {
            recognizer = new Recognizer(model, 16000.0f, GRAMMAR);
            speech = new SpeechService(recognizer, 16000.0f);
            speech.startListening(this);
            triggered = false;
        } catch (Exception e) {
            pauseListening();
            handler.postDelayed(resumeRunnable, 10000);
        }
    }

    private void pauseListening() {
        if (speech != null) {
            try {
                speech.stop();
                speech.shutdown();
            } catch (Exception ignored) { }
            speech = null;
        }
        if (recognizer != null) {
            try {
                recognizer.close();
            } catch (Exception ignored) { }
            recognizer = null;
        }
    }

    private void trigger() {
        if (triggered) return;
        triggered = true;
        handler.post(() -> {
            pauseListening();
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
        });
    }

    private void check(String json, String key) {
        try {
            String text = new JSONObject(json).optString(key, "").trim();
            if (text.equals(PHRASE) || ("text".equals(key) && text.contains(PHRASE))) trigger();
        } catch (Exception ignored) { }
    }

    @Override public void onPartialResult(String hypothesis) { check(hypothesis, "partial"); }
    @Override public void onResult(String hypothesis) { check(hypothesis, "text"); }
    @Override public void onFinalResult(String hypothesis) { check(hypothesis, "text"); }
    @Override public void onError(Exception exception) {
        pauseListening();
        handler.postDelayed(resumeRunnable, 5000);
    }
    @Override public void onTimeout() {
        pauseListening();
        handler.post(resumeRunnable);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        pauseListening();
        if (stopReceiver != null) {
            try {
                unregisterReceiver(stopReceiver);
            } catch (Exception ignored) { }
            stopReceiver = null;
        }
        instance = null;
        reason = null;
        super.onDestroy();
    }
}
