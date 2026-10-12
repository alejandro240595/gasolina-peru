// Lee directamente el Excel de Osinergmin para tener los precios del momento.
// Las ubicaciones y marcas siguen viniendo de data/stations.json; aquí solo se actualizan precios.
(function (root) {
  'use strict';

  var URL = 'https://www.osinergmin.gob.pe/seccion/centro_documental/hidrocarburos/SCOP/SCOP-DOCS/' +
    '{year}/Registro-precios/Ultimos-Precios-Registrados-EVPC.xlsx';

  // Igual que FUELS en pipeline/build_data.py
  var FUELS = {
    '06': 'g84', '124': 'gas90', '125': 'gas95', '126': 'g90', '127': 'g95',
    '39': 'diesel', '40': 'diesel', '49': 'glp', '131': 'gnv'
  };

  function decodeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  function sharedStrings(xml) {
    var out = [];
    var si = /<si>([\s\S]*?)<\/si>/g, t = /<t[^>]*>([^<]*)<\/t>/g, m, n;
    while ((m = si.exec(xml))) {
      var text = '';
      t.lastIndex = 0;
      while ((n = t.exec(m[1]))) text += n[1];
      out.push(decodeXml(text));
    }
    return out;
  }

  // número de serie de Excel (días desde 1899-12-30) -> "YYYY-MM-DD"
  function excelDate(serial) {
    var d = new Date(Math.round((serial - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }

  function parseXlsx(bytes, fflate) {
    var files = fflate.unzipSync(bytes, {
      filter: function (f) { return f.name === 'xl/sharedStrings.xml' || f.name === 'xl/worksheets/sheet1.xml'; }
    });
    var dec = new TextDecoder('utf-8');
    var strings = sharedStrings(dec.decode(files['xl/sharedStrings.xml']));
    var sheet = dec.decode(files['xl/worksheets/sheet1.xml']);

    var rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    var cellRe = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<v>([^<]*)<\/v>)?<\/c>)/g;
    var col = null, prices = {}, rows = 0, m, c;

    while ((m = rowRe.exec(sheet))) {
      var cells = {};
      cellRe.lastIndex = 0;
      while ((c = cellRe.exec(m[1]))) {
        if (c[3] === undefined) continue;
        cells[c[1]] = / t="s"/.test(c[2]) ? strings[+c[3]] : c[3];
      }
      if (!col) {   // primera fila: nombre de columna -> letra
        col = {};
        Object.keys(cells).forEach(function (k) { col[String(cells[k]).trim()] = k; });
        continue;
      }
      var sid = String(cells[col.CODIGO_OSINERG] || '').trim();
      var fuel = FUELS[String(cells[col.COD_PRODUCTO] || '').trim()];
      var price = parseFloat(cells[col.PRECIO_VENTA]);
      var active = String(cells[col.PRODUCTO_ACTIVO] || 'SI').toUpperCase() === 'SI';
      if (!sid || !fuel || !(price > 0) || !active) continue;
      var raw = cells[col.FCHA_REGISTRO];
      var date = /^\d+(\.\d+)?$/.test(raw) ? excelDate(parseFloat(raw)) : String(raw || '').slice(0, 10);
      var st = prices[sid] || (prices[sid] = {});
      if (!st[fuel] || price < st[fuel][0]) st[fuel] = [Math.round(price * 100) / 100, date];
      rows++;
    }
    return { prices: prices, rows: rows };
  }

  function base64ToBytes(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function header(headers, name) {
    var key = Object.keys(headers || {}).filter(function (k) { return k.toLowerCase() === name; })[0];
    return key ? headers[key] : null;
  }

  // Descarga con CapacitorHttp (nativo, sin restricciones CORS). Prueba el año actual y el anterior.
  function download(http) {
    var year = new Date().getFullYear();
    function attempt(y) {
      return http.request({ method: 'GET', url: URL.replace('{year}', y), responseType: 'arraybuffer',
                            connectTimeout: 20000, readTimeout: 60000 })
        .then(function (res) {
          if (res.status !== 200) throw new Error('Osinergmin respondió ' + res.status);
          var bytes = typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data);
          if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('El archivo de Osinergmin no es un Excel válido');
          return { bytes: bytes, modified: header(res.headers, 'last-modified') };
        });
    }
    return attempt(year).catch(function (err) {
      if (/ 404$/.test(err.message)) return attempt(year - 1);
      throw err;
    });
  }

  var api = { parseXlsx: parseXlsx, download: download };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GasOsinergmin = api;
})(this);
