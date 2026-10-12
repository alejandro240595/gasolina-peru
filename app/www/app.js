(function () {
  'use strict';

  var Plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var FUEL_GROUPS = GasParser.FUEL_GROUPS;
  var BRANDS = ['Primax', 'Repsol', 'Petroperú', 'Pecsa', 'Mobil', 'Shell', 'Terpel', 'Puma'];
  var AUTO_RADII = [3, 5, 10, 20, 50, 100];
  var MAX_RESULTS = 10;
  var DATA_MAX_AGE_MS = 1 * 3600 * 1000;
  var MIN_LOADING_MS = 700;   // que la animación se alcance a ver aunque la búsqueda sea instantánea

  var data = null;
  var dataSavedAt = 0;
  var position = null;
  var state = { fuel: '', brands: [], radiusKm: null, sort: 'price' };

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ almacenamiento local

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* sin espacio o bloqueado */ }
  }
  function recall(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  // ------------------------------------------------------------ datos

  function loadData() {
    if (!data) {
      var cached = recall('stations');
      if (cached && cached.data) {
        data = cached.data;
        dataSavedAt = cached.savedAt;
        showDataStatus();
      }
    }
    if (data && Date.now() - dataSavedAt < DATA_MAX_AGE_MS) return Promise.resolve();
    $('data-status').classList.add('refreshing');
    return fetch(window.GAS_CONFIG.dataUrl, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        data = json;
        dataSavedAt = Date.now();
        store('stations', { savedAt: dataSavedAt, data: json });
        showDataStatus();
      })
      .catch(function (err) {
        if (!data) $('data-status').textContent = 'No se pudieron cargar los precios (' + err.message + ').';
      })
      .then(function () { $('data-status').classList.remove('refreshing'); });
  }

  function showDataStatus() {
    var m = data.meta;
    var when = m.source_modified ? new Date(m.source_modified) : new Date(m.generated);
    $('data-status').textContent = m.count.toLocaleString('es-PE') + ' grifos · precios Osinergmin del ' +
      when.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' }) + ' ' +
      when.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
  }

  // ------------------------------------------------------------ ubicación

  function getPosition() {
    if (Plugins.Geolocation) {
      return Plugins.Geolocation.checkPermissions()
        .then(function (p) {
          if (p.location === 'granted') return p;
          return Plugins.Geolocation.requestPermissions({ permissions: ['location'] });
        })
        .then(function () {
          return Plugins.Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
        })
        .then(savePosition);
    }
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('Sin GPS'));
      navigator.geolocation.getCurrentPosition(function (p) { resolve(savePosition(p)); }, reject,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
  }

  function savePosition(p) {
    position = { lat: p.coords.latitude, lng: p.coords.longitude };
    return position;
  }

  function distanceKm(lat1, lng1, lat2, lng2) {
    var r = Math.PI / 180;
    var a = Math.pow(Math.sin((lat2 - lat1) * r / 2), 2) +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.pow(Math.sin((lng2 - lng1) * r / 2), 2);
    return 12742 * Math.asin(Math.sqrt(a));
  }

  // ------------------------------------------------------------ voz

  function speak(text) {
    if (Plugins.TextToSpeech) {
      return Plugins.TextToSpeech.stop().catch(function () {}).then(function () {
        return Plugins.TextToSpeech.speak({ text: text, lang: 'es-PE', rate: 1.0, category: 'playback' })
          .catch(function () { return Plugins.TextToSpeech.speak({ text: text, lang: 'es-ES', rate: 1.0 }); });
      }).catch(function () {});
    }
    if (window.speechSynthesis) {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-PE';
      speechSynthesis.speak(u);
    }
    return Promise.resolve();
  }

  function listen() {
    if (Plugins.SpeechRecognition) {
      var SR = Plugins.SpeechRecognition;
      return SR.available()
        .then(function (r) {
          if (!r.available) throw new Error('El reconocimiento de voz no está disponible en este teléfono');
          return SR.checkPermissions();
        })
        .then(function (p) {
          if (p.speechRecognition === 'granted') return p;
          return SR.requestPermissions();
        })
        .then(function (p) {
          if (p.speechRecognition !== 'granted') throw new Error('Permiso de micrófono denegado');
          return SR.start({ language: 'es-PE', maxResults: 5, prompt: 'Combustible y marcas…', partialResults: false, popup: true });
        })
        .then(function (r) { return (r && r.matches) || []; });
    }
    var Web = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Web) return Promise.reject(new Error('Este navegador no reconoce voz; escribe la búsqueda.'));
    return new Promise(function (resolve, reject) {
      var rec = new Web();
      rec.lang = 'es-PE';
      rec.maxAlternatives = 5;
      rec.onresult = function (e) {
        var alts = [];
        for (var i = 0; i < e.results[0].length; i++) alts.push(e.results[0][i].transcript);
        resolve(alts);
      };
      rec.onerror = function (e) { reject(new Error(e.error)); };
      rec.onend = function () { resolve([]); };
      rec.start();
    });
  }

  function onMic() {
    var mic = $('mic');
    if (mic.classList.contains('listening')) return;
    mic.classList.add('listening');
    // pedir la ubicación mientras el usuario habla
    var pos = getPosition().catch(function () { return null; });
    listen()
      .then(function (matches) {
        mic.classList.remove('listening');
        if (!matches.length) return;
        // la primera alternativa en la que se reconozca un combustible
        var best = matches[0], parsed = GasParser.parseCommand(best);
        for (var i = 0; i < matches.length && !parsed.fuel; i++) {
          var p = GasParser.parseCommand(matches[i]);
          if (p.fuel) { best = matches[i]; parsed = p; }
        }
        handleCommand(best, parsed, pos);
      })
      .catch(function (err) {
        mic.classList.remove('listening');
        showMessage(err.message || String(err));
      });
  }

  function handleCommand(text, parsed, posPromise) {
    $('heard').hidden = false;
    $('heard').textContent = '“' + text + '”';
    if (parsed.fuel) state.fuel = parsed.fuel;
    if (parsed.brands.length || parsed.anyBrand) state.brands = parsed.brands;
    if (parsed.radiusKm) state.radiusKm = parsed.radiusKm;
    state.sort = parsed.sort;
    syncControls();
    if (!state.fuel) {
      var msg = 'No entendí el combustible. Di, por ejemplo: gasohol noventa y cinco en Primax.';
      showMessage(msg);
      speak(msg);
      return;
    }
    runSearch(posPromise || getPosition(), true);
  }

  // ------------------------------------------------------------ búsqueda

  var searchId = 0;

  function runSearch(posPromise, talk) {
    if (!state.fuel) { showMessage('Elige un combustible.'); return; }
    var id = ++searchId;
    var started = Date.now();
    var current = function () { return id === searchId; };   // ignora búsquedas ya reemplazadas

    var stale = !data || Date.now() - dataSavedAt >= DATA_MAX_AGE_MS;
    setLoading(stale ? 'Actualizando precios…' : 'Ubicándote…', stale ? 0 : 1);
    (stale ? loadData() : Promise.resolve())
      .then(function () {
        if (!data) throw new Error('No se pudieron cargar los precios. Revisa tu conexión.');
        if (current()) setLoading('Ubicándote…', 1);
        return posPromise || (position ? position : getPosition());
      })
      .then(function (pos) {
        pos = pos || position;
        if (!pos) throw new Error('Activa el GPS para buscar grifos cercanos.');
        if (current()) setLoading('Buscando grifos…', 2);
        var out = search(pos);
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(out); }, Math.max(0, MIN_LOADING_MS - (Date.now() - started)));
        });
      })
      .then(function (out) {
        if (!current()) return;
        render(out);
        if (talk) speak(sentence(out));
      })
      .catch(function (err) {
        if (!current()) return;
        var msg = err.message || 'No se pudo obtener tu ubicación.';
        $('results').innerHTML = '';
        showMessage(msg);
        if (talk) speak(msg);
      });
  }

  var STEPS = ['Precios', 'Ubicación', 'Grifos'];

  function setLoading(text, step) {
    var summary = $('summary');
    summary.hidden = false;
    summary.className = 'summary loading';
    summary.innerHTML =
      '<span class="pump" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M3 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7h1a2 2 0 0 1 2 2v3a1 1 0 0 0 2 0V9.4l-2.7-2.7 1.4-1.4 3.3 3.3V17a3 3 0 0 1-6 0v-3h-1v7H3zm3-15v5h5V6H6z"/></svg>' +
      '<i class="drop"></i></span>' +
      '<span class="loading-body"><span class="loading-text"></span>' +
      '<span class="steps"></span><span class="bar"><span></span></span></span>';
    summary.querySelector('.loading-text').textContent = text;
    var steps = summary.querySelector('.steps');
    STEPS.forEach(function (name, i) {
      var s = document.createElement('span');
      s.textContent = (i < step ? '✓ ' : '') + name;
      s.className = i < step ? 'done' : i === step ? 'active' : '';
      steps.appendChild(s);
    });

    var ol = $('results');
    if (!ol.querySelector('.skeleton')) {
      ol.innerHTML = '';
      for (var i = 0; i < 3; i++) {
        var li = document.createElement('li');
        li.className = 'station skeleton';
        li.innerHTML = '<span class="sk sk-title"></span><span class="sk sk-price"></span>' +
          '<span class="sk sk-line"></span><span class="sk sk-line short"></span>';
        li.style.animationDelay = (i * 120) + 'ms';
        ol.appendChild(li);
      }
    }
  }

  function search(pos) {
    var keys = FUEL_GROUPS[state.fuel].keys;
    var wanted = state.brands;
    var candidates = [];
    data.stations.forEach(function (s) {
      if (wanted.length && wanted.indexOf(s.b) < 0) return;
      var best = null, bestKey = null;
      keys.forEach(function (k) {
        if (s.f[k] && (!best || s.f[k][0] < best[0])) { best = s.f[k]; bestKey = k; }
      });
      if (!best) return;
      candidates.push({ s: s, price: best[0], date: best[1], key: bestKey,
                        km: distanceKm(pos.lat, pos.lng, s.lat, s.lng) });
    });

    var radius = state.radiusKm, list = [];
    if (radius) {
      list = candidates.filter(function (c) { return c.km <= radius; });
    } else {
      for (var i = 0; i < AUTO_RADII.length; i++) {
        radius = AUTO_RADII[i];
        list = candidates.filter(function (c) { return c.km <= radius; });
        if (list.length >= 3) break;
      }
    }
    list.sort(state.sort === 'distance'
      ? function (a, b) { return a.km - b.km; }
      : function (a, b) { return a.price - b.price || a.km - b.km; });
    return { list: list.slice(0, MAX_RESULTS), total: list.length, radius: radius };
  }

  // ------------------------------------------------------------ resultados

  function stationName(s) {
    var name = s.gn || s.n;
    return s.b && name.toLowerCase().indexOf(s.b.toLowerCase()) < 0 ? s.b + ' · ' + name : name;
  }

  function money(v) { return 'S/ ' + v.toFixed(2); }
  function unitOf(key) { return (data.meta.fuels[key] || {}).unit === 'm3' ? 'm³' : 'gal'; }

  function render(out) {
    var ol = $('results');
    ol.innerHTML = '';
    var fuelLabel = FUEL_GROUPS[state.fuel].label;
    var brandsLabel = state.brands.length ? ' en ' + state.brands.join(' / ') : '';
    showMessage(out.total
      ? out.total + ' grifos con ' + fuelLabel + brandsLabel + ' a menos de ' + out.radius + ' km'
      : 'No hay grifos con ' + fuelLabel + brandsLabel + ' a menos de ' + out.radius + ' km.');

    out.list.forEach(function (c, idx) {
      var s = c.s;
      var li = document.createElement('li');
      li.className = 'station appear';
      li.style.animationDelay = Math.min(idx, 6) * 60 + 'ms';
      var approx = s.q === 'c';
      li.innerHTML =
        '<div><div class="name"></div><div class="meta"></div></div>' +
        '<div class="price"></div><div class="addr"></div>' +
        '<button class="go" type="button">Cómo llegar</button>';
      li.querySelector('.name').textContent = stationName(s);
      if (s.b) li.querySelector('.name').classList.add('brand-' + s.b.toLowerCase());
      var meta = li.querySelector('.meta');
      meta.textContent = (approx ? '~' : '') + formatKm(c.km) + ' · ' +
        ((data.meta.fuels[c.key] || {}).label || '') + ' · act. ' + c.date.split('-').reverse().slice(0, 2).join('/');
      if (approx) {
        var tag = document.createElement('span');
        tag.className = 'approx';
        tag.textContent = ' · ubicación aproximada';
        meta.appendChild(tag);
      }
      li.querySelector('.price').innerHTML = money(c.price) + ' <small>/' + unitOf(c.key) + '</small>';
      li.querySelector('.addr').textContent = s.a + ' — ' + s.d;
      li.querySelector('.go').addEventListener('click', function () { navigate(s); });
      ol.appendChild(li);
    });
  }

  function formatKm(k) {
    return k < 1 ? Math.round(k * 1000 / 10) * 10 + ' m' : k.toFixed(1).replace('.', ',') + ' km';
  }

  function navigate(s) {
    var dest = s.q === 'c'
      ? encodeURIComponent(s.a + ', ' + s.d + ', ' + s.p + ', Perú')
      : s.lat + ',' + s.lng;
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + dest;
    if (Plugins.AppLauncher) Plugins.AppLauncher.openUrl({ url: url });
    else window.open(url, '_blank');
  }

  // ------------------------------------------------------------ texto hablado

  var ABBREVIATIONS = [
    [/\bAV(DA)?\.?\s/g, 'avenida '], [/\bJR\.?\s/g, 'jirón '], [/\bCA(L|LLE)?\.?\s/g, 'calle '],
    [/\bPROL(ONG)?\.?\s/g, 'prolongación '], [/\bCARR?\.?\s/g, 'carretera '], [/\bPSJE?\.?\s/g, 'pasaje '],
    [/\bMZ\.?\s/g, 'manzana '], [/\bLT\.?\s/g, 'lote '], [/\bN[°º]\s?/g, 'número '], [/\bKM\.?\s/g, 'kilómetro '],
    [/\bS\/N\b/g, 'sin número'], [/\bESQ\.?\s/g, 'esquina '], [/\bURB\.?\s/g, 'urbanización ']
  ];

  function spokenAddress(s) {
    var a = s.a.split(/[,(]/)[0].toUpperCase() + ' ';
    ABBREVIATIONS.forEach(function (r) { a = a.replace(r[0], r[1]); });
    a = a.trim().toLowerCase();
    if (a.length > 70) a = a.slice(0, 70).replace(/\s\S*$/, '');
    return a;
  }

  function spokenPrice(v) {
    var soles = Math.floor(v), cents = Math.round((v - soles) * 100);
    return soles + ' soles' + (cents ? ' con ' + cents : '');
  }

  function spokenKm(k) {
    return k < 1 ? Math.round(k * 10) * 100 + ' metros' : k.toFixed(1).replace('.0', '').replace('.', ' coma ') + ' kilómetros';
  }

  function sentence(out) {
    var fuel = FUEL_GROUPS[state.fuel].label.replace(/\(.*\)/, '').trim();
    var brands = state.brands.length ? ' ' + state.brands.join(' o ') : '';
    if (!out.total) return 'No encontré grifos' + brands + ' con ' + fuel + ' a menos de ' + out.radius + ' kilómetros.';
    var parts = ['Encontré ' + out.total + ' grifos' + brands + ' con ' + fuel + ' a menos de ' + out.radius + ' kilómetros.'];
    var ordinal = ['El ' + (state.sort === 'distance' ? 'más cercano' : 'más barato'), 'Luego', 'Después'];
    out.list.slice(0, 3).forEach(function (c, i) {
      var who = c.s.b || (c.s.gn || c.s.n).toLowerCase();
      parts.push(ordinal[i] + ': ' + who + ', en ' + spokenAddress(c.s) + ', a ' +
        (c.s.q === 'c' ? 'unos ' : '') + spokenKm(c.km) + ', a ' + spokenPrice(c.price) +
        (unitOf(c.key) === 'gal' ? ' el galón.' : ' el metro cúbico.'));
    });
    return parts.join(' ');
  }

  // ------------------------------------------------------------ controles

  function showMessage(text) {
    $('summary').hidden = false;
    $('summary').className = 'summary';
    $('summary').textContent = text;
  }

  function syncControls() {
    $('fuel').value = state.fuel;
    $('radius').value = state.radiusKm ? String(state.radiusKm) : '';
    if ($('radius').value !== String(state.radiusKm || '')) {
      var opt = document.createElement('option');
      opt.value = opt.textContent = String(state.radiusKm);
      opt.textContent += ' km';
      $('radius').appendChild(opt);
      $('radius').value = String(state.radiusKm);
    }
    $('sort').value = state.sort;
    Array.prototype.forEach.call($('brands').children, function (chip) {
      chip.setAttribute('aria-pressed', String(state.brands.indexOf(chip.dataset.brand) >= 0));
    });
    store('prefs', { fuel: state.fuel, brands: state.brands });
  }

  function buildBrandChips() {
    BRANDS.forEach(function (b) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.brand = b;
      chip.textContent = b;
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', function () {
        var i = state.brands.indexOf(b);
        if (i >= 0) state.brands.splice(i, 1); else state.brands.push(b);
        syncControls();
        if (state.fuel) runSearch(null, false);
      });
      $('brands').appendChild(chip);
    });
  }

  function init() {
    buildBrandChips();
    var prefs = recall('prefs');
    if (prefs) { state.fuel = prefs.fuel || ''; state.brands = prefs.brands || []; }
    syncControls();

    $('mic').addEventListener('click', onMic);
    $('typed').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = $('typed-text').value.trim();
      if (text) handleCommand(text, GasParser.parseCommand(text));
    });
    $('fuel').addEventListener('change', function () { state.fuel = this.value; syncControls(); runSearch(null, false); });
    $('radius').addEventListener('change', function () { state.radiusKm = Number(this.value) || null; runSearch(null, false); });
    $('sort').addEventListener('change', function () { state.sort = this.value; runSearch(null, false); });

    var auto = $('autolisten');
    auto.checked = !!recall('autolisten');
    auto.addEventListener('change', function () { store('autolisten', auto.checked); });

    getPosition().catch(function () {});
    loadData().then(function () {
      if (auto.checked && isNative) onMic();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
