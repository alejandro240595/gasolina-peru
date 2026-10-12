// Decide qué quiere el usuario (llamar, ir a un lugar, buscar gasolina) y busca contactos.
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

  function cleanTarget(t) {
    return t.replace(/\b(por favor|ahora|ahorita|ya|rapido|porfa)\b/g, ' ')
      .replace(/^(mi|mis|el|la|los|las)\s+/, '')
      .replace(/\s+/g, ' ').trim();
  }

  function classify(text) {
    var t = normalize(text);
    var m;
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

  var api = { classify: classify, findContacts: findContacts, pickContact: pickContact, pickOption: pickOption };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GasIntents = api;
})(this);
