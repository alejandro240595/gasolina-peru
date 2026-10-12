package pe.gasolina.voz;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.ContactsContract;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Funciones locales del asistente (sin internet):
 *  - listen(): reconocimiento de voz en el dispositivo cuando está disponible (Android 12+)
 *  - getContacts(): nombres y números de la agenda
 *  - call(): llamada directa
 */
@CapacitorPlugin(
    name = "Assistant",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }),
        @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE })
    }
)
public class AssistantPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private PluginCall listenCall;

    // ------------------------------------------------------------------ voz

    @PluginMethod
    public void listen(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneCallback");
            return;
        }
        startListening(call);
    }

    @PermissionCallback
    private void microphoneCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startListening(call);
        } else {
            call.reject("Permiso de micrófono denegado", "permission");
        }
    }

    private void startListening(PluginCall call) {
        final String language = call.getString("language", "es-PE");
        final boolean wantOnDevice = Boolean.TRUE.equals(call.getBoolean("onDevice", true));

        getActivity().runOnUiThread(() -> {
            destroyRecognizer();
            if (listenCall != null) {
                listenCall.reject("Interrumpido", "cancelled");
            }
            boolean onDevice = wantOnDevice && Build.VERSION.SDK_INT >= 31
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext());
            if (!onDevice && !SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("Este teléfono no tiene reconocimiento de voz", "unavailable");
                return;
            }
            recognizer = onDevice
                ? SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext())
                : SpeechRecognizer.createSpeechRecognizer(getContext());
            listenCall = call;
            final boolean usedOnDevice = onDevice;

            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {
                    notifyListeners("state", new JSObject().put("state", "ready"));
                }
                @Override public void onBeginningOfSpeech() {
                    notifyListeners("state", new JSObject().put("state", "speaking"));
                }
                @Override public void onRmsChanged(float rmsdB) {
                    notifyListeners("level", new JSObject().put("value", rmsdB));
                }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() {
                    notifyListeners("state", new JSObject().put("state", "processing"));
                }
                @Override public void onError(int error) {
                    PluginCall c = listenCall;
                    listenCall = null;
                    destroyRecognizer();
                    if (c != null) c.reject(errorMessage(error), String.valueOf(error));
                }
                @Override public void onResults(Bundle results) {
                    PluginCall c = listenCall;
                    listenCall = null;
                    JSArray matches = new JSArray();
                    ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (list != null) for (String s : list) matches.put(s);
                    destroyRecognizer();
                    if (c != null) {
                        c.resolve(new JSObject().put("matches", matches).put("onDevice", usedOnDevice));
                    }
                }
                @Override public void onPartialResults(Bundle partial) {
                    ArrayList<String> list = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (list != null && !list.isEmpty()) {
                        notifyListeners("partial", new JSObject().put("text", list.get(0)));
                    }
                }
                @Override public void onEvent(int eventType, Bundle params) { }
            });

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
            recognizer.startListening(intent);
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    @PluginMethod
    public void cancelListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            PluginCall c = listenCall;
            listenCall = null;
            destroyRecognizer();
            if (c != null) c.reject("Cancelado", "cancelled");
            call.resolve();
        });
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.cancel();
                recognizer.destroy();
            } catch (Exception ignored) { }
            recognizer = null;
        }
    }

    private static String errorMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH: return "No entendí, intenta de nuevo";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "No escuché nada";
            case SpeechRecognizer.ERROR_AUDIO: return "Error del micrófono";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "Falta permiso de micrófono";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
                return "El reconocimiento de voz necesita internet; descarga el idioma español sin conexión";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "El reconocimiento de voz está ocupado";
            case 12: /* ERROR_LANGUAGE_NOT_SUPPORTED */
            case 13: /* ERROR_LANGUAGE_UNAVAILABLE */
                return "Idioma no disponible sin conexión";
            default: return "Error de reconocimiento de voz (" + error + ")";
        }
    }

    @Override
    protected void handleOnDestroy() {
        destroyRecognizer();
    }

    // ------------------------------------------------------------------ contactos

    @PluginMethod
    public void getContacts(PluginCall call) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            requestPermissionForAlias("contacts", call, "contactsCallback");
            return;
        }
        readContacts(call);
    }

    @PermissionCallback
    private void contactsCallback(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) {
            readContacts(call);
        } else {
            call.reject("Permiso de contactos denegado", "permission");
        }
    }

    private void readContacts(PluginCall call) {
        getBridge().execute(() -> {
            JSArray out = new JSArray();
            ContentResolver resolver = getContext().getContentResolver();
            String[] projection = {
                ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
                ContactsContract.CommonDataKinds.Phone.TYPE,
                ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY,
                ContactsContract.CommonDataKinds.Phone.STARRED
            };
            try (Cursor c = resolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    projection, null, null, null)) {
                if (c != null) {
                    while (c.moveToNext()) {
                        String name = c.getString(1);
                        String number = c.getString(2);
                        if (name == null || number == null) continue;
                        JSObject o = new JSObject();
                        o.put("id", c.getString(0));
                        o.put("name", name);
                        o.put("number", number);
                        o.put("type", phoneType(c.getInt(3)));
                        o.put("primary", c.getInt(4) == 1);
                        o.put("starred", c.getInt(5) == 1);
                        out.put(o);
                    }
                }
                call.resolve(new JSObject().put("contacts", out));
            } catch (Exception e) {
                call.reject("No se pudieron leer los contactos: " + e.getMessage());
            }
        });
    }

    private static String phoneType(int type) {
        switch (type) {
            case ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE: return "mobile";
            case ContactsContract.CommonDataKinds.Phone.TYPE_HOME: return "home";
            case ContactsContract.CommonDataKinds.Phone.TYPE_WORK:
            case ContactsContract.CommonDataKinds.Phone.TYPE_WORK_MOBILE: return "work";
            default: return "other";
        }
    }

    // ------------------------------------------------------------------ llamadas

    @PluginMethod
    public void call(PluginCall call) {
        if (call.getString("number") == null) {
            call.reject("Falta el número");
            return;
        }
        if (getPermissionState("phone") != PermissionState.GRANTED) {
            requestPermissionForAlias("phone", call, "phoneCallback");
            return;
        }
        placeCall(call, Intent.ACTION_CALL);
    }

    @PermissionCallback
    private void phoneCallback(PluginCall call) {
        // Sin permiso de llamadas se abre el marcador con el número puesto.
        placeCall(call, getPermissionState("phone") == PermissionState.GRANTED ? Intent.ACTION_CALL : Intent.ACTION_DIAL);
    }

    private void placeCall(PluginCall call, String action) {
        Intent intent = new Intent(action, Uri.parse("tel:" + Uri.encode(call.getString("number"))));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("direct", Intent.ACTION_CALL.equals(action)));
        } catch (ActivityNotFoundException | SecurityException e) {
            call.reject("No se pudo llamar: " + e.getMessage());
        }
    }
}
