/* Tolkar OCR-text från svenska kvitton: butik, datum, summa, kategori.
   OCR läser ofta fel på kvitton (O i stället för 0, l i stället för 1, mellanslag i belopp),
   så texten tvättas först och totalen väljs genom att väga ihop flera ledtrådar. */
(function (root) {
  'use strict';

  /* ---------- Belopp ---------- */

  // Bokstäver som OCR ofta läser i stället för siffror. Byts bara inne i sifferliknande ord.
  var DIGITLIKE = { O: '0', o: '0', D: '0', Q: '0', l: '1', I: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', g: '9' };

  function fixDigits(line) {
    // Ett "ord" som till största delen är siffror (t.ex. "1O9,9O" eller "l49.00") tvättas
    return line.replace(/[0-9OoDQlIi|SsBZzg]+(?:[., ]\s?[0-9OoDQlIi|SsBZzg]{2})?(?![A-Za-zÅÄÖåäö])/g, function (tok) {
      var digits = (tok.match(/\d/g) || []).length;
      var letters = tok.replace(/[\d., ]/g, '').length;
      if (!digits || letters > digits) return tok;
      return tok.replace(/[OoDQlIi|SsBZzg]/g, function (c) { return DIGITLIKE[c]; });
    });
  }

  // Belopp med två decimaler, med eller utan tusentalsavgränsare. Även "149,-".
  var AMOUNT_RE = /(-)?(\d{1,3}(?:[  .]\d{3})+|\d+)\s?[.,]\s?(\d{2})(?![\d.,])|(\d+)[.,]-/g;

  function parseAmount(raw) {
    var s = String(raw).replace(/[\s ]/g, '');
    if (/[.,:]-$/.test(s)) return parseFloat(s);
    var m = s.match(/^(-?)([\d.,]*?)[.,:](\d{2})$/);
    if (!m) { var n0 = parseFloat(s.replace(',', '.')); return isFinite(n0) ? n0 : null; }
    var n = parseFloat(m[1] + m[2].replace(/[.,]/g, '') + '.' + m[3]);
    return isFinite(n) ? n : null;
  }

  function amountsIn(line) {
    var out = [];
    var m;
    // Datum och klockslag ska inte läsas som belopp
    var clean = fixDigits(line)
      .replace(/\b\d{1,4}[-./]\d{1,2}[-./]\d{2,4}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
    AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(clean))) {
      if (m[1]) continue; // negativa belopp (rabatter, returer)
      var n = m[4] ? parseFloat(m[4]) : parseAmount(m[2] + '.' + m[3]);
      // Orimliga belopp är oftast telefonnummer, org.nr eller streckkoder
      if (n !== null && n > 0 && n < 100000) out.push(n);
    }
    return out;
  }

  // Bokstäver som OCR läser fel i nyckelord: "T0TALT", "Att betaIa", "SUHMA"
  function keyText(line) {
    return line.toLowerCase().replace(/0/g, 'o').replace(/[1|!]/g, 'l').replace(/rn/g, 'm').replace(/[^a-zåäö]/g, '');
  }

  // Ord som pekar ut totalen, i fallande säkerhet
  var TOTAL_KEYS = [
    [/attbetala|attbet/, 10],
    [/totalsumma|slutsumma|totalbelopp/, 9],
    [/^totalt?|totalt?sek|^summa|summasek|summakr/, 8],
    [/totalt?|summa/, 6],
    [/kortbetalning|bankkort|kontokort|debitkort|kreditkort|betalkort|visa|mastercard|maestro|amex|swish|kort(?!nr)/, 5],
    [/erlagt|betalt|belopp/, 4]
  ];
  // Rader som innehåller belopp som INTE är totalen
  var NOT_TOTAL = /moms|varav|netto|exkl|brutto|rabatt|spar|erhåll|växel|vaxel|återbet|aterbet|retur|pant|bonus|poäng|poang|kortnr|orgnr|organisationsnr|telefon|kvittonr|kassör|kassor|ref|antal|apris|jmf|krkg|perkg|kontant|tillbaka/;

  function findTotal(lines) {
    findTotal.sure = false;
    var scores = {};
    var counts = {};
    var all = [];
    lines.forEach(function (line, i) {
      var key = keyText(line);
      var excluded = NOT_TOTAL.test(key) || /%/.test(line);
      var amounts = amountsIn(line);
      amounts.forEach(function (n) {
        counts[n] = (counts[n] || 0) + 1;
        if (!excluded) all.push(n);
      });
      if (excluded) return;
      for (var k = 0; k < TOTAL_KEYS.length; k++) {
        if (!TOTAL_KEYS[k][0].test(key)) continue;
        // Beloppet står på samma rad, annars ofta på raden under (om den inte är t.ex. en momsrad)
        var next = lines[i + 1];
        var found = amounts.length ? amounts
          : (next && !NOT_TOTAL.test(keyText(next)) && !/%/.test(next) ? amountsIn(next) : []);
        if (found.length) {
          var n = found[found.length - 1];
          scores[n] = Math.max(scores[n] || 0, TOTAL_KEYS[k][1]);
        }
        break;
      }
    });

    var max = all.length ? Math.max.apply(null, all) : null;
    var best = null;
    var bestScore = -1;
    Object.keys(scores).forEach(function (k) {
      var n = Number(k);
      var s = scores[k];
      if (counts[n] > 1) s += 3;     // totalen står ofta två gånger (summa + kortbetalning)
      if (n === max) s += 2;         // och är oftast det största beloppet
      if (s > bestScore || (s === bestScore && n > best)) { best = n; bestScore = s; }
    });
    if (best !== null) { findTotal.sure = true; return best; }

    // Inga nyckelord hittades: ta ett belopp som står flera gånger, annars det största
    var repeated = all.filter(function (n) { return counts[n] > 1; });
    if (repeated.length) return Math.max.apply(null, repeated);
    return max;
  }

  /* ---------- Datum ---------- */

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };

  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  // Ett kvittodatum ska ligga mellan två år bak och i morgon
  function plausible(iso, now) {
    if (!iso) return false;
    var t = new Date(iso + 'T12:00').getTime();
    return t <= now + 86400000 * 1.5 && t >= now - 86400000 * 730;
  }

  function findDate(text, nowMs) {
    var now = nowMs || Date.now();
    var src = fixDigits(String(text));
    var found = [];
    function add(iso, score) { if (plausible(iso, now)) found.push({ iso: iso, score: score }); }
    var m;
    var re;

    // 2026-10-25, 2026/10/25, 2026.10.25
    re = /\b(20\d{2})\s?[-./]\s?(\d{1,2})\s?[-./]\s?(\d{1,2})\b/g;
    while ((m = re.exec(src))) add(validDate(+m[1], +m[2], +m[3]), 10);
    // 20261025
    re = /\b(20\d{2})(\d{2})(\d{2})\b/g;
    while ((m = re.exec(src))) add(validDate(+m[1], +m[2], +m[3]), 6);
    // 25.10.2026, 25/10/2026, 25-10-2026
    re = /\b(\d{1,2})\s?[-./]\s?(\d{1,2})\s?[-./]\s?(20\d{2})\b/g;
    while ((m = re.exec(src))) add(validDate(+m[3], +m[2], +m[1]), 9);
    // Två siffror på varje plats: svenskt kort format 26-10-25 (ÅÅ-MM-DD) eller 25/10/26 (DD/MM/ÅÅ)
    re = /\b(\d{2})\s?([-./])\s?(\d{2})\s?[-./]\s?(\d{2})\b/g;
    while ((m = re.exec(src))) {
      add(validDate(2000 + +m[1], +m[3], +m[4]), m[2] === '-' ? 8 : 5);
      add(validDate(2000 + +m[4], +m[3], +m[1]), m[2] === '-' ? 5 : 8);
    }
    // 251025 eller 261025 (sex siffror i rad, bara nära "datum")
    re = /datum\D{0,6}(\d{6})\b/gi;
    while ((m = re.exec(src))) {
      add(validDate(2000 + +m[1].slice(0, 2), +m[1].slice(2, 4), +m[1].slice(4, 6)), 4);
      add(validDate(2000 + +m[1].slice(4, 6), +m[1].slice(2, 4), +m[1].slice(0, 2)), 3);
    }
    // 25 okt 2026, 25 oktober 2026
    re = /\b(\d{1,2})\s+([a-zåäö]{3})[a-zåäö]*\.?\s+(20\d{2})\b/gi;
    while ((m = re.exec(src))) {
      var mon = MONTHS[m[2].toLowerCase()];
      if (mon) add(validDate(+m[3], mon, +m[1]), 9);
    }

    if (!found.length) return null;
    // Högst poäng vinner; vid lika det som ligger närmast idag
    found.sort(function (a, b) {
      return b.score - a.score || Math.abs(new Date(a.iso).getTime() - now) - Math.abs(new Date(b.iso).getTime() - now);
    });
    return found[0].iso;
  }

  /* ---------- Butik och kategori ---------- */

  // Kända kedjor: [mönster mot tvättad text, visningsnamn, kategori]
  var CHAINS = [
    [/ica/, 'ICA', 'Mat'], [/coop/, 'Coop', 'Mat'], [/willys/, 'Willys', 'Mat'], [/hemk[oö]p/, 'Hemköp', 'Mat'],
    [/lidl/, 'Lidl', 'Mat'], [/citygross/, 'City Gross', 'Mat'], [/tempo\b/, 'Tempo', 'Mat'], [/matsmart|motatos/, 'Motatos', 'Mat'],
    [/mathem/, 'Mathem', 'Mat'], [/pressbyr[aå]n/, 'Pressbyrån', 'Mat'], [/seveneleven|7eleven/, '7-Eleven', 'Mat'],
    [/mcdonald/, "McDonald's", 'Mat'], [/burgerking/, 'Burger King', 'Mat'], [/^max|maxburgers|maxhamburgare/, 'Max', 'Mat'],
    [/espressohouse/, 'Espresso House', 'Mat'], [/starbucks/, 'Starbucks', 'Mat'], [/subway/, 'Subway', 'Mat'],
    [/pizzahut/, 'Pizza Hut', 'Mat'], [/sushi/, '', 'Mat'], [/foodora/, 'Foodora', 'Mat'], [/wolt/, 'Wolt', 'Mat'],
    [/systembolaget/, 'Systembolaget', 'Övrigt'],
    [/circlek/, 'Circle K', 'Transport'], [/okq8/, 'OKQ8', 'Transport'], [/preem/, 'Preem', 'Transport'],
    [/ingo\b/, 'Ingo', 'Transport'], [/\bst1\b|^st1/, 'St1', 'Transport'], [/shell/, 'Shell', 'Transport'],
    [/sjab|\bsj\b|^sj/, 'SJ', 'Transport'], [/storstockholmslokaltrafik|^sl\b|slaccess/, 'SL', 'Transport'],
    [/v[aä]sttrafik/, 'Västtrafik', 'Transport'], [/sk[aå]netrafiken/, 'Skånetrafiken', 'Transport'], [/easypark|parkering/, '', 'Transport'],
    [/hm\b|hennesmauritz|^hm/, 'H&M', 'Kläder'], [/zara/, 'Zara', 'Kläder'], [/lindex/, 'Lindex', 'Kläder'], [/kappahl/, 'KappAhl', 'Kläder'],
    [/jackjones/, 'Jack & Jones', 'Kläder'], [/dressmann/, 'Dressmann', 'Kläder'], [/weekday/, 'Weekday', 'Kläder'],
    [/zalando/, 'Zalando', 'Kläder'], [/stadium/, 'Stadium', 'Kläder'], [/xxl/, 'XXL', 'Kläder'], [/intersport/, 'Intersport', 'Kläder'],
    [/scorett|skopunkten|nilson/, '', 'Kläder'],
    [/apotekhj[aä]rtat/, 'Apotek Hjärtat', 'Hälsa'], [/kronansapotek/, 'Kronans Apotek', 'Hälsa'], [/apoteket/, 'Apoteket', 'Hälsa'],
    [/lloydsapotek/, 'Lloyds Apotek', 'Hälsa'], [/apotek/, '', 'Hälsa'], [/tandl[aä]kare|v[aå]rdcentral/, '', 'Hälsa'],
    [/filmstaden/, 'Filmstaden', 'Nöje'], [/spotify/, 'Spotify', 'Nöje'], [/netflix/, 'Netflix', 'Nöje'], [/steam/, 'Steam', 'Nöje'],
    [/ticketmaster|tickster/, '', 'Nöje'], [/webhallen/, 'Webhallen', 'Nöje'], [/elgiganten/, 'Elgiganten', 'Nöje'],
    [/akademibokhandeln/, 'Akademibokhandeln', 'Skola'], [/adlibris/, 'Adlibris', 'Skola'], [/bokus/, 'Bokus', 'Skola'],
    [/clasohlson/, 'Clas Ohlson', 'Fritid'], [/biltema/, 'Biltema', 'Fritid'], [/jula/, 'Jula', 'Fritid'],
    [/ikea/, 'IKEA', 'Boende'], [/[aå]hl[eé]ns/, 'Åhléns', 'Övrigt'], [/rusta/, 'Rusta', 'Boende'], [/normal/, 'Normal', 'Övrigt'],
    [/dollarstore/, 'Dollarstore', 'Övrigt'], [/granit/, 'Granit', 'Boende'], [/bauhaus/, 'Bauhaus', 'Boende'], [/byggmax/, 'Byggmax', 'Boende'],
    [/sats\b|friskis|nordicwellness|actic/, '', 'Fritid']
  ];

  // Ord för kategori när ingen kedja känns igen
  var CATEGORY_WORDS = [
    ['Mat', /livs|matbutik|pizzeria|pizza|burger|restaurang|caf[eé]|kebab|bageri|konditori|grill|thai/],
    ['Transport', /taxi|uber|bolt|buss|t[aå]g|bensin|diesel|drivmedel|laddning/],
    ['Kläder', /kl[aä]der|mode|skor/],
    ['Nöje', /bio|biljett|konsert|spel/],
    ['Fritid', /gym|tr[aä]ning|sport|hobby/]
  ];

  function cleanLine(l) {
    return l.replace(/^[^A-Za-zÅÄÖåäö0-9]+|[^A-Za-zÅÄÖåäö0-9)]+$/g, '').replace(/\s{2,}/g, ' ')
      .replace(/\s+\S$/, '') // ensamt tecken sist är oftast papperskanten
      .trim();
  }

  function findChain(lines) {
    var head = lines.slice(0, 14);
    for (var i = 0; i < head.length; i++) {
      var key = keyText(head[i]);
      for (var c = 0; c < CHAINS.length; c++) {
        if (CHAINS[c][0].test(key)) return { line: head[i], name: CHAINS[c][1], category: CHAINS[c][2] };
      }
    }
    return null;
  }

  function findStore(lines, chain) {
    // ICA och Coop har många butiker: behåll t.ex. "ICA Kvantum Mölndal" om raden ser rimlig ut
    if (chain && chain.name) {
      var line = cleanLine(chain.line);
      var at = line.search(/ica|coop/i);
      if (at > 0) line = line.slice(at);
      var keepWhole = /^(ICA|Coop)$/.test(chain.name) && line.length <= 32 && /^(ica|coop)/i.test(line) &&
        (line.match(/[A-Za-zÅÄÖåäö]/g) || []).length >= line.replace(/\s/g, '').length * 0.8;
      return keepWhole ? line.replace(/^ica/i, 'ICA').replace(/^coop/i, 'Coop') : chain.name;
    }
    for (var i = 0; i < Math.min(lines.length, 8); i++) {
      var l = cleanLine(lines[i]);
      var letters = (l.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
      if (letters < 3) continue;
      if (letters < l.replace(/\s/g, '').length * 0.6) continue;
      if (/kvitto|org\.?\s*nr|tel|kassa|datum|v[aä]lkommen|[oö]ppet|www\.|@|ab$/i.test(l) && letters < 12) continue;
      if (/kvitto|org\.?\s*nr|telefon|v[aä]lkommen|[oö]ppettider|www\.|@/i.test(l)) continue;
      return l.slice(0, 40);
    }
    return '';
  }

  function guessCategory(chain, text) {
    if (chain && chain.category) return chain.category;
    var key = keyText(text);
    for (var i = 0; i < CATEGORY_WORDS.length; i++) {
      if (CATEGORY_WORDS[i][1].test(key)) return CATEGORY_WORDS[i][0];
    }
    return '';
  }

  function parseReceipt(text, nowMs) {
    var lines = String(text || '')
      .split(/\r?\n/)
      .map(function (l) { return l.trim().replace(/^[^sd]s+(?=S)/, '').replace(/s+[^sd]$/, '').trim(); })
      .filter(Boolean);
    var amount = findTotal(lines);
    var chain = findChain(lines);
    var store = findStore(lines, chain);
    return {
      store: store,
      date: findDate(lines.join('\n'), nowMs),
      amount: amount,
      amountSure: findTotal.sure,
      category: guessCategory(chain, store + ' ' + lines.slice(0, 12).join(' '))
    };
  }

  /* ---------- Bankutdrag (skärmdump från bankappen) ---------- */

  // Ett belopp på en bankrad: "-245,50", "−1 245,50 kr", "-SEK 245.50", "-245 kr", "245,50"
  // OCR läser ofta minustecknet som ~, = eller ett långt streck
  var BANK_AMOUNT_RE = /([-−–—~=+])?\s?(?:(?:SEK|kr)\s?)?(\d{1,3}(?:[  .]\d{3})+|\d+)(?:\s?[.,]\s?(\d{2}))?(?!\d)(\s?(?:kr|SEK)\b)?/gi;
  var WEEKDAYS = /^([il1|]\s?dag|[il1|]\s?går|today|yesterday|mån|tis|ons|tors?|fre|lör|sön)(dag)?\.?(?![a-zåäö])/i;

  // Byter datum och klockslag mot mellanslag (samma längd, så att positionerna stämmer)
  function maskDates(line) {
    var blank = function (t) { return t.replace(/./g, ' '); };
    return line
      .replace(/\b\d{2,4}[-./]\d{1,2}[-./]\d{1,4}\b/g, blank)
      .replace(/\b\d{1,2}[/.]\d{1,2}\b(?![.,]\d)/g, blank)
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, blank)
      .replace(/\b\d{1,2}\.?\s(?:jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)/gi, blank);
  }

  // oreMode: banken visar alltid ören, så ett heltal utan "kr" är ett belopp där OCR tappade kommat ("-24550" = 245,50)
  function bankAmounts(line, oreMode) {
    var out = [];
    var m;
    var src = maskDates(line);
    BANK_AMOUNT_RE.lastIndex = 0;
    while ((m = BANK_AMOUNT_RE.exec(src))) {
      var hasDec = m[3] != null;
      var hasSign = !!m[1] && m[1] !== '+';
      var hasKr = !!m[4] || /SEK|kr/i.test(m[0].slice(0, 6));
      // Heltal räknas bara som belopp med minustecken eller "kr" (annars är det t.ex. ett datum eller kortnummer)
      if (!hasDec && !hasSign && !hasKr) continue;
      var digits = m[2].replace(/[\s .]/g, '');
      var guessed = false;
      var n;
      if (hasDec) n = parseFloat(digits + '.' + m[3]);
      else if (oreMode && !hasKr && digits.length >= 3) { n = parseFloat(digits) / 100; guessed = true; }
      else if (/^\d{5,}$/.test(m[2])) continue;
      else n = parseFloat(digits);
      if (!isFinite(n) || n <= 0 || n >= 1000000) continue;
      out.push({ value: n, negative: hasSign, plus: m[1] === '+', index: m.index, text: m[0], hasDec: hasDec, hasKr: hasKr, guessed: guessed });
    }
    return out;
  }

  // Visar banken ören på beloppen? (minst ett belopp med decimaler och inga heltal med "kr")
  function showsOre(lines) {
    var dec = 0, krInt = 0;
    lines.forEach(function (l) {
      bankAmounts(l, false).forEach(function (a) { if (a.hasDec) dec++; else if (a.hasKr) krInt++; });
    });
    return dec > 0 && krInt === 0;
  }

  // Datum skrivet med siffror (2026-11-19, 19.11.2026), inte en rubrik som "Igår" eller "18 november"
  var NUMERIC_DATE = /\b(20\d{2}\s?-?\s?\d{2}\s?-?\s?\d{2}|\d{1,2}[./]\d{1,2}[./]20\d{2})\b/;

  // Datum på en rad eller som rubrik. Utan årtal väljs det år som gör att datumet inte ligger i framtiden.
  function bankDate(line, now) {
    var d = new Date(now);
    var src = line.toLowerCase();
    // OCR läser ofta stora I som l, 1 eller |
    if (/^\s*([il1|]\s?dag|today)\b/.test(src)) return isoOfDate(d);
    if (/^\s*([il1|]\s?går|yesterday)(?![a-zåäö])/.test(src)) { d.setDate(d.getDate() - 1); return isoOfDate(d); }
    var full = findDate(line, now);
    if (full) return full;
    var m = src.match(/\b(\d{1,2})\s?(?:\.|\s)\s?([a-zåäö]{3})[a-zåäö]*\.?(?:\s+(20\d{2}))?/);
    if (m && MONTHS[m[2]]) return withYear(+m[1], MONTHS[m[2]], m[3] ? +m[3] : 0, now);
    m = src.match(/^\s*(\d{1,2})\s?[/.]\s?(\d{1,2})\b(?![/.]\d)/);
    if (m) return withYear(+m[1], +m[2], 0, now);
    // Kortköp-rader har ofta datumet som ÅÅMMDD: "KORTKÖP 251118 WILLYS"
    m = src.match(/\b(2\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
    if (m) { var iso = validDate(2000 + +m[1], +m[2], +m[3]); if (plausible(iso, now)) return iso; }
    return null;
  }

  function isoOfDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function withYear(day, month, year, now) {
    var y = year || new Date(now).getFullYear();
    var iso = validDate(y, month, day);
    if (!year && iso && new Date(iso + 'T12:00').getTime() > now + 86400000 * 1.5) iso = validDate(y - 1, month, day);
    return iso;
  }

  // Ord på bankrader som inte är en del av butiksnamnet
  var BANK_NOISE = /(?<![A-Za-zÅÄÖåäö])(kortköp|kortkop|köp|kop|reserverat|reservation|prel|preliminär|preliminart|bokförd|bokford|debitering|betalning|autogiro|e-faktura|efaktura|överföring|kortnr|sek|kr|card|purchase|pending|visa|mastercard|debit)(?![A-Za-zÅÄÖåäö])/gi;

  function cleanMerchant(text) {
    var s = text
      .replace(/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,2}\s?(?:\.|\s)\s?(?:jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)[a-zåäö]*\.?(?:\s+20\d{2})?/gi, ' ')
      .replace(/\b\d{6}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
      .replace(/\b(?=[A-Za-z]*\d[A-Za-z]*\d)(?=\w*[A-Za-z])[A-Za-z0-9]{5,}\b/g, ' ') // referenskoder som P3E4F1
      .replace(/^[KkCc]\s?[*"'”]\s?/, '') // "K*WILLYS", OCR läser ofta * som "
      .replace(BANK_NOISE, ' ')
      .replace(/[*#|_=~<>«»©®°•·…]+/g, ' ')
      .replace(/\b\d{3,}\b/g, ' ')
      .replace(/\s{2,}/g, ' ');
    s = s.replace(/^[^A-Za-zÅÄÖåäö0-9]+|[^A-Za-zÅÄÖåäö0-9)]+$/g, '').trim();
    // VERSALER från banken blir "Willys Göteborg"
    if (s && s === s.toUpperCase()) {
      s = s.toLowerCase().replace(/(^|[\s\-/&.])([a-zåäö])/g, function (_, a, b) { return a + b.toUpperCase(); });
    }
    return s.slice(0, 40);
  }

  function letterCount(s) { return (s.match(/[A-Za-zÅÄÖåäö]/g) || []).length; }

  // Tolkar texten från en skärmdump av kontohändelser till en lista med köp.
  // Varje rad: { store, date, amount, incoming, category, raw }
  function parseBank(text, nowMs) {
    var now = nowMs || Date.now();
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var rows = [];
    var currentDate = null;
    var pendingName = null; // namn på en rad utan belopp, beloppet kan stå på raden under
    var anyNegative = false;
    var oreMode = showsOre(lines);
    // Vissa banker skriver datumet på raden UNDER köpet ("ICA -245,50" / "2026-11-21").
    // dateBelow slås på första gången ett sifferdatum direkt följer ett köp som saknar datum.
    var dateBelow = false;
    var lastRowLine = -2;

    function attachDate(date, line, i) {
      var last = rows[rows.length - 1];
      if (!last || lastRowLine !== i - 1 || last.ownDate || !NUMERIC_DATE.test(line)) return false;
      if (!dateBelow && last.date) return false;
      last.date = date;
      last.ownDate = true;
      dateBelow = true;
      return true;
    }

    lines.forEach(function (line, i) {
      var amounts = bankAmounts(line, oreMode);
      var letters = letterCount(line);
      var date = bankDate(line, now);

      if (!amounts.length) {
        var rest = cleanMerchant(line.replace(WEEKDAYS, ' '));
        if (date && letterCount(rest) < 3) {
          if (attachDate(date, line, i)) return;
          // Rubrik med datum ("Idag", "Måndag 18 nov", "18 november 2026") gäller köpen under
          currentDate = date; pendingName = null; return;
        }
        if (date && WEEKDAYS.test(line)) { currentDate = date; pendingName = null; return; }
        // Kategori- eller statusrad under ett köp ("Kortköp", "Reserverat") hör till raden ovan
        if (/^(kortköp|kortkop|reserverat|swish|autogiro|e-faktura|överföring|insättning|lön|prel)/i.test(line) && rows.length && !pendingName) {
          if (lastRowLine === i - 1) lastRowLine = i;
          return;
        }
        if (letters >= 3) pendingName = { text: line, date: date };
        return;
      }

      // Det första beloppet är händelsen, ett andra är oftast saldot efter
      var a = amounts[0];
      var nameText = line.slice(0, a.index) + ' ' + line.slice(a.index + a.text.length);
      amounts.slice(1).forEach(function (b) { nameText = nameText.replace(b.text, ' '); });
      var store = cleanMerchant(nameText);
      if (letterCount(store) < 2 && pendingName) {
        store = cleanMerchant(pendingName.text);
        if (!date) date = pendingName.date;
      }
      pendingName = null;
      // Datumrad med belopp under ett köp ("2026-11-21  12 345,67"): datumet hör till köpet, beloppet är saldot
      if (letterCount(store) < 2 && date && attachDate(date, line, i)) return;
      if (letterCount(store) < 2) return; // t.ex. "Saldo 12 345,67" utan text kvar, eller skräp
      if (/^(saldo|disponibelt|tillgängligt|totalt|summa|kontosaldo|beviljad kredit)\b/i.test(store)) return;
      if (a.negative) anyNegative = true;
      var key = keyText(store);
      var key2 = store.toLowerCase().replace(/[^a-z0-9åäö]/g, ''); // behåller siffror (OKQ8, St1)
      var category = '';
      for (var c = 0; c < CHAINS.length; c++) {
        if (CHAINS[c][0].test(key) || CHAINS[c][0].test(key2)) { category = CHAINS[c][2]; if (CHAINS[c][1] && store.length > 24) store = CHAINS[c][1]; break; }
      }
      if (!category) category = guessCategory(null, store);
      rows.push({
        store: store,
        date: date || (dateBelow ? null : currentDate),
        ownDate: !!date,
        amount: Math.round(a.value * 100) / 100,
        amountGuessed: a.guessed,
        negative: a.negative,
        plus: a.plus,
        category: category,
        raw: line
      });
      lastRowLine = i;
    });

    // Har banken minustecken på köpen är rader utan minus pengar in (lön, Swish till dig)
    rows.forEach(function (r) {
      r.incoming = r.plus || (anyNegative && !r.negative) || /^(lön|insättning|swish från|återbetalning)/i.test(r.store);
      delete r.negative; delete r.plus; delete r.ownDate;
    });
    return rows;
  }

  var api = { parseAmount: parseAmount, parseReceipt: parseReceipt, parseBank: parseBank, findTotal: findTotal, findDate: findDate, amountsIn: amountsIn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KvittoParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
