// Añade al AndroidManifest los permisos de GPS y micrófono, y las <queries> que Android 11+
// necesita para encontrar los servicios de reconocimiento y síntesis de voz.
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
let xml = fs.readFileSync(manifestPath, 'utf8');

const permissions = [
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-feature android:name="android.hardware.location.gps" android:required="false" />',
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
];
const queries = `
    <queries>
        <intent><action android:name="android.speech.RecognitionService" /></intent>
        <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
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
