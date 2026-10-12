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

  // Hay dos fuentes de precios:
  //  - data/stations.json en GitHub (ubicaciones + marcas + precios; se regenera cada 3 horas)
  //  - el Excel de Osinergmin descargado desde el celular con "Actualizar ahora" (solo precios)
  // Se usan los precios de la que sea más reciente.

  function loadData(force) {
    if (!data) {
      var cached = recall('stations');
      if (cached && cached.data) {
        data = cached.data;
        dataSavedAt = cached.savedAt;
        applyLivePrices();
        showDataStatus();
      }
    }
    if (!force && data && Date.now() - dataSavedAt < DATA_MAX_AGE_MS) return Promise.resolve();
    setStatusBusy(true, data ? null : 'Descargando precios…');
    return fetch(window.GAS_CONFIG.dataUrl, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        dataSavedAt = Date.now();
        store('stations', { savedAt: dataSavedAt, data: json });
        data = json;
        applyLivePrices();
      })
      .catch(function (err) {
        if (!data) throw new Error('No se pudieron cargar los precios (' + err.message + ').');
      })
      .then(function () { setStatusBusy(false); showDataStatus(); },
            function (err) { setStatusBusy(false); $('status-text').textContent = err.message; });
  }

  function time(value) { var t = Date.parse(value || ''); return isNaN(t) ? 0 : t; }

  // Si los precios descargados directo de Osinergmin son más nuevos que los de GitHub, se aplican.
  function applyLivePrices() {
    var live = recall('live');
    data.meta.liveModified = null;
    if (!live || time(live.modified) <= time(data.meta.source_modified)) return 0;
    var changed = 0;
    data.stations.forEach(function (s) {
      var fresh = live.prices[s.id];
      if (!fresh) return;
      Object.keys(fresh).forEach(function (k) {
        if (!s.f[k] || s.f[k][0] !== fresh[k][0]) changed++;
      });
      s.f = fresh;
    });
    data.meta.liveModified = live.modified;
    return changed;
  }

  function pricesTime() {
    return time(data.meta.liveModified) || time(data.meta.source_modified) || time(data.meta.generated);
  }

  function ago(ms) {
    var min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 1) return 'hace un momento';
    if (min < 60) return 'hace ' + min + ' min';
    var h = Math.floor(min / 60);
    if (h < 24) return 'hace ' + h + ' h' + (min % 60 && h < 6 ? ' ' + (min % 60) + ' min' : '');
    var d = Math.floor(h / 24);
    return 'hace ' + d + (d === 1 ? ' día' : ' días');
  }

  function showDataStatus() {
    if (!data) return;
    var when = pricesTime();
    var age = Date.now() - when;
    $('status').className = 'status ' + (age < 4 * 3600e3 ? 'fresh' : age < 24 * 3600e3 ? 'aging' : 'old');
    $('status-text').textContent = 'Precios ' + ago(when);
    $('status-detail').textContent = new Date(when).toLocaleString('es-PE',
      { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) +
      ' · ' + (data.meta.liveModified ? 'directo de Osinergmin' : 'vía GitHub');
  }

  function setStatusBusy(busy, text) {
    $('status').classList.toggle('busy', busy);
    $('refresh').disabled = busy;
    if (text) $('status-text').textContent = text;
  }

  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;   // reinicia la animación
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  // "Actualizar ahora": baja el Excel de Osinergmin en el celular y actualiza los precios al momento.
  function refreshNow() {
    if (!Plugins.CapacitorHttp) {   // navegador de escritorio: solo se puede recargar desde GitHub
      return loadData(true).then(function () { toast('Precios recargados desde GitHub'); });
    }
    var before = 0;
    return loadData(false)
      .then(function () {
        if (data) before = pricesTime();
        setStatusBusy(true, 'Descargando de Osinergmin…');
        return GasOsinergmin.download(Plugins.CapacitorHttp);
      })
      .then(function (file) {
        setStatusBusy(true, 'Procesando precios…');
        return new Promise(function (resolve) { setTimeout(resolve, 30); })   // deja pintar el texto
          .then(function () { return { parsed: GasOsinergmin.parseXlsx(file.bytes, window.fflate), file: file }; });
      })
      .then(function (r) {
        if (!data) throw new Error('faltan las ubicaciones de GitHub; revisa tu conexión');
        var modified = r.file.modified || new Date().toUTCString();
        if (time(modified) <= before) {
          setStatusBusy(false);
          showDataStatus();
          toast('Ya tienes los precios más recientes de Osinergmin');
          return;
        }
        store('live', { modified: modified, fetchedAt: Date.now(), prices: r.parsed.prices });
        var changed = applyLivePrices();
        setStatusBusy(false);
        showDataStatus();
        toast('✓ Precios actualizados' + (changed ? ' · ' + changed + ' cambios' : ''));
        if (state.fuel && $('results').children.length) runSearch(position, false);
      })
      .catch(function (err) {
        // Osinergmin falló: probar con la copia de GitHub (se actualiza cada 3 horas)
        var offline = GasOsinergmin.isNetworkError(err);
        setStatusBusy(true, 'Osinergmin no responde, probando GitHub…');
        var before = data ? pricesTime() : 0;
        return fetch(window.GAS_CONFIG.dataUrl, { cache: 'no-cache' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function (json) {
            dataSavedAt = Date.now();
            store('stations', { savedAt: dataSavedAt, data: json });
            data = json;
            applyLivePrices();
            setStatusBusy(false);
            showDataStatus();
            toast(pricesTime() > before ? '✓ Precios actualizados desde GitHub'
                                        : 'Osinergmin no responde; ya tienes los últimos precios de GitHub');
          })
          .catch(function () {
            setStatusBusy(false);
            showDataStatus();
            var kept = data ? ' Se mantienen los precios guardados (' + ago(pricesTime()) + ').' : '';
            toast((offline ? 'Sin conexión a internet.' : 'No se pudo actualizar: ' + (err.message || err) + '.') + kept);
          });
      });
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

  // Reconocimiento local: primero el del dispositivo (Android 12+, sin internet); si ese idioma no
  // está instalado, el reconocedor del sistema con preferencia sin conexión.
  var RECOGNIZERS = [
    { onDevice: true, language: 'es-US' },
    { onDevice: true, language: 'es-ES' },
    { onDevice: false, language: 'es-PE' }
  ];
  var recognizerIndex = 0;
  var listening = false;

  function listen() {
    var A = Plugins.Assistant;
    if (!A) return webListen();
    function attempt(i) {
      return A.listen(RECOGNIZERS[i]).then(function (r) {
        recognizerIndex = i;
        return (r && r.matches) || [];
      }, function (err) {
        var code = err && String(err.code);
        if ((code === '12' || code === '13') && i + 1 < RECOGNIZERS.length) return attempt(i + 1);
        throw err;
      });
    }
    return attempt(recognizerIndex);
  }

  function webListen() {   // navegador de escritorio, para pruebas
    var Web = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Web) return Promise.reject(new Error('Este navegador no reconoce voz; escribe la orden.'));
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

  function setListening(on) {
    listening = on;
    $('mic').classList.toggle('listening', on);
    $('mic').style.transform = '';
    if (on) showHeard('Escuchando…', true);
  }

  function showHeard(text, live) {
    $('heard').hidden = false;
    $('heard').classList.toggle('live', !!live);
    $('heard').textContent = live ? text : '“' + text + '”';
  }

  function onMic() {
    if (listening) {   // segundo toque: terminar de escuchar ya
      if (Plugins.Assistant) Plugins.Assistant.stopListening();
      return;
    }
    listenAndHandle();
  }

  function listenAndHandle() {
    setListening(true);
    listen()
      .then(function (matches) {
        setListening(false);
        if (!matches.length) { $('heard').hidden = true; return; }
        handleUtterance(matches);
      })
      .catch(function (err) {
        setListening(false);
        $('heard').hidden = true;
        if (err && err.code === 'cancelled') return;
        showMessage(err.message || String(err));
      });
  }

  // ------------------------------------------------------------ qué hacer con lo que se dijo

  function handleUtterance(matches) {
    // de las alternativas del reconocedor, la primera que tenga una intención clara
    var chosen = null;
    matches.forEach(function (m) {
      var c = GasIntents.classify(m);
      if (!chosen || (chosen.intent.type === 'unknown' && c.type !== 'unknown')) chosen = { text: m, intent: c };
    });
    showHeard(chosen.text);
    var intent = chosen.intent;
    if (intent.type === 'call') return handleCall(intent, matches);
    if (intent.type === 'whatsapp') return handleWhatsApp(intent, matches);
    if (intent.type === 'torch') return handleTorch(intent);
    if (intent.type === 'alarm') return handleAlarm(intent.time);
    if (intent.type === 'timer') return handleTimer(intent.seconds);
    if (intent.type === 'fuel') return handleFuel(intent.fuel);
    if (intent.type === 'place') return handlePlace(intent);
    var msg = 'No entendí. Puedes decir: llama a mamá, prende la linterna, llévame a Plaza San Miguel, o gasohol noventa y cinco.';
    showMessage(msg);
    speak(msg);
  }

  function handleFuel(parsed) {
    if (parsed.fuel) state.fuel = parsed.fuel;
    if (parsed.brands.length || parsed.anyBrand) state.brands = parsed.brands;
    if (parsed.radiusKm) state.radiusKm = parsed.radiusKm;
    state.sort = parsed.sort;
    syncControls();
    if (!state.fuel) {
      var msg = '¿Qué combustible? Di, por ejemplo: gasohol noventa y cinco en Primax.';
      showMessage(msg);
      speak(msg);
      return;
    }
    runSearch(getPosition(), true);
  }

  // ------------------------------------------------------------ lugares (Google Maps)

  function handlePlace(intent) {
    var q = intent.query;
    var url = intent.mode === 'navigate'
      ? 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(q)
      : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
    var label = (intent.mode === 'navigate' ? 'Ruta a ' : 'Buscando ') + q;
    $('results').innerHTML = '';
    showMessage(label + ' en Google Maps');
    speak(label).then(function () { openUrl(url); });
  }

  function openUrl(url) {
    if (Plugins.AppLauncher) return Plugins.AppLauncher.openUrl({ url: url });
    window.open(url, '_blank');
  }

  // ------------------------------------------------------------ llamadas

  var contacts = null;
  var pendingCall = null;

  function loadContacts() {
    if (contacts) return Promise.resolve(contacts);
    if (!Plugins.Assistant) return Promise.reject(new Error('Las llamadas solo funcionan en el celular.'));
    return Plugins.Assistant.getContacts().then(function (r) {
      contacts = r.contacts || [];
      return contacts;
    });
  }

  function handleCall(intent, matches) {
    if (intent.number) {
      return confirmCall({ name: intent.number.replace(/(\d{3})(?=\d)/g, '$1 '), number: intent.number });
    }
    withContact(intent, matches, confirmCall, 'llamo');
  }

  // Busca el contacto (probando todas las alternativas del reconocedor del mismo tipo) y ejecuta
  // action(contacto); si hay varios parecidos pregunta cuál.
  function withContact(intent, matches, action, verb) {
    loadContacts()
      .then(function (list) {
        var best = { results: GasIntents.findContacts(intent.name, list), name: intent.name };
        matches.forEach(function (m) {
          var c = GasIntents.classify(m);
          if (c.type !== intent.type || !c.name || c.name === intent.name) return;
          var r = GasIntents.findContacts(c.name, list);
          if (r.length && (!best.results.length || r[0].score > best.results[0].score)) best = { results: r, name: c.name };
        });
        var pick = GasIntents.pickContact(best.results);
        if (pick.status === 'one') return action(pick.contact);
        if (pick.status === 'ambiguous') return askWhich(pick.options, action, verb);
        var msg = 'No encontré a ' + best.name + ' en tus contactos.';
        showMessage(msg);
        speak(msg);
      })
      .catch(function (err) {
        showMessage(err.message);
        speak(err.message);
      });
  }

  var CALL_DELAY_MS = 3000;

  function confirmCall(contact) {
    cancelPendingCall(true);
    var ol = $('results');
    ol.innerHTML = '';
    showMessage('Llamando a ' + contact.name);
    var li = document.createElement('li');
    li.className = 'callcard appear';
    li.innerHTML = '<div class="call-name"></div><div class="call-number"></div>' +
      '<div class="countdown"><span></span></div>' +
      '<div class="call-actions"><button class="cancel" type="button">Cancelar</button>' +
      '<button class="now" type="button">Llamar ya</button></div>';
    li.querySelector('.call-name').textContent = contact.name;
    li.querySelector('.call-number').textContent = contact.number;
    li.querySelector('.countdown span').style.animationDuration = CALL_DELAY_MS + 'ms';
    ol.appendChild(li);

    var go = function () {
      if (!pendingCall) return;
      clearTimeout(pendingCall.timer);
      pendingCall = null;
      li.classList.add('done');
      li.querySelector('.call-actions').hidden = true;
      if (!Plugins.Assistant) { showMessage('Las llamadas solo funcionan en el celular.'); return; }
      Plugins.Assistant.call({ number: contact.number })
        .catch(function (err) { showMessage(err.message); });
    };
    pendingCall = { timer: setTimeout(go, CALL_DELAY_MS), card: li };
    li.querySelector('.now').addEventListener('click', go);
    li.querySelector('.cancel').addEventListener('click', function () { cancelPendingCall(false); });
    speak('Llamando a ' + contact.name);
  }

  function cancelPendingCall(silent) {
    if (!pendingCall) return;
    clearTimeout(pendingCall.timer);
    pendingCall.card.remove();
    pendingCall = null;
    if (!silent) { showMessage('Llamada cancelada'); speak('Cancelado'); }
  }

  var ORDINAL_WORDS = ['uno', 'dos', 'tres', 'cuatro'];

  function askWhich(options, action, verb) {
    var ol = $('results');
    ol.innerHTML = '';
    showMessage('¿A cuál ' + verb + '?');
    options.forEach(function (o, i) {
      var li = document.createElement('li');
      li.className = 'option appear';
      li.style.animationDelay = i * 60 + 'ms';
      li.innerHTML = '<span class="num"></span><span class="who"></span><span class="tel"></span>';
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('.who').textContent = o.name;
      li.querySelector('.tel').textContent = o.number;
      li.addEventListener('click', function () {
        if (Plugins.Assistant) Plugins.Assistant.cancelListening();
        answered = true;
        action(o);
      });
      ol.appendChild(li);
    });
    var answered = false;
    var question = 'Tengo ' + options.length + ' contactos: ' + options.map(function (o, i) {
      return ORDINAL_WORDS[i] + ', ' + o.name;
    }).join('; ') + '. ¿A cuál ' + verb + '?';
    speak(question).then(function () {
      if (answered) return null;   // ya eligió tocando la pantalla
      setListening(true);
      return listen();
    }).then(function (matches) {
      setListening(false);
      if (!matches || !matches.length) return;
      showHeard(matches[0]);
      var idx = GasIntents.pickOption(matches[0], options);
      if (idx >= 0) action(options[idx]);
      else if (idx === -1) { showMessage('Cancelado'); speak('Cancelado'); ol.innerHTML = ''; }
      else speak('No entendí. Toca el contacto en la pantalla.');
    }).catch(function () { setListening(false); });
  }

  // ------------------------------------------------------------ WhatsApp

  function handleWhatsApp(intent, matches) {
    withContact(intent, matches, function (contact) { openWhatsApp(contact, intent.message); }, 'escribo');
  }

  // Número en formato internacional para wa.me (Perú: 9 dígitos que empiezan con 9 -> 51...)
  function waNumber(number) {
    var d = number.replace(/\D/g, '').replace(/^00/, '');
    if (d.length === 9 && d[0] === '9') d = '51' + d;
    return d;
  }

  function openWhatsApp(contact, message) {
    var text = message ? message.charAt(0).toUpperCase() + message.slice(1) : '';
    var url = 'https://wa.me/' + waNumber(contact.number) + (text ? '?text=' + encodeURIComponent(text) : '');
    $('results').innerHTML = '';
    showMessage('WhatsApp a ' + contact.name + (text ? ': “' + text + '”' : ''));
    speak('Abriendo WhatsApp con ' + contact.name + (text ? '. Revisa el mensaje y envíalo.' : ''))
      .then(function () { openUrl(url); });
  }

  // ------------------------------------------------------------ linterna, alarma, temporizador

  function nativeOnly() {
    if (Plugins.Assistant) return true;
    showMessage('Esto solo funciona en el celular.');
    return false;
  }

  function handleTorch(intent) {
    if (!nativeOnly()) return;
    Plugins.Assistant.torch(intent.on === null ? {} : { on: intent.on })
      .then(function (r) {
        $('results').innerHTML = '';
        showMessage(r.on ? '🔦 Linterna encendida' : 'Linterna apagada');
        speak(r.on ? 'Linterna encendida' : 'Linterna apagada');
      })
      .catch(function (err) { showMessage(err.message); speak(err.message); });
  }

  function spokenTime(t) {
    var h12 = t.hour % 12 || 12;
    var mins = t.minutes === 0 ? '' : t.minutes === 30 ? ' y media' : t.minutes === 15 ? ' y cuarto' : ' y ' + t.minutes;
    var period = t.hour === 0 ? 'de la noche' : t.hour < 12 ? 'de la mañana' : t.hour < 19 ? 'de la tarde' : 'de la noche';
    if (t.hour === 12 && t.minutes === 0) return 'las 12 del mediodía';
    return (h12 === 1 ? 'la 1' : 'las ' + h12) + mins + ' ' + period;
  }

  function spokenDuration(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60, parts = [];
    if (h) parts.push(h === 1 ? 'una hora' : h + ' horas');
    if (m) parts.push(m === 1 ? 'un minuto' : m + ' minutos');
    if (s) parts.push(s + ' segundos');
    return parts.join(' y ') || '0 segundos';
  }

  // Pregunta algo y vuelve a escuchar; parse(texto) debe devolver null si no entendió.
  function askAgain(question, parse, done) {
    showMessage(question);
    speak(question).then(function () {
      setListening(true);
      return listen();
    }).then(function (matches) {
      setListening(false);
      for (var i = 0; i < (matches || []).length; i++) {
        var v = parse(GasParser.normalize(matches[i]));
        if (v !== null) { showHeard(matches[i]); return done(v); }
      }
      if (matches && matches.length) { showMessage('No entendí.'); speak('No entendí.'); }
    }).catch(function () { setListening(false); });
  }

  function handleAlarm(time) {
    if (!nativeOnly()) return;
    if (!time) return askAgain('¿A qué hora pongo la alarma?', GasIntents.parseTime, handleAlarm);
    Plugins.Assistant.setAlarm({ hour: time.hour, minutes: time.minutes, label: 'Mi Asistente' })
      .then(function () {
        $('results').innerHTML = '';
        var msg = 'Alarma para ' + spokenTime(time);
        showMessage('⏰ ' + msg + ' (' + time.hour + ':' + ('0' + time.minutes).slice(-2) + ')');
        speak(msg);
      })
      .catch(function (err) { showMessage(err.message); speak(err.message); });
  }

  function handleTimer(seconds) {
    if (!nativeOnly()) return;
    if (!seconds) return askAgain('¿De cuánto tiempo?', GasIntents.parseDuration, handleTimer);
    Plugins.Assistant.setTimer({ seconds: seconds })
      .then(function () {
        $('results').innerHTML = '';
        var msg = 'Temporizador de ' + spokenDuration(seconds);
        showMessage('⏱️ ' + msg);
        speak(msg);
      })
      .catch(function (err) { showMessage(err.message); speak(err.message); });
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

  // ------------------------------------------------------------ actualizaciones de la app

  function showUpdate(text, button, action) {
    $('update-text').textContent = text;
    $('update-btn').textContent = button;
    $('update-btn').onclick = action;
    $('update').hidden = false;
  }

  function offerRestart(apply, manifest) {
    showUpdate('Nueva versión ' + manifest.version + ' lista', 'Reiniciar', function () {
      $('update-btn').disabled = true;
      $('update-btn').textContent = 'Aplicando…';
      apply().catch(function (err) {
        $('update-btn').disabled = false;
        toast('No se pudo aplicar: ' + (err.message || err));
      });
    });
  }

  function offerApk(manifest) {
    showUpdate('Versión ' + manifest.version + ': hay que reinstalar la app', 'Descargar', function () {
      if (Plugins.AppLauncher) Plugins.AppLauncher.openUrl({ url: manifest.apk });
      else window.open(manifest.apk, '_blank');
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
      if (text) handleUtterance([text]);
    });
    $('fuel').addEventListener('change', function () { state.fuel = this.value; syncControls(); runSearch(null, false); });
    $('radius').addEventListener('change', function () { state.radiusKm = Number(this.value) || null; runSearch(null, false); });
    $('sort').addEventListener('change', function () { state.sort = this.value; runSearch(null, false); });

    var auto = $('autolisten');
    auto.checked = recall('autolisten') !== false;   // por defecto escucha al abrir
    auto.addEventListener('change', function () { store('autolisten', auto.checked); });

    $('refresh').addEventListener('click', refreshNow);

    if (Plugins.Assistant) {
      // texto en vivo mientras hablas y el micrófono "late" con tu voz
      Plugins.Assistant.addListener('partial', function (e) { if (listening) showHeard(e.text, true); });
      // abierta con la tecla lateral / botón de inicio / audífono: escuchar ya
      Plugins.Assistant.addListener('assist', function () { if (!listening) listenAndHandle(); });
      Plugins.Assistant.addListener('level', function (e) {
        if (listening) $('mic').style.transform = 'scale(' + (1 + Math.max(0, Math.min(10, e.value)) / 40) + ')';
      });
      // si ya hay permiso de contactos, cargarlos de antemano para que "llama a..." sea instantáneo
      Plugins.Assistant.checkPermissions().then(function (p) {
        if (p.contacts === 'granted') loadContacts().catch(function () {});
      }).catch(function () {});
    }
    $('version').textContent = 'Versión ' + (window.GAS_CONFIG.version || 'dev');
    GasUpdater.check(offerApk, offerRestart);
    setInterval(showDataStatus, 60000);

    getPosition().catch(function () {});
    loadData().then(function () {
      if (auto.checked && isNative && !listening) listenAndHandle();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
