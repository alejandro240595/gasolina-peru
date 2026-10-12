// Interpreta frases como "gasohol 95 en primax o repsol a 5 kilómetros".
(function (root) {
  'use strict';

  // grupo de combustible -> claves de data/stations.json
  var FUEL_GROUPS = {
    premium: { label: 'Premium (95/97)', keys: ['g95', 'gas95'] },
    regular: { label: 'Regular (90)', keys: ['g90', 'gas90'] },
    g84: { label: 'Gasolina 84', keys: ['g84'] },
    diesel: { label: 'Diésel', keys: ['diesel'] },
    glp: { label: 'GLP', keys: ['glp'] },
    gnv: { label: 'GNV', keys: ['gnv'] }
  };

  // El orden importa: "noventa y cinco" debe probarse antes que "noventa".
  var FUEL_PATTERNS = [
    ['glp', /\b(glp|gas licuado|gas de balon|autogas)\b/],
    ['gnv', /\b(gnv|gas natural)\b/],
    ['diesel', /\b(diesel|disel|diessel|petroleo|d ?2|b ?5)\b/],
    ['premium', /\b(premium|premiun|primiun|95|97|98|noventa y cinco|noventa y siete|noventaicinco|noventaisiete)\b/],
    ['g84', /\b(84|ochenta y cuatro|ochentaicuatro)\b/],
    ['regular', /\b(regular|90|noventa|normal)\b/]
  ];

  var BRAND_PATTERNS = [
    ['Primax', /\b(primax|prima x|pri max|primas|primmax)\b/],
    ['Repsol', /\b(repsol|rep sol|rebsol|repsoll|rexol)\b/],
    ['Petroperú', /\b(petroperu|petro peru)\b/],
    ['Pecsa', /\b(pecsa|pexa|peksa)\b/],
    ['Mobil', /\b(mobil|mobile)\b/],
    ['Shell', /\b(shell|chel)\b/],
    ['Terpel', /\b(terpel)\b/],
    ['Puma', /\b(puma)\b/],
    ['Energigas', /\b(energigas|energi gas)\b/],
    ['Limagas', /\b(limagas|lima gas)\b/],
    ['Gazel', /\b(gazel|gasel)\b/]
  ];

  var NUMBER_WORDS = {
    un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
    nueve: 9, diez: 10, quince: 15, veinte: 20, treinta: 30, cincuenta: 50
  };

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseCommand(text) {
    var t = normalize(text);
    var result = { fuel: null, brands: [], radiusKm: null, sort: 'price', anyBrand: false, text: t };

    // Radio: "a 5 km", "en 10 kilometros", "a dos kilometros". Se quita antes de buscar el
    // combustible para que "a 90 km" no se lea como gasohol 90.
    t = t.replace(/\b(?:a|en|de|dentro de|menos de)?\s*(\d+(?:\.\d+)?|[a-z]+)\s*(km|kilometros?|kms|kilometro)\b/,
      function (m, n) {
        var value = /^\d/.test(n) ? parseFloat(n) : NUMBER_WORDS[n];
        if (!value) return m;
        result.radiusKm = Math.min(value, 100);
        return ' ';
      });

    for (var i = 0; i < FUEL_PATTERNS.length; i++) {
      if (FUEL_PATTERNS[i][1].test(t)) { result.fuel = FUEL_PATTERNS[i][0]; break; }
    }
    BRAND_PATTERNS.forEach(function (b) {
      if (b[1].test(t)) result.brands.push(b[0]);
    });
    if (/\b(cualquier|cualquiera|todas|todos|cualquier marca|sin importar)\b/.test(t)) {
      result.anyBrand = true;
      result.brands = [];
    }
    if (/\b(cerca|cercana|cercano|cercanas|cercanos|proxima|proximo|mas cerca)\b/.test(t) &&
        !/\b(barat[oa]s?|economic[oa]s?)\b/.test(t)) {
      result.sort = 'distance';
    }
    return result;
  }

  var api = { parseCommand: parseCommand, normalize: normalize, FUEL_GROUPS: FUEL_GROUPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GasParser = api;
})(this);
