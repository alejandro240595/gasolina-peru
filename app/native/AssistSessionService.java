package pe.gasolina.voz;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;

/**
 * Se ejecuta al mantener presionada la tecla lateral / botón de inicio (o el gesto de asistente):
 * abre MainActivity con la acción ASSIST para que empiece a escuchar de inmediato.
 */
public class AssistSessionService extends VoiceInteractionSessionService {

    @Override
    public VoiceInteractionSession onNewSession(Bundle args) {
        return new Session(this);
    }

    static class Session extends VoiceInteractionSession {
        Session(Context context) {
            super(context);
        }

        @Override
        public void onShow(Bundle args, int showFlags) {
            super.onShow(args, showFlags);
            Intent intent = new Intent(getContext(), MainActivity.class);
            intent.setAction(AssistantPlugin.ACTION_ASSIST_LAUNCH);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startAssistantActivity(intent);
            hide();
        }
    }
}
