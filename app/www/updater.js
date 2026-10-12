// Actualizaciones sin reinstalar (OTA): la interfaz (esta carpeta www) se descarga desde
// GitHub Releases y se aplica al reiniciar. Si cambia la parte nativa (permisos, plugins),
// nativeLevel sube y se pide descargar el APK nuevo.
(function (root) {
  'use strict';

  var Plugins = (root.Capacitor && root.Capacitor.Plugins) || {};

  function fetchManifest(url) {
    return Plugins.CapacitorHttp.request({ method: 'GET', url: url + '?t=' + Date.now(), responseType: 'text',
                                           connectTimeout: 15000, readTimeout: 15000 })
      .then(function (res) {
        if (res.status !== 200) throw new Error('version.json respondió ' + res.status);
        return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      });
  }

  function newer(a, b) {   // ¿versión a > b? (formato 1.2.3)
    var x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    }
    return false;
  }

  // onNative(manifest): hace falta APK nuevo · onReady(apply, manifest): interfaz nueva descargada
  function check(onNative, onReady) {
    var cfg = root.GAS_CONFIG || {};
    var Updater = Plugins.CapacitorUpdater;
    if (!Updater || !Plugins.CapacitorHttp || !cfg.updateUrl) return Promise.resolve();
    // Confirma que esta versión arrancó bien; si no se llama, el plugin vuelve a la anterior.
    Updater.notifyAppReady().catch(function () {});

    var nativeLevel = Plugins.App ? Plugins.App.getInfo().then(function (i) { return Number(i.build) || 0; })
                                  : Promise.resolve(0);
    return Promise.all([fetchManifest(cfg.updateUrl), nativeLevel])
      .then(function (r) {
        var manifest = r[0], installedNative = r[1];
        if (manifest.nativeLevel > installedNative) { onNative(manifest); return; }
        if (!newer(manifest.version, cfg.version)) return;
        return Updater.download({ url: manifest.zip, version: manifest.version })
          .then(function (bundle) {
            onReady(function () { return Updater.set({ id: bundle.id }); }, manifest);
          });
      })
      .catch(function (err) { console.warn('Sin actualización:', err && err.message); });
  }

  root.GasUpdater = { check: check, newer: newer };
})(this);
