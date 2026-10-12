package pe.gasolina.voz;

import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Bundle;
import android.service.voice.VoiceInteractionService;

import androidx.core.content.ContextCompat;

/**
 * Permite elegir esta app en Ajustes → Apps predeterminadas → App de asistente digital.
 * El sistema la mantiene activa mientras sea el asistente, así que aquí también se vigila
 * el cargador y el Bluetooth del auto para encender "Hola Oso" (WakeService).
 */
public class AssistService extends VoiceInteractionService {

    static volatile AssistService instance;
    private BroadcastReceiver receiver;

    @Override
    public void onReady() {
        super.onReady();
        instance = this;
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_POWER_CONNECTED);
        filter.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String a = intent.getAction();
                if (Intent.ACTION_POWER_CONNECTED.equals(a) && WakeService.prefs(context).getBoolean("charging", false)) {
                    tryStart(context, "charging");
                } else if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(a) && WakeService.prefs(context).getBoolean("car", false)
                        && isCarDevice(context, intent)) {
                    tryStart(context, "car");
                }
            }
        };
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_EXPORTED);
        if (WakeService.prefs(this).getBoolean("charging", false) && isPlugged(this)) {
            tryStart(this, "charging");
        }
    }

    @Override
    public void onShutdown() {
        if (receiver != null) {
            try {
                unregisterReceiver(receiver);
            } catch (Exception ignored) { }
            receiver = null;
        }
        instance = null;
        super.onShutdown();
    }

    /** Abre la sesión del asistente (como la tecla lateral). false si no somos el asistente. */
    static boolean launch(Context c) {
        AssistService s = instance;
        if (s == null) return false;
        try {
            s.showSession(new Bundle(), 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean isPlugged(Context c) {
        Intent battery = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        return battery != null && battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
    }

    static boolean isCarDevice(Context c, Intent intent) {
        BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
        if (device == null) return false;
        try {
            return WakeService.carDevices(c).contains(device.getAddress());
        } catch (SecurityException e) {
            return false;
        }
    }

    /** Enciende "Hola Oso"; si Android no deja iniciarlo en segundo plano, avisa para tocar y activarlo. */
    static void tryStart(Context c, String reason) {
        if (WakeService.isRunning()) return;
        try {
            WakeService.start(c, reason);
        } catch (Exception e) {
            WakeService.postTapToStart(c, reason,
                "Toca para activar la escucha " + ("car".equals(reason) ? "en el auto" : "mientras carga"));
        }
    }
}
