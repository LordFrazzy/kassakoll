/* Tolkar OCR-text från svenska kvitton: butik, datum, summa, kategori. */
(function (root) {
  'use strict';

  var AMOUNT_RE = /(\d{1,3}(?:[  .]\d{3})+|\d+)[.,]\d{2}(?!\d)/g;

  function parseAmount(raw) {
    var s = String(raw).replace(/[\s ]/g, '');
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/\.\d{1,2}$/.test(s)) s = s.replace(/,/g, '');
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function amountsIn(line) {
    var out = [];
    var m;
    AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(line))) {
      var n = parseAmount(m[0]);
      if (n !== null) out.push(n);
    }
    return out;
  }

  function findTotal(lines) {
    var priorities = [/att\s*betala/i, /\bsumma\b/i, /\btotalt?\b/i, /\bbelopp\b/i];
    for (var p = 0; p < priorities.length; p++) {
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!priorities[p].test(line) || /moms|varav|rabatt/i.test(line)) continue;
        var a = amountsIn(line);
        if (!a.length && lines[i + 1]) a = amountsIn(lines[i + 1]);
        if (a.length) return a[a.length - 1];
      }
    }
    var best = null;
    lines.forEach(function (line) {
      if (/moms|varav|växel|kontant|kort\s*nr|org/i.test(line)) return;
      amountsIn(line).forEach(function (n) {
        if (best === null || n > best) best = n;
      });
    });
    return best;
  }

  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function findDate(text) {
    var m = text.match(/\b(20\d{2})[-./](\d{2})[-./](\d{2})\b/);
    if (m) {
      var iso = validDate(+m[1], +m[2], +m[3]);
      if (iso) return iso;
    }
    m = text.match(/\b(\d{2})[-./](\d{2})[-./](20\d{2}|\d{2})\b/);
    if (m) {
      var y = +m[3];
      if (y < 100) y += 2000;
      return validDate(y, +m[2], +m[1]);
    }
    return null;
  }

  function findStore(lines) {
    for (var i = 0; i < Math.min(lines.length, 8); i++) {
      var l = lines[i].replace(/^[^A-Za-zÅÄÖåäö0-9]+|[^A-Za-zÅÄÖåäö0-9)]+$/g, '').trim();
      var letters = (l.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
      if (letters < 3) continue;
      if (letters < l.replace(/\s/g, '').length * 0.6) continue;
      if (/kvitto|org\.?\s*nr|tel|kassa|datum|välkommen|öppet|www\.|@/i.test(l)) continue;
      return l.slice(0, 40);
    }
    return '';
  }

  var CATEGORY_HINTS = [
    ['Mat', /ica|coop|willys|hemk[öo]p|lidl|city\s*gross|mat|pizza|burger|max\b|mcdonald|restaurang|caf[ée]|kebab|sushi|bageri|espresso|starbucks/i],
    ['Transport', /sl\b|sj\b|buss|tåg|taxi|uber|bolt|circle\s*k|preem|okq8|ingo|shell|parkering|bensin|diesel/i],
    ['Kläder', /h\s*&\s*m|hm\b|zara|lindex|kappahl|jack\s*&\s*jones|stadium|xxl|intersport|sko|kläder/i],
    ['Hälsa', /apotek|apoteket|vårdcentral|tandl[äa]kare|kronans/i],
    ['Nöje', /bio|filmstaden|spotify|netflix|steam|spel|konsert|biljett/i],
    ['Skola', /akademibokhandeln|bokus|skol|kurs|litteratur/i],
    ['Fritid', /hockey|sport|gym|hobby|biltema|clas\s*ohlson|jula/i]
  ];

  function guessCategory(text) {
    for (var i = 0; i < CATEGORY_HINTS.length; i++) {
      if (CATEGORY_HINTS[i][1].test(text)) return CATEGORY_HINTS[i][0];
    }
    return '';
  }

  function parseReceipt(text) {
    var lines = String(text || '')
      .split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(Boolean);
    var store = findStore(lines);
    return {
      store: store,
      date: findDate(lines.join('\n')),
      amount: findTotal(lines),
      category: guessCategory(store + ' ' + lines.slice(0, 12).join(' '))
    };
  }

  var api = { parseAmount: parseAmount, parseReceipt: parseReceipt, findTotal: findTotal, findDate: findDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KvittoParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
