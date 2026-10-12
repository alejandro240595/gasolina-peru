// Ajusta el proyecto Android generado por `cap add android`:
//  - permisos de GPS, micrófono, contactos, llamadas y alarmas
//  - <queries> que Android 11+ necesita para encontrar los servicios de voz
//  - servicios para que la app pueda ser el "asistente digital" del teléfono
//  - copia el código nativo (app/native) y registra los plugins en MainActivity
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..');
const mainDir = path.join(appDir, 'android', 'app', 'src', 'main');
const javaDir = path.join(mainDir, 'java', 'pe', 'gasolina', 'voz');
const nativeDir = path.join(appDir, 'native');

// ------------------------------------------------------------------ manifest
const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
let xml = fs.readFileSync(manifestPath, 'utf8');

const permissions = [
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.READ_CONTACTS" />',
  '<uses-permission android:name="android.permission.CALL_PHONE" />',
  '<uses-permission android:name="com.android.alarm.permission.SET_ALARM" />',
  '<uses-feature android:name="android.hardware.location.gps" android:required="false" />',
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
  '<uses-feature android:name="android.hardware.telephony" android:required="false" />',
  '<uses-feature android:name="android.hardware.camera.flash" android:required="false" />',
];
const queries = `
    <queries>
        <intent><action android:name="android.speech.RecognitionService" /></intent>
        <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
        </intent>
        <intent>
            <action android:name="android.intent.action.DIAL" />
            <data android:scheme="tel" />
        </intent>
        <intent><action android:name="android.intent.action.SET_ALARM" /></intent>
        <intent><action android:name="android.intent.action.SET_TIMER" /></intent>
        <package android:name="com.whatsapp" />
        <package android:name="com.whatsapp.w4b" />
    </queries>
`;
// Abrir la app desde la tecla lateral / botón de inicio / audífono Bluetooth
const assistFilter = `
            <intent-filter>
                <action android:name="android.intent.action.ASSIST" />
                <action android:name="android.intent.action.VOICE_COMMAND" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>`;
const services = `
        <service
            android:name=".AssistService"
            android:exported="true"
            android:label="@string/app_name"
            android:permission="android.permission.BIND_VOICE_INTERACTION">
            <meta-data android:name="android.voice_interaction" android:resource="@xml/voice_interaction_service" />
            <intent-filter>
                <action android:name="android.service.voice.VoiceInteractionService" />
            </intent-filter>
        </service>
        <service
            android:name=".AssistSessionService"
            android:exported="true"
            android:permission="android.permission.BIND_VOICE_INTERACTION" />
        <service
            android:name=".AssistRecognitionService"
            android:exported="true"
            android:label="@string/app_name">
            <intent-filter>
                <action android:name="android.speech.RecognitionService" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <meta-data android:name="android.speech" android:resource="@xml/recognition_service" />
        </service>
`;

const missing = permissions.filter((p) => !xml.includes(p.match(/android:name="([^"]+)"/)[1]));
if (missing.length) {
  xml = xml.replace('</manifest>', '    ' + missing.join('\n    ') + '\n</manifest>');
}
if (!xml.includes('<queries>')) {
  xml = xml.replace('</manifest>', queries + '</manifest>');
}
if (!xml.includes('android.intent.action.ASSIST')) {
  // después del intent-filter MAIN/LAUNCHER de MainActivity
  const launcher = xml.indexOf('android.intent.category.LAUNCHER');
  const end = xml.indexOf('</intent-filter>', launcher) + '</intent-filter>'.length;
  if (launcher < 0) throw new Error('No se encontró el intent-filter LAUNCHER en el manifest');
  xml = xml.slice(0, end) + assistFilter + xml.slice(end);
}
if (fs.existsSync(path.join(nativeDir, 'AssistService.java')) && !xml.includes('.AssistService')) {
  xml = xml.replace('</application>', services + '    </application>');
}
fs.writeFileSync(manifestPath, xml);
console.log('AndroidManifest actualizado:', missing.length, 'permisos añadidos');

// ------------------------------------------------------------------ código y recursos nativos
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach((e) => {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  });
}

if (fs.existsSync(javaDir) && fs.existsSync(nativeDir)) {
  const javaFiles = fs.readdirSync(nativeDir).filter((f) => f.endsWith('.java'));
  javaFiles.forEach((f) => fs.copyFileSync(path.join(nativeDir, f), path.join(javaDir, f)));
  if (fs.existsSync(path.join(nativeDir, 'res'))) copyDir(path.join(nativeDir, 'res'), path.join(mainDir, 'res'));

  const plugins = javaFiles.filter((f) => f.endsWith('Plugin.java')).map((f) => path.basename(f, '.java'));
  const register = plugins.map((p) => `        registerPlugin(${p}.class);`).join('\n');
  fs.writeFileSync(path.join(javaDir, 'MainActivity.java'), `package pe.gasolina.voz;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
${register}
        super.onCreate(savedInstanceState);
        showOverLockScreen(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        showOverLockScreen(intent);
    }

    // Abierta como asistente (tecla lateral) con el teléfono bloqueado: mostrarse encima del bloqueo.
    private void showOverLockScreen(Intent intent) {
        if (Build.VERSION.SDK_INT >= 27 && AssistantPlugin.isAssist(intent)) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(false);
    }
}
`);
  console.log('Código nativo copiado; plugins registrados:', plugins.join(', '));
}
