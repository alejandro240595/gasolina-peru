// Actualizaciones sin reinstalar (OTA): la interfaz (esta carpeta www) se descarga desde
// GitHub Releases y se aplica al reiniciar. Si cambia la parte nativa (permisos, plugins),
// nativeLevel sube y se pide descargar el APK nuevo.
(function (root) {
  'use strict';

  var Plugins = (root.Capacitor && root.Capacitor.Plugins) || {};
  var running = null;          // revisión en curso (evita dos descargas a la vez)
  var downloaded = {};         // versión -> bundle ya descargado en esta sesión

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

  // handlers.onNative(manifest): hace falta APK nuevo
  // handlers.onReady(apply, manifest): interfaz nueva descargada
  // Devuelve una promesa con el resultado: 'native' | 'ready' | 'current' | 'unavailable'
  function check(handlers) {
    var cfg = root.GAS_CONFIG || {};
    var Updater = Plugins.CapacitorUpdater;
    if (!Updater || !Plugins.CapacitorHttp || !cfg.updateUrl) return Promise.resolve('unavailable');
    if (running) return running;
    // Confirma que esta versión arrancó bien; si no se llama, el plugin vuelve a la anterior.
    Updater.notifyAppReady().catch(function () {});

    var nativeLevel = Plugins.App ? Plugins.App.getInfo().then(function (i) { return Number(i.build) || 0; })
                                  : Promise.resolve(0);
    running = Promise.all([fetchManifest(cfg.updateUrl), nativeLevel])
      .then(function (r) {
        var manifest = r[0], installedNative = r[1];
        if (manifest.nativeLevel > installedNative) { handlers.onNative(manifest); return 'native'; }
        if (!newer(manifest.version, cfg.version)) return 'current';
        var ready = downloaded[manifest.version]
          ? Promise.resolve(downloaded[manifest.version])
          : Updater.download({ url: manifest.zip, version: manifest.version, checksum: manifest.checksum || '' });
        return ready.then(function (bundle) {
          downloaded[manifest.version] = bundle;
          handlers.onReady(function () { return Updater.set({ id: bundle.id }); }, manifest);
          return 'ready';
        });
      })
      .then(function (result) { running = null; return result; },
            function (err) { running = null; throw err; });
    return running;
  }

  root.GasUpdater = { check: check, newer: newer };
})(this);
