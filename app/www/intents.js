// Decide qué quiere el usuario (llamar, WhatsApp, linterna, alarma, ir a un lugar, gasolina)
// y busca contactos.
// Todo es local: no usa internet.
(function (root) {
  'use strict';

  var P = root.GasParser || (typeof require !== 'undefined' ? require('./parser.js') : null);
  var normalize = P.normalize;

  // ------------------------------------------------------------ intención

  var CALL_RE = /^(?:(?:por favor|oye|ok)\s+)?(?:quiero\s+|puedes\s+|podrias\s+)?(?:llama(?:r|le|me)?|llamale|marca(?:r|le)?|marcale|telefonea(?:r)?|comunica(?:me)?\s+con|haz(?:\s+una)?\s+llamada|hacer(?:\s+una)?\s+llamada)\s+(?:a\s+|al\s+|con\s+)?(.+)$/;
  var NAVIGATE_RE = /^(?:(?:por favor|oye|ok)\s+)?(?:llevame|quiero ir|vamos|ir|navega(?:r)?|guiame|ruta|como llego|como voy|como se llega|direccion(?:es)?)\s+(?:hacia\s+|hasta\s+|para\s+)?(?:a\s+|al\s+|a la\s+|para\s+)?(.+)$/;
  var SEARCH_RE = /^(?:(?:por favor|oye|ok)\s+)?(?:busca(?:me)?|buscar|muestrame|mostrar|encuentra|donde (?:queda|esta|hay|estan)|ubica(?:me)?|ver)\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+|unos\s+|unas\s+)?(.+)$/;
  var NEAR_RE = /^(.+?)\s+(?:cerca|cercan[oa]s?|por aqui|aqui cerca|cerca de (?:mi|aqui))$/;
  var FUEL_WORDS = /\b(gasolina|gasohol|combustible|grifo|grifos|gasolinera|gasolineras|diesel|petroleo|glp|gnv|premium|regular)\b/;
  var TORCH_RE = /\b(linterna|flash|luz de la camara)\b/;
  var WHATSAPP_RE = /^(?:(?:por favor|oye|ok)\s+)?(?:(?:manda(?:le|r)?|envia(?:le|r)?|escribe(?:le)?|abre)\s+(?:un\s+|el\s+)?)?(?:whatsapp|wasap|wassap|guasap|whatsap|mensaje|chat)\s+(?:a\s+|al\s+|para\s+|de\s+|con\s+)(.+?)(?:\s+(?:diciendo(?:le)?|que diga|que dice|dile|diciendole|con el texto|que)\s+(.+))?$/;
  // orden inverso: "escríbele a Pedro un whatsapp diciendo ..."
  var WHATSAPP2_RE = /^(?:(?:por favor|oye|ok)\s+)?(?:manda(?:le)?|envia(?:le)?|escribe(?:le)?)\s+(?:a\s+|al\s+)(.+?)\s+(?:un\s+)?(?:whatsapp|wasap|wassap|guasap|whatsap|mensaje)(?:\s+(?:diciendo(?:le)?|que diga|que dice|dile|diciendole|con el texto|que)\s+(.+))?$/;
  var ALARM_RE = /\b(alarma|despiertame|despertador|levantame)\b/;
  var TIMER_RE = /\b(temporizador|timer|cronometro|cuenta regresiva|avisame en)\b/;

  var NUM_WORDS = {
    cero: 0, un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
    nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20,
    veinticinco: 25, treinta: 30, cuarenta: 40, cuarentaicinco: 45, cincuenta: 50
  };

  function num(w) {
    if (w === undefined || w === null) return null;
    if (/^\d+$/.test(w)) return parseInt(w, 10);
    return w in NUM_WORDS ? NUM_WORDS[w] : null;
  }

  // "a las 6", "6 y media", "6 30 de la tarde", "7 menos cuarto", "mediodia" -> {hour, minutes}
  function parseTime(t) {
    if (/\bmediodia\b/.test(t)) return { hour: 12, minutes: 0 };
    if (/\bmedianoche\b/.test(t)) return { hour: 0, minutes: 0 };
    // grupos: 1 hora · 2 "menos X" · 3 "y X" · 4 minutos "6 45" (de "6:45")
    var tail = '(?:\\s+menos\\s+(cuarto|\\d{1,2}|[a-z]+)|\\s+(?:y|con)\\s+(media|cuarto|\\d{1,2}|[a-z]+)|\\s+(\\d{2})\\b)?';
    var patterns = [
      new RegExp('\\b(?:a las|a la|para las|las|la)\\s+(\\d{1,2}|[a-z]+)' + tail, 'g'),
      new RegExp('\\b(\\d{1,2})\\b' + tail, 'g')
    ];
    var m = null;
    for (var p = 0; p < patterns.length && !m; p++) {
      var x;
      while ((x = patterns[p].exec(t))) {   // "la alarma a las 6": saltar coincidencias que no son hora
        if (num(x[1]) !== null && num(x[1]) <= 23) { m = x; break; }
      }
    }
    if (!m) return null;
    var hour = num(m[1]);
    var minutes = 0;
    var word = m[3] || m[4];
    if (word) minutes = word === 'media' ? 30 : word === 'cuarto' ? 15 : (num(word) || 0);
    if (m[2]) {
      var less = m[2] === 'cuarto' ? 15 : (num(m[2]) || 0);
      hour = (hour + 23) % 24;
      minutes = 60 - less;
    }
    if (minutes > 59) minutes = 0;
    if (/\b(tarde|noche|pm|p m)\b/.test(t) && hour < 12) hour += 12;
    if (/\b(manana|madrugada|noche|am|a m)\b/.test(t) && hour === 12) hour = 0;
    return { hour: hour, minutes: minutes };
  }

  // "10 minutos", "una hora y media", "30 segundos" -> segundos
  function parseDuration(t) {
    var total = 0, found = false, m;
    var re = /(\d+|[a-z]+)\s+(hora|horas|minuto|minutos|segundo|segundos)\b/g;
    while ((m = re.exec(t))) {
      var n = num(m[1]);
      if (n === null) continue;
      found = true;
      total += n * (m[2].indexOf('hora') === 0 ? 3600 : m[2].indexOf('minuto') === 0 ? 60 : 1);
    }
    if (/\bmedia hora\b/.test(t)) { total += 1800; found = true; }
    if (/\b(hora|horas|minuto|minutos)\s+y\s+media\b/.test(t)) {
      total += /\bhoras?\s+y\s+media/.test(t) ? 1800 : 30;
    }
    return found ? total : null;
  }

  function cleanTarget(t) {
    return t.replace(/\b(por favor|ahora|ahorita|ya|rapido|porfa)\b/g, ' ')
      .replace(/^(mi|mis|el|la|los|las)\s+/, '')
      .replace(/\s+/g, ' ').trim();
  }

  function classify(text) {
    var t = normalize(text);
    var m;
    if (TORCH_RE.test(t)) {
      var on = /\b(prende|prender|prendela|enciende|encender|enciendela|activa|activar|pon|abre)\b/.test(t) ? true
             : /\b(apaga|apagar|apagala|desactiva|desactivar|quita|cierra)\b/.test(t) ? false : null;
      return { type: 'torch', on: on, text: t };
    }
    if ((m = WHATSAPP_RE.exec(t) || WHATSAPP2_RE.exec(t))) {
      // el mensaje se toma del texto original para conservar tildes y signos
      var original = m[2] && /\s(?:diciendo(?:le)?|diciéndole|que diga|que dice|dile|con el texto|que)\s+([\s\S]+)$/i.exec(String(text));
      var message = original ? original[1].trim() : (m[2] || '').trim();
      return { type: 'whatsapp', name: cleanTarget(m[1]), message: message, text: t };
    }
    if (TIMER_RE.test(t)) return { type: 'timer', seconds: parseDuration(t), text: t };
    if (ALARM_RE.test(t)) return { type: 'alarm', time: parseTime(t), text: t };
    if ((m = CALL_RE.exec(t))) {
      var target = cleanTarget(m[1]);
      var digits = target.replace(/\D/g, '');
      if (digits.length >= 6 && /^[\d\s]+$/.test(target)) return { type: 'call', number: digits, text: t };
      return { type: 'call', name: target, text: t };
    }
    var fuel = P.parseCommand(text);
    if (fuel.fuel || FUEL_WORDS.test(t)) return { type: 'fuel', fuel: fuel, text: t };
    if ((m = NAVIGATE_RE.exec(t))) return { type: 'place', mode: 'navigate', query: cleanTarget(m[1]), text: t };
    if ((m = NEAR_RE.exec(t))) return { type: 'place', mode: 'search', query: cleanTarget(m[1]), text: t };
    if ((m = SEARCH_RE.exec(t))) return { type: 'place', mode: 'search', query: cleanTarget(m[1]), text: t };
    return { type: 'unknown', text: t };
  }

  // ------------------------------------------------------------ contactos

  var NICKNAMES = [
    ['mama', 'mami', 'madre', 'mamita', 'ma', 'mom', 'mother'],
    ['papa', 'papi', 'padre', 'papito', 'pa', 'dad', 'father'],
    ['abuela', 'abuelita', 'abue', 'mama grande'],
    ['abuelo', 'abuelito', 'papa grande'],
    ['hermano', 'hermanito', 'bro', 'brother'],
    ['hermana', 'hermanita', 'sis', 'sister'],
    ['esposa', 'mi amor', 'amor', 'gorda', 'gordita', 'wife'],
    ['esposo', 'mi amor', 'amor', 'gordo', 'gordito', 'husband']
  ];

  function stripEmoji(s) { return normalize(s); }

  function levenshtein(a, b) {
    if (a === b) return 0;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  function variants(query) {
    var out = [query];
    NICKNAMES.forEach(function (group) {
      if (group.indexOf(query) >= 0) group.forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); });
    });
    return out;
  }

  function scoreName(query, name) {
    if (!name) return 0;
    if (name === query) return 100;
    var qt = query.split(' '), nt = name.split(' ');
    if (name.indexOf(query + ' ') === 0) return 92;
    // todas las palabras dichas coinciden con el inicio de palabras del contacto
    var allPrefix = qt.every(function (q) {
      return nt.some(function (n) { return n === q || (q.length >= 3 && n.indexOf(q) === 0); });
    });
    if (allPrefix) return 85 - Math.min(10, nt.length - qt.length);
    // parecido por palabras (errores del reconocimiento: "jose" / "joce")
    var total = 0;
    qt.forEach(function (q) {
      var best = 0;
      nt.forEach(function (n) { best = Math.max(best, similarity(q, n)); });
      total += best;
    });
    var perWord = total / qt.length;
    var whole = similarity(query, name);
    var s = Math.max(perWord * 80, whole * 75);
    return s >= 55 ? s : 0;
  }

  // contacts: [{name, number, type, primary, starred}] (una fila por número)
  function findContacts(query, contacts) {
    var q = normalize(query);
    if (!q) return [];
    var byPerson = {};
    contacts.forEach(function (c) {
      var key = c.id || c.name;
      var p = byPerson[key] || (byPerson[key] = { name: c.name, norm: stripEmoji(c.name), starred: c.starred, numbers: [] });
      if (!p.numbers.some(function (n) { return n.number.replace(/\D/g, '') === c.number.replace(/\D/g, ''); })) {
        p.numbers.push(c);
      }
    });
    var vs = variants(q);
    var results = [];
    Object.keys(byPerson).forEach(function (k) {
      var p = byPerson[k];
      var score = 0;
      vs.forEach(function (v, i) { score = Math.max(score, scoreName(v, p.norm) - (i ? 3 : 0)); });
      if (score > 0) {
        if (p.starred) score += 2;
        results.push({ name: p.name, score: score, number: bestNumber(p.numbers), numbers: p.numbers });
      }
    });
    results.sort(function (a, b) { return b.score - a.score; });
    return results;
  }

  function bestNumber(numbers) {
    var TYPE_RANK = { mobile: 0, work: 2, home: 3 };
    var rank = function (n) { return (n.primary ? 0 : 10) + (n.type in TYPE_RANK ? TYPE_RANK[n.type] : 4); };
    return numbers.slice().sort(function (a, b) { return rank(a) - rank(b); })[0].number;
  }

  // ¿El mejor resultado es claro, o hay que preguntar cuál?
  function pickContact(results) {
    if (!results.length) return { status: 'none' };
    var top = results[0];
    var close = results.filter(function (r) { return r.score >= top.score - 4; });
    if (close.length === 1 || top.score >= 100 && results[1].score < 100) {
      return { status: 'one', contact: top };
    }
    return { status: 'ambiguous', options: close.slice(0, 4) };
  }

  // "el primero", "dos", "el de Juan Pérez" -> índice de la opción
  var ORDINALS = [['1', 'uno', 'primero', 'primera', 'el primero', 'la primera'],
                  ['2', 'dos', 'segundo', 'segunda'], ['3', 'tres', 'tercero', 'tercera'],
                  ['4', 'cuatro', 'cuarto', 'cuarta']];

  function pickOption(text, options) {
    var t = normalize(text);
    if (/\b(cancela|cancelar|ninguno|ninguna|nada|olvidalo|no)\b/.test(t)) return -1;
    for (var i = 0; i < ORDINALS.length && i < options.length; i++) {
      for (var j = 0; j < ORDINALS[i].length; j++) {
        if (new RegExp('\\b' + ORDINALS[i][j] + '\\b').test(t)) return i;
      }
    }
    var best = -2, bestScore = 0;
    options.forEach(function (o, idx) {
      var s = scoreName(t.replace(/^(el|la|a)\s+(de\s+)?/, ''), normalize(o.name));
      if (s > bestScore) { bestScore = s; best = idx; }
    });
    return best;
  }

  var api = { classify: classify, findContacts: findContacts, pickContact: pickContact, pickOption: pickOption,
              parseTime: parseTime, parseDuration: parseDuration };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GasIntents = api;
})(this);
