// IA local (Qwen 2.5 1.5B en el teléfono): entiende frases libres y las convierte en una acción
// de la app, o responde preguntas. Las reglas de intents.js se prueban primero (son instantáneas);
// la IA solo entra cuando ellas no entienden o es una pregunta.
(function (root) {
  'use strict';

  var P = root.GasParser || (typeof require !== 'undefined' ? require('./parser.js') : null);

  var DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre',
                'octubre', 'noviembre', 'diciembre'];

  function today(now) {
    return 'Hoy es ' + DAYS[now.getDay()] + ' ' + now.getDate() + ' de ' + MONTHS[now.getMonth()] + ' de ' +
      now.getFullYear() + ', son las ' + now.getHours() + ':' + ('0' + now.getMinutes()).slice(-2) + '.';
  }

  function systemPrompt(now) {
    return [
      'Eres "Oso", el asistente de voz de un celular en Perú. ' + today(now),
      'Contesta SIEMPRE en una sola línea con una de estas dos formas:',
      '1) Si pide hacer algo en el celular: ACCION seguido de un JSON. Tipos posibles:',
      '{"tipo":"llamar","contacto":"nombre"}',
      '{"tipo":"whatsapp","contacto":"nombre","mensaje":"texto"}',
      '{"tipo":"alarma","hora":0-23,"minutos":0-59}',
      '{"tipo":"temporizador","segundos":numero}',
      '{"tipo":"linterna","encender":true o false}',
      '{"tipo":"ir_a","destino":"lugar"}',
      '{"tipo":"buscar_lugar","consulta":"qué buscar cerca"}',
      '{"tipo":"gasolina","combustible":"regular|premium|diesel|glp|gnv","marcas":["Primax"]}',
      '2) Si es una pregunta o conversación: RESPUESTA seguido de la respuesta en español, corta (máximo 2 frases), sin emojis ni listas.',
      'Si no sabes algo con seguridad, dilo con honestidad. No inventes datos ni noticias: no tienes internet.'
    ].join('\n');
  }

  // Ejemplos que se le muestran al modelo (pocos, para que responda rápido)
  var EXAMPLES = [
    ['avísale a mi esposa que llego tarde', 'ACCION {"tipo":"whatsapp","contacto":"esposa","mensaje":"Llego tarde"}'],
    ['necesito luz', 'ACCION {"tipo":"linterna","encender":true}'],
    ['despiértame mañana tempranito a las cinco y media', 'ACCION {"tipo":"alarma","hora":5,"minutos":30}'],
    ['comunícame con el doctor Ramírez', 'ACCION {"tipo":"llamar","contacto":"doctor Ramírez"}'],
    ['tengo hambre, hay alguna pollería por aquí', 'ACCION {"tipo":"buscar_lugar","consulta":"pollerías"}'],
    ['cuánto es el 15 por ciento de 230', 'RESPUESTA El 15 por ciento de 230 es 34,5.']
  ];

  function turn(role, text) { return '<|im_start|>' + role + '\n' + text + '<|im_end|>\n'; }

  // history: [{user, assistant}] de esta sesión (para preguntas de seguimiento)
  function buildPrompt(text, history, now) {
    var p = turn('system', systemPrompt(now || new Date()));
    EXAMPLES.forEach(function (e) { p += turn('user', e[0]) + turn('assistant', e[1]); });
    (history || []).slice(-3).forEach(function (h) { p += turn('user', h.user) + turn('assistant', h.assistant); });
    return p + turn('user', text) + '<|im_start|>assistant\n';
  }

  // Preguntas: instrucciones mínimas (sin lista de acciones ni ejemplos) -> mucho menos que procesar.
  // El modelo contesta texto directo, sin "RESPUESTA".
  function buildQuestionPrompt(text, history, now) {
    var p = turn('system', 'Eres "Oso", asistente de voz de un celular en Perú. ' + today(now || new Date()) +
      ' Responde en español, corto (máximo 2 frases), sin emojis ni listas. Si no sabes algo con seguridad, dilo; no tienes internet.');
    (history || []).slice(-2).forEach(function (h) {
      p += turn('user', h.user) + turn('assistant', h.assistant.replace(/^RESPUESTA\s*/, ''));
    });
    return p + turn('user', text) + '<|im_start|>assistant\n';
  }

  // Corta el texto que va llegando en oraciones completas para ir leyéndolas en voz alta.
  // Devuelve {ready: [oraciones completas], rest: lo que falta}
  function takeSentences(buffer) {
    var ready = [], m, re = /^[\s\S]*?[.!?…](?=\s|$)/;
    while ((m = re.exec(buffer)) && m[0].trim().length >= 12) {
      ready.push(m[0].trim());
      buffer = buffer.slice(m[0].length);
    }
    return { ready: ready, rest: buffer };
  }

  // ------------------------------------------------------------ interpretar la respuesta

  var FUELS = { regular: 'regular', '90': 'regular', premium: 'premium', '95': 'premium', '97': 'premium',
                diesel: 'diesel', petroleo: 'diesel', glp: 'glp', gnv: 'gnv', '84': 'g84' };
  var BRANDS = ['Primax', 'Repsol', 'Petroperú', 'Pecsa', 'Mobil', 'Shell', 'Terpel', 'Puma'];

  function int(v, min, max) {
    var n = parseInt(v, 10);
    return isNaN(n) || n < min || n > max ? null : n;
  }

  function extractJson(s) {
    var start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
  }

  // Convierte la acción del modelo en el mismo formato que usa intents.js (o null si no sirve).
  function toIntent(a) {
    if (!a || typeof a !== 'object') return null;
    var tipo = P.normalize(a.tipo || a.type || '');
    var t;
    switch (tipo) {
      case 'llamar':
        return a.contacto ? { type: 'call', name: P.normalize(a.contacto) } : null;
      case 'whatsapp':
        return a.contacto ? { type: 'whatsapp', name: P.normalize(a.contacto), message: String(a.mensaje || '').trim() } : null;
      case 'alarma':
        var hour = int(a.hora, 0, 23), minutes = int(a.minutos === undefined ? 0 : a.minutos, 0, 59);
        return hour === null || minutes === null ? null : { type: 'alarm', time: { hour: hour, minutes: minutes } };
      case 'temporizador':
        t = int(a.segundos, 1, 24 * 3600);
        return t ? { type: 'timer', seconds: t } : null;
      case 'linterna':
        return { type: 'torch', on: a.encender === undefined ? null : !!a.encender && a.encender !== 'false' };
      case 'ir a':
      case 'ir_a':
      case 'navegar':
        return a.destino ? { type: 'place', mode: 'navigate', query: String(a.destino) } : null;
      case 'buscar lugar':
      case 'buscar_lugar':
        return a.consulta ? { type: 'place', mode: 'search', query: String(a.consulta) } : null;
      case 'gasolina':
        var fuel = FUELS[P.normalize(a.combustible || '')] || null;
        var brands = (Array.isArray(a.marcas) ? a.marcas : []).map(function (m) {
          var n = P.normalize(m);
          return BRANDS.filter(function (b) { return P.normalize(b) === n; })[0];
        }).filter(Boolean);
        return { type: 'fuel', fuel: { fuel: fuel, brands: brands, radiusKm: null, sort: 'price', anyBrand: !brands.length } };
    }
    return null;
  }

  // "ACCION {...}" -> {kind:'action', intent} · "RESPUESTA ..." -> {kind:'answer', text}
  function parseReply(raw) {
    var s = String(raw || '').replace(/<\|im_end\|>[\s\S]*$/, '').trim();
    var firstLine = s.split('\n')[0].trim();
    var m = /^(ACCI[OÓ]N|ACTION)\s*:?\s*/i.exec(firstLine);
    if (m || /^\{/.test(firstLine)) {
      var intent = toIntent(extractJson(s));
      return intent ? { kind: 'action', intent: intent } : { kind: 'none' };   // acción inválida: no leer el JSON
    }
    var answer = s.replace(/^(RESPUESTA|ANSWER)\s*:?\s*/i, '').replace(/\s+/g, ' ').trim();
    if (!answer || /^\{/.test(answer)) return { kind: 'none' };
    return { kind: 'answer', text: answer };
  }

  // Texto que se muestra mientras el modelo escribe (oculta el prefijo y el JSON)
  function streamingView(partial) {
    var s = String(partial || '');
    if (s.trim().length < 5) return null;             // aún no se sabe si es acción o respuesta
    if (/^\s*(ACCI|ACTI|\{)/i.test(s)) return null;   // es una acción: no mostrar el JSON
    return s.replace(/^\s*(RESPUESTA|ANSWER)?\s*:?\s*/i, '');
  }

  // ¿Conviene preguntarle a la IA aunque una regla haya encontrado algo? (preguntas generales)
  var QUESTION_RE = /^(que es|que son|quien es|quien fue|por que|porque|como se|como hago|como puedo|cual es|cuales son|cuanto es|cuanto cuesta|cuantos|cuantas|explica|explicame|dime|cuentame|recomiendame|que me recomiendas|sabes|traduce|calcula)\b/;

  function looksLikeQuestion(text) {
    return QUESTION_RE.test(P.normalize(text));
  }

  var api = { buildPrompt: buildPrompt, buildQuestionPrompt: buildQuestionPrompt, parseReply: parseReply,
              toIntent: toIntent, streamingView: streamingView, looksLikeQuestion: looksLikeQuestion,
              takeSentences: takeSentences };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GasBrain = api;
})(this);
