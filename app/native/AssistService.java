package pe.gasolina.voz;

import android.service.voice.VoiceInteractionService;

/**
 * Permite elegir esta app en Ajustes → Apps predeterminadas → App de asistente digital.
 * El sistema la mantiene activa; la sesión (AssistSessionService) abre la app escuchando.
 */
public class AssistService extends VoiceInteractionService {
}
