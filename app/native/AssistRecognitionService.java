package pe.gasolina.voz;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.os.RemoteException;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

/**
 * Android exige que un asistente digital declare también un servicio de reconocimiento de voz,
 * y al elegir esta app como asistente lo vuelve el reconocedor por defecto del teléfono.
 * Para no romper el dictado de otras apps, este servicio solo reenvía todo al de Google.
 */
public class AssistRecognitionService extends RecognitionService {

    private SpeechRecognizer delegate;

    @Override
    protected void onStartListening(Intent recognizerIntent, final Callback callback) {
        release();
        ComponentName target = AssistantPlugin.findOtherRecognizer(this);
        if (target == null) {
            try {
                callback.error(SpeechRecognizer.ERROR_CLIENT);
            } catch (RemoteException ignored) { }
            return;
        }
        delegate = SpeechRecognizer.createSpeechRecognizer(this, target);
        delegate.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {
                try { callback.readyForSpeech(params); } catch (RemoteException ignored) { }
            }
            @Override public void onBeginningOfSpeech() {
                try { callback.beginningOfSpeech(); } catch (RemoteException ignored) { }
            }
            @Override public void onRmsChanged(float rmsdB) {
                try { callback.rmsChanged(rmsdB); } catch (RemoteException ignored) { }
            }
            @Override public void onBufferReceived(byte[] buffer) {
                try { callback.bufferReceived(buffer); } catch (RemoteException ignored) { }
            }
            @Override public void onEndOfSpeech() {
                try { callback.endOfSpeech(); } catch (RemoteException ignored) { }
            }
            @Override public void onError(int error) {
                try { callback.error(error); } catch (RemoteException ignored) { }
                release();
            }
            @Override public void onResults(Bundle results) {
                try { callback.results(results); } catch (RemoteException ignored) { }
                release();
            }
            @Override public void onPartialResults(Bundle partialResults) {
                try { callback.partialResults(partialResults); } catch (RemoteException ignored) { }
            }
            @Override public void onEvent(int eventType, Bundle params) { }
        });
        delegate.startListening(recognizerIntent);
    }

    @Override
    protected void onStopListening(Callback callback) {
        if (delegate != null) delegate.stopListening();
    }

    @Override
    protected void onCancel(Callback callback) {
        release();
    }

    @Override
    public void onDestroy() {
        release();
        super.onDestroy();
    }

    private void release() {
        if (delegate != null) {
            try {
                delegate.destroy();
            } catch (Exception ignored) { }
            delegate = null;
        }
    }
}
