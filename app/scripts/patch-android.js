// Ajusta el proyecto Android generado por `cap add android`:
//  - permisos de GPS, micrófono, contactos y llamadas
//  - <queries> que Android 11+ necesita para encontrar los servicios de voz
//  - copia el plugin nativo del asistente (app/native) y lo registra en MainActivity
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..');
const mainDir = path.join(appDir, 'android', 'app', 'src', 'main');
const javaDir = path.join(mainDir, 'java', 'pe', 'gasolina', 'voz');

// ------------------------------------------------------------------ manifest
const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
let xml = fs.readFileSync(manifestPath, 'utf8');

const permissions = [
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.READ_CONTACTS" />',
  '<uses-permission android:name="android.permission.CALL_PHONE" />',
  '<uses-feature android:name="android.hardware.location.gps" android:required="false" />',
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
  '<uses-feature android:name="android.hardware.telephony" android:required="false" />',
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
    </queries>
`;

const missing = permissions.filter((p) => !xml.includes(p.match(/android:name="([^"]+)"/)[1]));
if (missing.length) {
  xml = xml.replace('</manifest>', '    ' + missing.join('\n    ') + '\n</manifest>');
}
if (!xml.includes('<queries>')) {
  xml = xml.replace('</manifest>', queries + '</manifest>');
}
fs.writeFileSync(manifestPath, xml);
console.log('AndroidManifest actualizado:', missing.length, 'permisos añadidos');

// ------------------------------------------------------------------ plugin nativo
const nativeDir = path.join(appDir, 'native');
if (fs.existsSync(javaDir) && fs.existsSync(nativeDir)) {
  const plugins = fs.readdirSync(nativeDir).filter((f) => f.endsWith('.java'));
  plugins.forEach((f) => fs.copyFileSync(path.join(nativeDir, f), path.join(javaDir, f)));

  const register = plugins
    .map((f) => `        registerPlugin(${path.basename(f, '.java')}.class);`)
    .join('\n');
  fs.writeFileSync(path.join(javaDir, 'MainActivity.java'), `package pe.gasolina.voz;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
${register}
        super.onCreate(savedInstanceState);
    }
}
`);
  console.log('Plugins nativos registrados:', plugins.join(', '));
}
