(function () {
  'use strict';

  // Standardkonton. Id = namnet så att äldre kvitton (category: 'Mat') och planer fortsätter fungera.
  var DEFAULT_ACCOUNTS = ['Mat', 'Transport', 'Fritid', 'Kläder', 'Nöje', 'Hälsa', 'Boende', 'Skola', 'Övrigt'];
  var COLORS = 9;
  var BUFFER = 'buffer';
  var TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  var state = {
    month: monthKey(new Date()),
    view: 'budget',
    accounts: [],
    manage: false,
    confirmAccDelete: null,
    alloc: null,
    receipts: [],
    plan: { month: '', income: [], limits: {} },
    inheritedFrom: null,
    editing: null,
    draftImage: null,
    scanToken: 0,
    confirmDelete: null,
    thumbUrls: []
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Hjälpfunktioner ---------- */

  function pad(n) { return String(n).padStart(2, '0'); }
  function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function todayIso() { var d = new Date(); return monthKey(d) + '-' + pad(d.getDate()); }
  function shiftMonth(key, delta) {
    var p = key.split('-').map(Number);
    return monthKey(new Date(p[0], p[1] - 1 + delta, 1));
  }
  function monthLabel(key) {
    var p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, 1).toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
  }
  var krFmt = new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 });
  var krFmt2 = new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function kr(n) { return krFmt.format(n || 0); }
  function kr2(n) { return krFmt2.format(n || 0); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function num(v) {
    var n = Number(String(v).replace(',', '.'));
    return isFinite(n) ? n : 0;
  }
  function showBanner(msg, isError) {
    var b = $('banner');
    b.textContent = msg;
    b.className = 'banner' + (isError ? ' error' : '');
    b.hidden = !msg;
  }
  // Kvittobilder är en Blob (lokalt, nytt foto) eller en länk (från molnet). Bara länkar vi själva skapat släpps.
  var ownUrls = {};
  function imageUrl(img) {
    if (typeof img === 'string') return img;
    var u = URL.createObjectURL(img);
    ownUrls[u] = true;
    return u;
  }
  function freeUrl(u) {
    if (u && ownUrls[u]) { URL.revokeObjectURL(u); delete ownUrls[u]; }
  }

  function accById(id) {
    for (var i = 0; i < state.accounts.length; i++) if (state.accounts[i].id === id) return state.accounts[i];
    return null;
  }
  function accName(id) {
    if (id === BUFFER) return 'Buffert';
    var a = accById(id);
    return a ? a.name : id;
  }
  function accColor(id) {
    var a = accById(id);
    return a ? 'var(--c' + (a.color % COLORS) + ')' : 'var(--c8)';
  }
  function sortByDate(desc) {
    return function (a, b) {
      var d = a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0);
      return desc ? -d : d;
    };
  }
  function dateLabel(iso) {
    var p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ---------- Effekter ---------- */

  function calm() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Räknar upp ett belopp från förra värdet (eller 0) till det nya
  function countTo(el, value, fmt) {
    var from = typeof el._v === 'number' ? el._v : 0;
    el._v = value;
    el._fmt = fmt;
    cancelAnimationFrame(el._raf);
    clearTimeout(el._done);
    if (calm() || from === value || el.offsetParent === null) { el.textContent = fmt(value); return; }
    var t0 = performance.now();
    var dur = 750;
    // Webbläsaren pausar animationer i dolda flikar; se till att rätt belopp alltid visas till slut
    el._done = setTimeout(function () { cancelAnimationFrame(el._raf); el.textContent = fmt(value); }, dur + 100);
    (function step(t) {
      var p = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (value - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    })(t0);
  }

  // Staplar växer fram från noll när en vy visas
  function growBars(root) {
    if (calm()) return;
    var bars = root.querySelectorAll('.bar > i, .spend-bar > i, .plan-bar > i');
    var targets = [];
    bars.forEach(function (b, i) { targets[i] = b.style.width; b.style.transition = 'none'; b.style.width = '0'; });
    void root.offsetWidth;
    bars.forEach(function (b, i) {
      b.style.transition = 'width 0.7s cubic-bezier(.2,.8,.2,1) ' + Math.min(i * 25, 300) + 'ms';
      b.style.width = targets[i];
    });
  }

  // Korten glider in en i taget när man byter flik eller månad
  function enterView(name) {
    var view = $('view-' + name);
    if (!view || calm()) return;
    view.classList.remove('enter');
    void view.offsetWidth;
    view.classList.add('enter');
    clearTimeout(view._enter);
    view._enter = setTimeout(function () { view.classList.remove('enter'); }, 900);
    growBars(view);
    view.querySelectorAll('.count').forEach(function (el) {
      if (typeof el._v !== 'number') return;
      var v = el._v;
      el._v = 0;
      countTo(el, v, el._fmt);
    });
  }

  // Konfetti när ett mål nås
  function confetti() {
    if (calm()) return;
    var c = document.createElement('canvas');
    c.className = 'confetti';
    c.setAttribute('aria-hidden', 'true');
    document.body.appendChild(c);
    var dpr = window.devicePixelRatio || 1;
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    var ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    var cs = getComputedStyle(document.documentElement);
    var colors = [0, 1, 2, 3, 4, 6].map(function (i) { return cs.getPropertyValue('--c' + i).trim() || '#e0913a'; });
    var parts = [];
    for (var i = 0; i < 140; i++) {
      var left = i % 2 === 0;
      parts.push({
        x: left ? -10 : innerWidth + 10, y: innerHeight * 0.7,
        vx: (left ? 1 : -1) * (4 + Math.random() * 7), vy: -(9 + Math.random() * 9),
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, color: colors[i % colors.length]
      });
    }
    var t0 = performance.now();
    setTimeout(function () { c.remove(); }, 4000);
    (function frame(t) {
      var age = t - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - 1800) / 700);
      parts.forEach(function (p) {
        p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        ctx.restore();
      });
      if (age < 2500) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }

  /* ---------- Data ---------- */

  async function loadAccounts() {
    var saved = await DB.get('settings', 'accounts');
    state.accounts = saved && saved.list && saved.list.length
      ? saved.list
      : DEFAULT_ACCOUNTS.map(function (n, i) { return { id: n, name: n, color: i, fallback: BUFFER }; });
  }

  async function saveAccounts() {
    await DB.put('settings', { key: 'accounts', list: state.accounts });
  }

  async function loadReceipts() {
    state.receipts = await DB.all('receipts');
  }

  async function loadPlan() {
    var plan = await DB.get('plans', state.month);
    state.inheritedFrom = null;
    if (plan) { state.plan = plan; return; }
    var plans = await DB.all('plans');
    var earlier = plans.filter(function (p) { return p.month < state.month; })
      .sort(function (a, b) { return a.month < b.month ? 1 : -1; })[0];
    if (earlier) {
      state.plan = {
        month: state.month,
        income: earlier.income.map(function (i) { return { id: uid(), name: i.name, amount: i.amount }; }),
        limits: Object.assign({}, earlier.limits)
      };
      state.inheritedFrom = earlier.month;
    } else {
      state.plan = { month: state.month, income: [], limits: {} };
    }
  }

  async function savePlan() {
    state.plan.month = state.month;
    await DB.put('plans', state.plan);
    state.inheritedFrom = null;
  }

  function monthReceipts(key) {
    return state.receipts.filter(function (r) { return r.date.slice(0, 7) === key; });
  }

  /* ---------- Konton och överdrag ---------- */

  // Går igenom månadens kvitton i datumordning. Varje kvitto tas från sitt eget konto så länge det räcker,
  // resten från kontots reservkonto (som i sin tur kan ha ett reservkonto), och till sist från bufferten.
  // Allt räknas i öre för att slippa avrundningsfel.
  function allocate() {
    var limits = state.plan.limits;
    var rem = {}, own = {}, lent = {}, spent = {}, coveredBy = {}, lentTo = {};
    var planned = 0;
    state.accounts.forEach(function (a) {
      rem[a.id] = Math.round((limits[a.id] || 0) * 100);
      planned += rem[a.id];
      own[a.id] = 0; lent[a.id] = 0; spent[a.id] = 0; coveredBy[a.id] = {}; lentTo[a.id] = {};
    });
    var income = Math.round(state.plan.income.reduce(function (s, i) { return s + i.amount; }, 0) * 100);
    var buffer = { start: income - planned, used: 0, from: {} };
    var splits = {};

    monthReceipts(state.month).sort(sortByDate(false)).forEach(function (r) {
      var cat = r.category;
      var amt = Math.round(r.amount * 100);
      var parts = [];
      if (spent.hasOwnProperty(cat)) spent[cat] += amt;
      var acc = cat;
      var seen = {};
      while (amt > 0) {
        if (acc === BUFFER || !rem.hasOwnProperty(acc) || seen[acc]) {
          buffer.used += amt;
          buffer.from[cat] = (buffer.from[cat] || 0) + amt;
          if (coveredBy[cat]) coveredBy[cat][BUFFER] = (coveredBy[cat][BUFFER] || 0) + amt;
          parts.push({ from: BUFFER, amount: amt });
          break;
        }
        seen[acc] = true;
        var take = Math.min(Math.max(rem[acc], 0), amt);
        if (take > 0) {
          rem[acc] -= take;
          amt -= take;
          parts.push({ from: acc, amount: take });
          if (acc === cat) {
            own[acc] += take;
          } else {
            lent[acc] += take;
            lentTo[acc][cat] = (lentTo[acc][cat] || 0) + take;
            coveredBy[cat][acc] = (coveredBy[cat][acc] || 0) + take;
          }
        }
        if (amt > 0) acc = (accById(acc) || {}).fallback || BUFFER;
      }
      splits[r.id] = parts;
    });

    function toKr(o) { var out = {}; Object.keys(o).forEach(function (k) { out[k] = o[k] / 100; }); return out; }
    function nestedKr(o) { var out = {}; Object.keys(o).forEach(function (k) { out[k] = toKr(o[k]); }); return out; }
    Object.keys(splits).forEach(function (id) {
      splits[id] = splits[id].map(function (p) { return { from: p.from, amount: p.amount / 100 }; });
    });
    return {
      income: income / 100,
      planned: planned / 100,
      rem: toKr(rem), own: toKr(own), lent: toKr(lent), spent: toKr(spent),
      coveredBy: nestedKr(coveredBy), lentTo: nestedKr(lentTo),
      buffer: { start: buffer.start / 100, used: buffer.used / 100, from: toKr(buffer.from) },
      splits: splits
    };
  }

  function sourceList(map) {
    return Object.keys(map).map(function (k) { return kr(map[k]) + ' från ' + esc(accName(k)); }).join(', ');
  }

  /* ---------- Budget och Spenderat ---------- */

  function renderBudget() {
    var A = state.alloc = allocate();
    renderPlan(A);
    renderSpent(A);
    renderBalance();
  }

  function spentByAccount(key) {
    var out = {};
    monthReceipts(key).forEach(function (r) { out[r.category] = (out[r.category] || 0) + r.amount; });
    return out;
  }

  function fallbackOptions(a) {
    return '<option value="' + BUFFER + '">Buffert</option>' + state.accounts.filter(function (o) { return o.id !== a.id; })
      .map(function (o) { return '<option value="' + esc(o.id) + '"' + (a.fallback === o.id ? ' selected' : '') + '>' + esc(o.name) + '</option>'; }).join('');
  }

  // Budget-fliken: inkomster, maxsumma per konto och reservkonto
  function renderPlan(A) {
    var plan = state.plan;
    var unbudgeted = A.income - A.planned;
    countTo($('plan-income'), A.income, kr);
    countTo($('plan-planned'), A.planned, kr);
    var pb = $('plan-buffer');
    countTo(pb, unbudgeted, kr);
    pb.className = unbudgeted < 0 ? 'neg' : '';

    var base = Math.max(A.income, A.planned);
    $('plan-bar').innerHTML = base > 0
      ? state.accounts.filter(function (a) { return plan.limits[a.id] > 0; }).map(function (a) {
          return '<i style="width:' + (plan.limits[a.id] / base * 100) + '%;background:' + accColor(a.id) + '" title="' + esc(a.name) + ': ' + kr(plan.limits[a.id]) + '"></i>';
        }).join('')
      : '';
    var hint;
    if (!A.income) hint = 'Börja med att lägga in dina inkomster.';
    else if (!A.planned) hint = 'Sätt en maxsumma på de konton du vill hålla koll på.';
    else if (unbudgeted < 0) hint = 'Du har budgeterat ' + kr(-unbudgeted) + ' mer än du har in. Sänk något konto.';
    else hint = kr(unbudgeted) + ' är inte budgeterat och hamnar i bufferten, som täcker konton som tar slut.';
    $('plan-hint').textContent = hint;

    var note = $('inherit-note');
    if (state.inheritedFrom) {
      note.textContent = 'Planen är hämtad från ' + monthLabel(state.inheritedFrom) + '. Den sparas för den här månaden när du ändrar något.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    $('income-list').innerHTML = plan.income.length
      ? plan.income.map(function (i) {
          return '<li><span class="name">' + esc(i.name) + '</span><span class="amt">' + kr(i.amount) + '</span>' +
            '<button class="btn btn-ghost btn-danger" type="button" data-income-del="' + esc(i.id) + '" aria-label="Ta bort ' + esc(i.name) + '">Ta bort</button></li>';
        }).join('')
      : '<li><span class="name empty">Inga inkomster inlagda för månaden.</span></li>';

    $('manage-btn').textContent = state.manage ? 'Klar' : 'Hantera konton';
    $('manage-btn').setAttribute('aria-pressed', state.manage ? 'true' : 'false');

    var prevKey = shiftMonth(state.month, -1);
    var prev = spentByAccount(prevKey);
    var prevName = monthLabel(prevKey).split(' ')[0];

    var cards = state.accounts.map(function (a, idx) {
      var limit = plan.limits[a.id] || 0;
      var head = state.manage
        ? '<div class="cat-top"><span class="dot" style="background:' + accColor(a.id) + '"></span>' +
          '<label class="sr" for="acc-name-' + idx + '">Namn på kontot</label>' +
          '<input class="acc-name-input" id="acc-name-' + idx + '" type="text" value="' + esc(a.name) + '" data-acc-rename="' + esc(a.id) + '">' +
          '<button class="btn btn-ghost btn-danger" type="button" data-acc-del="' + esc(a.id) + '">' + (state.confirmAccDelete === a.id ? 'Säker?' : 'Ta bort') + '</button></div>'
        : '<div class="cat-top"><span class="dot" style="background:' + accColor(a.id) + '"></span>' +
          '<span class="cat-name">' + esc(a.name) + '</span></div>';
      var prevText = prev[a.id] ? 'I ' + prevName + ': ' + kr(prev[a.id]) : '';
      return '<div class="cat">' + head +
        '<div class="cat-bottom"><div class="cat-meta">' + prevText + '</div>' +
        '<div class="cat-input"><label class="sr" for="lim-' + idx + '">Budget för ' + esc(a.name) + ' i kronor</label>' +
        '<input id="lim-' + idx + '" type="number" inputmode="decimal" min="0" step="any" data-cat="' + esc(a.id) + '" value="' + (limit || '') + '" placeholder="0"></div></div>' +
        '<label class="fallback"><span>Om slut, ta från</span><select data-fallback="' + esc(a.id) + '">' + fallbackOptions(a) + '</select></label>' +
        '</div>';
    }).join('');

    var addCard = '<form class="cat add-acc" id="add-acc-form" autocomplete="off">' +
      '<label class="field"><span>Nytt konto</span><input id="new-acc-name" type="text" placeholder="t.ex. Gym, Present, Resa" required></label>' +
      '<button class="btn" type="submit">Skapa konto</button></form>';

    $('cat-list').innerHTML = cards + addCard;
  }

  // Korta insikter om månaden under översikten på Spenderat
  function renderInsights(A, spent) {
    var list = monthReceipts(state.month);
    var cards = [];
    var nowKey = monthKey(new Date());
    var isNow = state.month === nowKey;
    var todayD = new Date().getDate();
    var p = state.month.split('-').map(Number);
    var daysInMonth = new Date(p[0], p[1], 0).getDate();

    // Jämför med förra månaden. Pågående månad jämförs med samma period (dag 1 till idag).
    var prevKey = shiftMonth(state.month, -1);
    var prev = monthReceipts(prevKey).filter(function (r) { return !isNow || Number(r.date.slice(8, 10)) <= todayD; })
      .reduce(function (s, r) { return s + r.amount; }, 0);
    if (prev > 0 && spent > 0) {
      var change = (spent - prev) / prev;
      var less = change < 0;
      cards.push({
        icon: less ? '▼' : '▲', tone: less ? 'good' : 'bad',
        big: Math.abs(Math.round(change * 100)) + ' % ' + (less ? 'mindre' : 'mer'),
        small: 'än i ' + monthLabel(prevKey).split(' ')[0] + (isNow ? ' vid samma tid' : '')
      });
    }

    // Kontot med mest utgifter
    var byAcc = spentByAccount(state.month);
    var top = Object.keys(byAcc).sort(function (a, b) { return byAcc[b] - byAcc[a]; })[0];
    if (top && spent > 0) {
      cards.push({ dot: accColor(top), big: accName(top), small: 'mest pengar · ' + kr(byAcc[top]) + ' (' + Math.round(byAcc[top] / spent * 100) + ' %)' });
    }

    // Största enskilda köpet
    var biggest = list.slice().sort(function (a, b) { return b.amount - a.amount; })[0];
    if (biggest) cards.push({ icon: '★', big: kr(biggest.amount), small: 'största köpet · ' + esc(biggest.store) });

    // Prognos för pågående månad
    if (isNow && spent > 0 && todayD >= 3) {
      var forecast = spent / todayD * daysInMonth;
      var ok = !A.income || forecast <= A.income;
      cards.push({
        icon: '◔', tone: ok ? '' : 'bad', big: '≈ ' + kr(forecast),
        small: 'i månaden med nuvarande takt' + (A.income ? (ok ? '' : ', mer än inkomsterna') : '')
      });
    }

    $('insights').innerHTML = cards.map(function (c) {
      var mark = c.dot ? '<span class="ins-dot" style="background:' + c.dot + '"></span>' : '<span class="ins-icon ' + (c.tone || '') + '" aria-hidden="true">' + c.icon + '</span>';
      return '<li class="insight">' + mark + '<span class="ins-text"><b>' + esc(c.big) + '</b><span>' + c.small + '</span></span></li>';
    }).join('');
    $('insights').hidden = !cards.length;
  }

  // Spenderat-fliken: hur månaden gick mot budgeten
  function renderSpent(A) {
    var spent = monthReceipts(state.month).reduce(function (s, r) { return s + r.amount; }, 0);
    var left = A.income - spent;

    var hero = $('hero-left');
    countTo(hero, left, kr);
    hero.className = 'hero-amount' + (left < 0 ? ' neg' : '');
    var sub;
    if (!A.income && !spent) sub = 'Lägg in inkomster och budget under fliken Budget för att komma igång.';
    else if (left < 0) sub = 'Du har spenderat ' + kr(-left) + ' mer än du har in den här månaden.';
    else if (A.income) sub = 'Du har använt ' + Math.round((spent / A.income) * 100) + ' % av månadens inkomster.';
    else sub = 'Inga inkomster inlagda för månaden.';
    $('hero-sub').textContent = sub;
    countTo($('stat-income'), A.income, kr);
    countTo($('stat-planned'), A.planned, kr);
    countTo($('stat-spent'), spent, kr);
    renderInsights(A, spent);

    var base = Math.max(A.income, spent);
    var byAcc = spentByAccount(state.month);
    var used = Object.keys(byAcc).map(function (id) { return { id: id, s: byAcc[id] }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; });
    $('spend-bar').innerHTML = base > 0
      ? used.map(function (x) {
          return '<i style="width:' + (x.s / base * 100) + '%;background:' + accColor(x.id) + '" title="' + esc(accName(x.id)) + ': ' + kr(x.s) + '"></i>';
        }).join('')
      : '';
    $('spend-legend').innerHTML = used.map(function (x) {
      return '<li><span class="dot" style="background:' + accColor(x.id) + '"></span>' + esc(accName(x.id)) + ' ' + kr(x.s) + '</li>';
    }).join('');

    var recent = monthReceipts(state.month).sort(sortByDate(true)).slice(0, 5);
    $('recent-list').innerHTML = recent.length
      ? recent.map(function (r) {
          return '<li><span class="ic" style="background:' + accColor(r.category) + '">' + esc(r.store.charAt(0).toUpperCase()) + '</span>' +
            '<span class="t"><div class="s">' + esc(r.store) + '</div><div class="d">' + dateLabel(r.date) + ' · ' + esc(accName(r.category)) + '</div></span>' +
            '<span class="a">' + kr2(r.amount) + '</span></li>';
        }).join('')
      : '<li class="empty">Inga köp den här månaden ännu.</li>';

    // Bufferten: det som inte är budgeterat. Tar emot överdrag.
    var bLeft = A.buffer.start - A.buffer.used;
    var bNotes = A.buffer.used > 0 ? '<p class="acc-note">Täckte överdrag: ' + Object.keys(A.buffer.from).map(function (k) {
      return esc(accName(k)) + ' ' + kr(A.buffer.from[k]);
    }).join(', ') + '</p>' : '';
    var bufferCard = '<div class="cat buffer">' +
      '<div class="cat-top"><span class="dot buffer-dot"></span><span class="cat-name">Buffert</span>' +
      '<span class="cat-left' + (bLeft < 0 ? ' over' : '') + '">' + kr(bLeft) + ' kvar</span></div>' +
      '<p class="acc-desc">Inkomster som inte är budgeterade (' + kr(A.buffer.start) + '). Tar emot det som går över på andra konton.</p>' +
      bNotes + '</div>';

    // Konton med budget eller kvitton visas; tomma konton göms för att hålla sidan kort
    var shown = state.accounts.filter(function (a) { return (state.plan.limits[a.id] || 0) > 0 || (A.spent[a.id] || 0) > 0; });
    var cards = shown.map(function (a) {
      var limit = state.plan.limits[a.id] || 0;
      var own = A.own[a.id] || 0;
      var lent = A.lent[a.id] || 0;
      var rem = A.rem[a.id] || 0;
      var spentA = A.spent[a.id] || 0;
      var overflow = spentA - own;
      var usedPct = limit > 0 ? ((own + lent) / limit) * 100 : 0;
      var cls = overflow > 0 || (limit > 0 && rem <= 0) ? 'over' : (usedPct >= 85 ? 'close' : '');

      var leftText = limit > 0 ? kr(rem) + ' kvar' : '';
      var notes = '';
      if (overflow > 0) notes += '<p class="acc-note warn">Slut! ' + sourceList(A.coveredBy[a.id]) + '.</p>';
      if (lent > 0) notes += '<p class="acc-note">Lånade ut ' + Object.keys(A.lentTo[a.id]).map(function (k) {
        return kr(A.lentTo[a.id][k]) + ' till ' + esc(accName(k));
      }).join(', ') + '.</p>';
      var meta = limit > 0
        ? '<b>' + kr(spentA) + '</b> av ' + kr(limit) + (spentA > limit ? ' · <span class="over-txt">' + kr(spentA - limit) + ' över</span>' : '')
        : '<b>' + kr(spentA) + '</b> · ingen budget';

      var ownW = limit > 0 ? Math.min(100, own / limit * 100) : 0;
      var lentW = limit > 0 ? Math.min(100 - ownW, lent / limit * 100) : 0;
      return '<div class="cat">' +
        '<div class="cat-top"><span class="dot" style="background:' + accColor(a.id) + '"></span>' +
        '<span class="cat-name">' + esc(a.name) + '</span><span class="cat-left ' + cls + '">' + leftText + '</span></div>' +
        '<div class="bar ' + cls + '" role="img" aria-label="' + Math.round(Math.min(usedPct, 100)) + ' procent av kontot använt">' +
        '<i style="width:' + ownW + '%;background:' + accColor(a.id) + '"></i><i class="lent" style="width:' + lentW + '%"></i></div>' +
        '<div class="cat-meta">' + meta + '</div>' + notes +
        '</div>';
    }).join('');

    var hidden = state.accounts.length - shown.length;
    $('spent-hint').textContent = 'Så mycket som har gått från varje konto. Ändra budgeten under fliken Budget.' +
      (hidden ? ' Konton utan budget och kvitton visas inte (' + hidden + ' st).' : '');
    $('spent-list').innerHTML = bufferCard + cards;
    renderSpentExtras();
  }

  /* ---------- Saldo ---------- */

  // settings/balance: { anchors: [{ id, date, amount, createdAt }], payday }
  // Ett "ankare" är ett saldo som användaren skrivit in. Därifrån räknas saldot fram dag för dag:
  // inkomster (från månadens plan) på lönedagen och köp på sina datum.
  var pctFmt = new Intl.NumberFormat('sv-SE', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' });
  var signedKr = new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', maximumFractionDigits: 0, signDisplay: 'exceptZero' });

  async function loadBalance() {
    var b = await DB.get('settings', 'balance');
    state.balance = b || { key: 'balance', anchors: [], payday: 25 };
  }

  async function saveBalance() {
    state.balance.key = 'balance';
    await DB.put('settings', state.balance);
  }

  function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseIso(iso) { var p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

  function paydayIso(month, day) {
    var p = month.split('-').map(Number);
    var last = new Date(p[0], p[1], 0).getDate();
    return month + '-' + pad(Math.min(day, last));
  }

  // Planen som gäller för en månad: sparad, annars närmast tidigare (som i Budget-fliken)
  function planFor(month, plans) {
    var best = null;
    plans.forEach(function (p) { if (p.month <= month && (!best || p.month > best.month)) best = p; });
    return best;
  }

  function buildBalance(plans) {
    var bal = state.balance;
    var anchors = bal.anchors.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt; });
    if (!anchors.length) return null;
    var startIso = anchors[0].date;
    var today = todayIso();
    var items = [];

    anchors.forEach(function (a) { items.push({ date: a.date, t: a.createdAt, kind: 'anchor', amount: a.amount, label: 'Saldo uppdaterat' }); });
    state.receipts.forEach(function (r) {
      if (r.date < startIso || r.date > today) return;
      items.push({ date: r.date, t: r.createdAt || 0, kind: 'out', amount: -r.amount, label: r.store, cat: r.category });
    });
    // Inkomster på lönedagen. t = 0 så att en inkomst samma dag som ett ankare räknas som redan inräknad.
    for (var m = startIso.slice(0, 7); m <= today.slice(0, 7); m = shiftMonth(m, 1)) {
      var plan = planFor(m, plans);
      if (!plan) continue;
      var day = paydayIso(m, bal.payday || 25);
      if (day < startIso || day > today) continue;
      plan.income.forEach(function (i) { items.push({ date: day, t: 0, kind: 'in', amount: i.amount, label: i.name }); });
    }
    items.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.t - b.t; });

    // Gå dag för dag och spara saldot vid dagens slut
    // Första punkten är det inskrivna startbeloppet, så att "Allt" räknas från det
    var points = [{ date: startIso, value: anchors[0].amount }];
    var value = 0;
    var idx = 0;
    var started = false;
    for (var d = parseIso(startIso); isoOf(d) <= today; d.setDate(d.getDate() + 1)) {
      var iso = isoOf(d);
      while (idx < items.length && items[idx].date === iso) {
        var it = items[idx++];
        if (it.kind === 'anchor') {
          it.diff = it.amount - value;
          value = it.amount;
          started = true;
        } else if (started) {
          value += it.amount;
        } else {
          it.skip = true; // samma dag men före första ankaret
        }
        it.after = value;
      }
      points.push({ date: iso, value: Math.round(value * 100) / 100 });
    }
    return { points: points, items: items.filter(function (i) { return !i.skip; }) };
  }

  function renderBalanceView(B) {
    var periodBtn = $('bal-periods').querySelector('[aria-pressed="true"]');
    var period = periodBtn ? periodBtn.getAttribute('data-period') : '30';
    var empty = $('bal-empty');
    var card = $('bal-card');

    if (!B) {
      $('bal-amount').textContent = '–';
      $('bal-change').textContent = '';
      $('bal-chart').innerHTML = '';
      $('bal-events').innerHTML = '<li class="empty">Inga händelser ännu.</li>';
      empty.textContent = 'Skriv in hur mycket du har på kontot just nu under "Uppdatera saldo". Sedan växer diagrammet fram allt eftersom du loggar inkomster och köp.';
      empty.hidden = false;
      card.className = 'panel bal-card';
      renderGoals(null);
      return;
    }
    empty.hidden = true;

    var pts = B.points;
    var from = period === 'all' ? 0 : Math.max(0, pts.length - 1 - Number(period));
    var shown = pts.slice(from);
    var last = shown[shown.length - 1].value;
    var first = shown[0].value;
    var diff = last - first;
    var label = { '7': 'senaste veckan', '30': 'senaste månaden', '91': 'senaste 3 mån', '365': 'senaste året', all: 'sedan start' }[period];

    countTo($('bal-amount'), last, kr2);
    var ch = $('bal-change');
    var pct = first !== 0 ? diff / Math.abs(first) : null;
    ch.innerHTML = '<span class="arrow" aria-hidden="true">' + (diff > 0 ? '▲' : diff < 0 ? '▼' : '') + '</span>' +
      '<b>' + signedKr.format(diff) + (pct !== null ? ' (' + pctFmt.format(pct) + ')' : '') + '</b> ' + label;
    card.className = 'panel bal-card ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');

    drawChart(shown);

    // Händelser i perioden, nyast först, med saldo efter (fungerar även som tabell till diagrammet)
    var firstDate = shown[0].date;
    var evs = B.items.filter(function (i) { return i.date >= firstDate; }).reverse().slice(0, 30);
    $('bal-events').innerHTML = evs.length ? evs.map(function (e) {
      var amt, cls;
      if (e.kind === 'anchor') { amt = e.diff ? signedKr.format(e.diff) : '±0 kr'; cls = 'adj'; }
      else { amt = signedKr.format(e.amount); cls = e.amount >= 0 ? 'in' : 'out'; }
      var sub = dateLabel(e.date) + (e.kind === 'out' ? ' · ' + esc(accName(e.cat)) : e.kind === 'in' ? ' · Inkomst' : ' · Satt till ' + kr(e.amount));
      return '<li><span class="ev-dot ' + cls + '" aria-hidden="true"></span>' +
        '<span class="ev-main"><span class="ev-label">' + esc(e.label) + '</span><span class="ev-sub">' + sub + '</span></span>' +
        '<span class="ev-right"><span class="ev-amt ' + cls + '">' + amt + '</span><span class="ev-after">' + kr(e.after) + '</span></span></li>';
    }).join('') : '<li class="empty">Inga händelser i perioden.</li>';

    renderGoals(B);
  }

  // Linjediagram i SVG. En serie, ingen förklaring behövs. Hovring visar datum och saldo.
  function drawChart(pts) {
    var box = $('bal-chart');
    var W = Math.max(280, box.clientWidth || 600);
    var H = W < 500 ? 200 : 260;
    var padL = 8, padR = 8, padT = 12, padB = 26;
    var vals = pts.map(function (p) { return p.value; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min === max) { min -= 100; max += 100; }
    var span = max - min;
    min -= span * 0.08; max += span * 0.08;
    var n = pts.length;
    function x(i) { return padL + (n === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (n - 1)); }
    function y(v) { return padT + (max - v) / (max - min) * (H - padT - padB); }

    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1); }).join('');
    var area = line + 'L' + x(n - 1).toFixed(1) + ' ' + (H - padB) + 'L' + x(0).toFixed(1) + ' ' + (H - padB) + 'Z';
    // Startnivån som streckad referenslinje, som hos Avanza
    var baseY = y(pts[0].value).toFixed(1);

    // Stödlinjer på runda belopp (1, 2 eller 5 gånger en tiopotens)
    var raw = (max - min) / 5;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 5, 10].map(function (k) { return k * mag; }).filter(function (s) { return s >= raw; })[0];
    var grid = '';
    for (var gv = Math.ceil(min / step) * step; gv <= max; gv += step) {
      var gy = y(gv).toFixed(1);
      if (gy < padT + 12) continue;
      grid += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '"/>' +
        '<text class="axis" x="' + (padL + 2) + '" y="' + (gy - 4) + '">' + kr(gv) + '</text>';
    }
    var xl = '<text class="axis" x="' + padL + '" y="' + (H - 8) + '">' + dateLabel(pts[0].date) + '</text>' +
      '<text class="axis" text-anchor="end" x="' + (W - padR) + '" y="' + (H - 8) + '">' + (n > 1 ? dateLabel(pts[n - 1].date) : '') + '</text>';

    box.innerHTML =
      '<svg class="bal-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Saldo från ' + dateLabel(pts[0].date) + ' till ' + dateLabel(pts[n - 1].date) + ', från ' + kr(pts[0].value) + ' till ' + kr(pts[n - 1].value) + '">' +
      '<defs><linearGradient id="bal-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="g0"/><stop offset="1" class="g1"/></linearGradient></defs>' +
      grid +
      '<line class="base" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + baseY + '" y2="' + baseY + '"/>' +
      '<path class="area" d="' + area + '"/>' +
      '<path class="line" d="' + line + '"/>' +
      (n === 1 ? '<circle class="end" cx="' + x(0) + '" cy="' + y(pts[0].value) + '" r="5"/>' : '') +
      xl +
      '<g class="hover" visibility="hidden"><line class="cross" y1="' + padT + '" y2="' + (H - padB) + '"/><circle class="hdot" r="5"/></g>' +
      '<rect class="hit" x="0" y="0" width="' + W + '" height="' + H + '"/>' +
      '</svg><div class="tip" hidden></div>';

    var svg = box.querySelector('svg');
    if (state.chartAnimate && !calm() && n > 1) {
      var path = svg.querySelector('.line');
      var len = path.getTotalLength();
      path.style.strokeDasharray = len;
      path.style.strokeDashoffset = len;
      svg.querySelector('.area').style.opacity = 0;
      void path.getBoundingClientRect();
      path.style.transition = 'stroke-dashoffset 0.9s cubic-bezier(.3,.7,.2,1)';
      path.style.strokeDashoffset = 0;
      svg.querySelector('.area').style.transition = 'opacity 0.6s ease 0.5s';
      svg.querySelector('.area').style.opacity = 1;
    }
    state.chartAnimate = false;
    var hover = svg.querySelector('.hover');
    var tip = box.querySelector('.tip');
    function show(ev) {
      var r = svg.getBoundingClientRect();
      var px = (ev.clientX - r.left) * (W / r.width);
      var i = n === 1 ? 0 : Math.round((px - padL) / ((W - padL - padR) / (n - 1)));
      i = Math.max(0, Math.min(n - 1, i));
      var cx = x(i), cy = y(pts[i].value);
      hover.setAttribute('visibility', 'visible');
      hover.querySelector('.cross').setAttribute('x1', cx);
      hover.querySelector('.cross').setAttribute('x2', cx);
      hover.querySelector('.hdot').setAttribute('cx', cx);
      hover.querySelector('.hdot').setAttribute('cy', cy);
      var d = pts[i].value - pts[0].value;
      tip.innerHTML = '<b>' + kr2(pts[i].value) + '</b><span>' + dateLabel(pts[i].date) + '</span>' +
        (i ? '<span>' + signedKr.format(d) + ' sedan periodens start</span>' : '');
      tip.hidden = false;
      var left = cx * (r.width / W);
      tip.style.left = Math.max(70, Math.min(r.width - 70, left)) + 'px';
      tip.style.top = Math.max(0, cy * (r.height / H) - 70) + 'px';
    }
    function hide() { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  }

  /* ---------- Mål ---------- */

  // settings/goals: { list: [{ id, name, type: 'balance' | 'save', target, startBalance, deadline, createdAt }] }
  // 'balance' = nå ett saldo, 'save' = spara ett belopp (saldots ökning sedan målet skapades)
  async function loadGoals() {
    var g = await DB.get('settings', 'goals');
    state.goals = g && g.list ? g.list : [];
  }

  async function saveGoals() {
    await DB.put('settings', { key: 'goals', list: state.goals });
  }

  function monthYear(d) { return d.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' }); }

  // Genomsnittlig ökning per dag de senaste 90 dagarna (null om för lite historik)
  function dailyRate(B) {
    var pts = B.points;
    if (pts.length < 15) return null;
    var back = Math.min(90, pts.length - 1);
    return (pts[pts.length - 1].value - pts[pts.length - 1 - back].value) / back;
  }

  function renderGoals(B) {
    var now = B ? B.points[B.points.length - 1].value : null;
    var rate = B ? dailyRate(B) : null;
    var today = parseIso(todayIso());

    var celebrate = false;
    var changed = false;
    var cards = state.goals.map(function (g) {
      var have = now === null ? 0 : (g.type === 'save' ? now - g.startBalance : now);
      have = Math.max(0, have);
      var pct = g.target > 0 ? Math.min(100, have / g.target * 100) : 0;
      var left = Math.max(0, g.target - have);
      var done = left <= 0;
      // Firas bara när man faktiskt tittar på Saldo, annars väntar konfettin till nästa besök
      if (now !== null && done !== !!g.celebrated && (!done || state.view === 'balance')) {
        g.celebrated = done;
        if (done) celebrate = true;
        changed = true;
      }
      var lines = [];
      if (done) {
        lines.push('<p class="goal-done">Målet är nått!</p>');
      } else {
        if (g.deadline) {
          var dl = parseIso(g.deadline);
          var days = Math.round((dl - today) / 86400000);
          if (days < 0) lines.push('<p class="acc-note warn">Datumet ' + dateLabel(g.deadline) + ' har passerat.</p>');
          else {
            var months = Math.max(1, days / 30.44);
            lines.push('<p class="acc-note">Klart till ' + dateLabel(g.deadline) + ' · behöver <b>' + kr(left / months) + '/mån</b></p>');
          }
        }
        if (rate === null) lines.push('<p class="acc-note">Uppskattning visas när det finns minst två veckors historik.</p>');
        else if (rate <= 0) lines.push('<p class="acc-note">Saldot har inte ökat på sistone, så det går inte att uppskatta när du når målet.</p>');
        else {
          var eta = new Date(today.getTime() + Math.ceil(left / rate) * 86400000);
          lines.push('<p class="acc-note">I nuvarande takt: ungefär ' + monthYear(eta) + '</p>');
        }
      }
      var confirm = state.confirmGoalDelete === g.id;
      return '<div class="cat goal' + (done ? ' reached' : '') + '">' +
        '<div class="cat-top"><span class="cat-name">' + esc(g.name) + '</span>' +
        '<span class="goal-type">' + (g.type === 'save' ? 'Spara till' : 'Nå saldo') + '</span></div>' +
        '<p class="goal-amount"><b>' + kr(have) + '</b> av ' + kr(g.target) + '</p>' +
        '<div class="bar" role="img" aria-label="' + Math.round(pct) + ' procent av målet"><i style="width:' + pct + '%"></i></div>' +
        '<div class="cat-bottom"><span class="cat-meta">' + Math.round(pct) + ' %' + (done ? '' : ' · ' + kr(left) + ' kvar') + '</span>' +
        '<button class="btn btn-ghost btn-danger" type="button" data-goal-del="' + esc(g.id) + '">' + (confirm ? 'Säker?' : 'Ta bort') + '</button></div>' +
        lines.join('') + '</div>';
    }).join('');

    var form = B
      ? '<form class="cat add-goal" id="goal-form" autocomplete="off">' +
        '<label class="field"><span>Nytt mål</span><input id="goal-name" type="text" placeholder="t.ex. Högtalare, Buffert 100 000" required></label>' +
        '<div class="two">' +
        '<label class="field"><span>Typ</span><select id="goal-type"><option value="save">Spara till</option><option value="balance">Nå saldo</option></select></label>' +
        '<label class="field"><span>Belopp (kr)</span><input id="goal-target" type="number" inputmode="decimal" min="1" step="any" required></label>' +
        '</div>' +
        '<label class="field"><span>Klart till (valfritt)</span><input id="goal-deadline" type="date"></label>' +
        '<button class="btn btn-primary" type="submit">Skapa mål</button></form>'
      : '<div class="cat add-goal"><p class="hint">Skriv in ditt saldo under "Uppdatera saldo" först, så kan du sätta upp mål.</p></div>';

    var keep = {};
    ['goal-name', 'goal-type', 'goal-target', 'goal-deadline'].forEach(function (id) { if ($(id)) keep[id] = $(id).value; });
    $('goal-list').innerHTML = cards + form;
    if (changed) saveGoals();
    if (celebrate && state.view === 'balance') confetti();
    Object.keys(keep).forEach(function (id) { if ($(id)) $(id).value = keep[id]; });
  }

  var balanceTicket = 0;
  async function renderBalance() {
    if (!state.balance) return;
    var ticket = ++balanceTicket;
    var plans = await DB.all('plans');
    if (ticket !== balanceTicket) return;
    state.balanceData = buildBalance(plans);
    renderBalanceView(state.balanceData);
  }

  /* ---------- Kvittovyn ---------- */

  function fillSelect(sel, withAll, current) {
    var opts = (withAll ? ['<option value="">Alla konton</option>'] : ['<option value="" disabled>Välj konto</option>'])
      .concat(state.accounts.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }));
    // Ett kvitto vars konto tagits bort ska fortfarande kunna visas och ändras
    if (current && !accById(current)) opts.push('<option value="' + esc(current) + '">' + esc(current) + '</option>');
    sel.innerHTML = opts.join('');
    sel.value = current || '';
  }

  function fillSelects() {
    fillSelect($('r-cat'), false, $('r-cat').value);
    fillSelect($('f-cat'), true, accById($('f-cat').value) ? $('f-cat').value : '');
  }

  function filteredReceipts() {
    var q = $('f-search').value.trim().toLowerCase();
    var cat = $('f-cat').value;
    var all = $('f-period').value === 'all';
    return state.receipts.filter(function (r) {
      if (!all && r.date.slice(0, 7) !== state.month) return false;
      if (cat && r.category !== cat) return false;
      if (q && (r.store + ' ' + (r.note || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(sortByDate(true));
  }

  // "Delvis från Buffert" om kvittot inte rymdes i sitt eget konto (bara för vald månad)
  function splitNote(r) {
    var parts = state.alloc && state.alloc.splits[r.id];
    if (!parts) return '';
    var other = parts.filter(function (p) { return p.from !== r.category; });
    if (!other.length) return '';
    var map = {};
    other.forEach(function (p) { map[p.from] = (map[p.from] || 0) + p.amount; });
    return '<div class="r-split">' + sourceList(map) + '</div>';
  }

  function renderReceipts() {
    state.thumbUrls.forEach(freeUrl);
    state.thumbUrls = [];
    var list = filteredReceipts();
    var total = list.reduce(function (s, r) { return s + r.amount; }, 0);
    $('list-total').innerHTML = list.length
      ? list.length + ' köp · totalt <b>' + kr2(total) + '</b>'
      : '';

    $('receipt-list').innerHTML = list.map(function (r) {
      var thumb;
      if (r.image) {
        var url = imageUrl(r.image);
        state.thumbUrls.push(url);
        thumb = '<button class="thumb" type="button" data-view-img="' + esc(r.id) + '" aria-label="Visa kvittot från ' + esc(r.store) + '"><img src="' + url + '" alt=""></button>';
      } else {
        thumb = '<span class="thumb none"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/></svg>Utan kvitto</span>';
      }
      var confirming = state.confirmDelete === r.id;
      return '<li class="receipt-item">' + thumb +
        '<div class="r-main"><div class="r-store">' + esc(r.store) + '</div>' +
        '<div class="r-sub">' + dateLabel(r.date) + ' <span class="chip"><span class="dot" style="background:' + accColor(r.category) + '"></span>' + esc(accName(r.category)) + '</span>' +
        (r.note ? ' · ' + esc(r.note) : '') + '</div>' + splitNote(r) + '</div>' +
        '<div class="r-amt">' + kr2(r.amount) + '</div>' +
        '<div class="r-actions"><button class="btn btn-ghost" type="button" data-edit="' + esc(r.id) + '">Ändra</button>' +
        '<button class="btn btn-ghost btn-danger" type="button" data-del="' + esc(r.id) + '">' + (confirming ? 'Säker? Klicka igen' : 'Ta bort') + '</button></div>' +
        '</li>';
    }).join('');

    var empty = $('receipt-empty');
    if (!list.length) {
      empty.hidden = false;
      empty.textContent = state.receipts.length
        ? 'Inga köp matchar filtret.'
        : 'Inga köp ännu. Scanna ett kvitto eller välj Utan kvitto för att lägga till det första.';
    } else {
      empty.hidden = true;
    }
  }

  /* ---------- Bild och OCR ---------- */

  function shrink(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob')); }, 'image/jpeg', quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Kunde inte öppna bilden')); };
      img.src = url;
    });
  }

  var tesseractPromise;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractPromise) {
      tesseractPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = TESSERACT_URL;
        s.onload = function () { resolve(window.Tesseract); };
        s.onerror = function () { tesseractPromise = null; reject(new Error('Kunde inte ladda textläsaren')); };
        document.head.appendChild(s);
      });
    }
    return tesseractPromise;
  }

  // En textläsare som återanvänds mellan scanningar (språkfilen laddas bara en gång)
  var ocrWorker = null;
  var ocrProgress = null;
  async function getWorker() {
    if (ocrWorker) return ocrWorker;
    var T = await loadTesseract();
    ocrWorker = T.createWorker('swe', 1, {
      logger: function (m) { if (ocrProgress && m.status === 'recognizing text') ocrProgress(m.progress); }
    }).catch(function (e) { ocrWorker = null; throw e; });
    return ocrWorker;
  }

  // Gör fotot lättläst för OCR: rätt storlek, gråskala, kontrast och skuggor bort.
  // Returnerar en svartvit version där texten är svart på vitt.
  async function prepareForOcr(file) {
    var bmp = await createImageBitmap(file);
    // Kvitton är smala: skala efter bredden så att texten blir lagom stor (ca 1600 px bred)
    var scale = Math.min(2.5, Math.max(0.4, 1600 / bmp.width));
    if (bmp.width * bmp.height * scale * scale > 9e6) scale = Math.sqrt(9e6 / (bmp.width * bmp.height));
    var w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    var img = ctx.getImageData(0, 0, w, h);
    var px = img.data;
    var n = w * h;
    var gray = new Uint8ClampedArray(n);
    var hist = new Uint32Array(256);
    for (var i = 0; i < n; i++) {
      var g = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0;
      gray[i] = g;
      hist[g]++;
    }
    // Sträck ut kontrasten mellan 1:a och 99:e percentilen
    var lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < n * 0.01) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < n * 0.01) hi--;
    var range = Math.max(1, hi - lo);
    for (i = 0; i < n; i++) gray[i] = (gray[i] - lo) * 255 / range;

    // Adaptiv tröskel (Bradley): jämför varje pixel med medelvärdet runt den, så att skuggor inte gör texten svart
    var integral = new Float64Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) {
      var row = 0;
      for (var x = 0; x < w; x++) {
        row += gray[y * w + x];
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
      }
    }
    var r = Math.max(8, Math.round(w / 32));
    var binary = new Uint8ClampedArray(n);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        var mean = sum / ((x1 - x0) * (y1 - y0));
        var v = gray[y * w + x];
        // Svart bara om pixeln är tydligt mörkare än omgivningen; jämna ytor (bord, brus) blir vita
        binary[y * w + x] = v < mean * 0.85 && mean - v > 28 ? 0 : 255;
      }
    }

    function toCanvas(values) {
      var out = document.createElement('canvas');
      out.width = w; out.height = h;
      var octx = out.getContext('2d');
      var od = octx.createImageData(w, h);
      for (var k = 0; k < n; k++) {
        od.data[k * 4] = od.data[k * 4 + 1] = od.data[k * 4 + 2] = values[k];
        od.data[k * 4 + 3] = 255;
      }
      octx.putImageData(od, 0, 0);
      return out;
    }
    return { binary: toCanvas(binary) };
  }

  // Läser en bild med ett visst sidläge (6 = ett textblock: får med beloppen i högerkanten, 4 = en spalt)
  async function ocr(image, psm) {
    var worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
    var res = await worker.recognize(image);
    return res.data.text;
  }

  function setStatus(msg, warn) {
    var el = $('scan-status');
    el.textContent = msg;
    el.className = 'scan-status' + (warn ? ' warn' : '');
    el.hidden = !msg;
  }

  function setPreview(blob) {
    var box = $('dlg-img');
    var img = $('dlg-preview');
    freeUrl(img.dataset.url);
    if (blob) {
      var u = imageUrl(blob);
      img.src = u;
      img.dataset.url = u;
      box.hidden = false;
    } else {
      img.removeAttribute('src');
      delete img.dataset.url;
      box.hidden = true;
    }
    $('r-image-remove').hidden = !blob;
    $('r-image-label').textContent = blob ? 'Byt bild' : 'Bifoga bild (t.ex. orderbekräftelse)';
  }

  async function scanFile(file) {
    openDialog(null);
    var token = ++state.scanToken;
    $('dlg-save').disabled = false;
    setStatus('Förbereder bilden…');
    var blob;
    try {
      blob = await shrink(file, 2000, 0.85);
    } catch (e) {
      if (token === state.scanToken) setStatus('Bilden kunde inte öppnas. Fyll i uppgifterna själv eller välj en JPG eller PNG.', true);
      return;
    }
    if (token !== state.scanToken) return;
    state.draftImage = blob;
    setPreview(blob);
    setStatus('Läser kvittot…');
    try {
      var label = 'Läser kvittot…';
      ocrProgress = function (p) {
        if (token === state.scanToken) setStatus(label + ' ' + Math.round(p * 100) + ' %');
      };
      // Originalfotot används (inte den förminskade bilden som sparas), så att texten blir skarp
      var prepared = await prepareForOcr(file);
      if (token !== state.scanToken) return;
      var text = await ocr(prepared.binary, '6');
      var p = KvittoParse.parseReceipt(text);
      if (token !== state.scanToken) return;
      // Saknas något, eller är summan en gissning: läs igen med ett annat sidläge och fyll i
      if (p.amount == null || !p.amountSure || !p.date || !p.store) {
        label = 'Läser en gång till…';
        var text2 = await ocr(prepared.binary, '4');
        text += '\n\n--- andra läsningen ---\n' + text2;
        var p2 = KvittoParse.parseReceipt(text2);
        if (token !== state.scanToken) return;
        if (p2.amount != null && (p.amount == null || (p2.amountSure && !p.amountSure))) { p.amount = p2.amount; p.amountSure = p2.amountSure; }
        ['store', 'date', 'category'].forEach(function (k) { if (!p[k]) p[k] = p2[k]; });
      }
      ocrProgress = null;
      $('ocr-text').textContent = text.trim();
      $('ocr-details').hidden = false;
      if (!$('r-store').value && p.store) $('r-store').value = p.store;
      if (p.date) $('r-date').value = p.date;
      if (!$('r-amount').value && p.amount != null) $('r-amount').value = p.amount.toFixed(2);
      if (!$('r-cat').value && p.category) {
        // Tolkaren gissar ett standardnamn; matcha mot kontonas namn eftersom de kan vara omdöpta
        var guess = state.accounts.filter(function (a) { return a.id === p.category || a.name.toLowerCase() === p.category.toLowerCase(); })[0];
        if (guess) $('r-cat').value = guess.id;
      }
      var found = [p.store, p.date, p.amount != null].filter(Boolean).length;
      setStatus(found === 3
        ? 'Klart. Kontrollera uppgifterna innan du sparar.'
        : 'Allt gick inte att läsa av. Fyll i det som saknas.', found < 3);
    } catch (e) {
      ocrProgress = null;
      if (token === state.scanToken) setStatus('Kunde inte läsa texten på kvittot. Fyll i uppgifterna själv.', true);
    }
  }

  /* ---------- Kvittodialog ---------- */

  // manual = köp utan kvitto (onlineköp, Swish, prenumeration …)
  function openDialog(receipt, manual) {
    state.scanToken++;
    state.editing = receipt;
    state.draftImage = receipt ? receipt.image || null : null;
    var noReceipt = receipt ? !receipt.image : !!manual;
    $('dlg-title').textContent = receipt ? (noReceipt ? 'Ändra köp' : 'Ändra kvitto') : (noReceipt ? 'Köp utan kvitto' : 'Nytt kvitto');
    $('dlg-save').textContent = receipt ? 'Spara ändringar' : (noReceipt ? 'Spara köp' : 'Spara kvitto');
    var hint = $('dlg-hint');
    hint.textContent = 'Skriv in köpet själv. Har du en orderbekräftelse eller skärmdump kan du bifoga den längst ner.';
    hint.hidden = !(manual && !receipt);
    $('r-store').placeholder = noReceipt ? 't.ex. Zalando, Spotify, Swish till Kim' : '';
    $('r-image').value = '';
    $('ocr-details').hidden = true;
    $('ocr-details').open = false;
    $('r-store').value = receipt ? receipt.store : '';
    $('r-date').value = receipt ? receipt.date : todayIso();
    $('r-amount').value = receipt ? receipt.amount : '';
    fillSelect($('r-cat'), false, receipt ? receipt.category : '');
    $('r-note').value = receipt ? receipt.note || '' : '';
    setStatus('');
    setPreview(state.draftImage);
    var d = $('receipt-dialog');
    if (!d.open) d.showModal();
  }

  function closeDialog() {
    state.scanToken++;
    var d = $('receipt-dialog');
    if (d.open) d.close();
    setPreview(null);
    $('file-input').value = '';
  }

  async function saveReceipt(ev) {
    ev.preventDefault();
    var date = $('r-date').value;
    var amount = num($('r-amount').value);
    var store = $('r-store').value.trim();
    var cat = $('r-cat').value;
    if (!store || !date || !cat || !(amount >= 0)) return;
    var rec = {
      id: state.editing ? state.editing.id : uid(),
      store: store,
      date: date,
      amount: Math.round(amount * 100) / 100,
      category: cat,
      note: $('r-note').value.trim(),
      image: state.draftImage || null,
      createdAt: state.editing ? state.editing.createdAt : Date.now()
    };
    try {
      await DB.put('receipts', rec);
    } catch (e) {
      setStatus('Kunde inte spara. Webbläsaren kan ha full lagring eller blockera den.', true);
      return;
    }
    await loadReceipts();
    closeDialog();
    var m = date.slice(0, 7);
    if (m !== state.month && $('f-period').value === 'month') state.month = m;
    await renderAll();
  }

  /* ---------- Sidans flöde ---------- */

  async function renderAll() {
    $('month-label').textContent = monthLabel(state.month);
    await loadPlan();
    renderBudget();
    renderReceipts();
  }

  /* ---------- Månadsbetyg och grafer (Spenderat) ---------- */

  var LETTERS = [[90, 'A'], [80, 'B'], [70, 'C'], [60, 'D'], [50, 'E'], [0, 'F']];
  var GRADE_TITLES = { A: 'Grymt jobbat!', B: 'Riktigt bra!', C: 'Helt okej', D: 'Lite på gränsen', E: 'Dags att se över', F: 'Tuff månad' };

  function daysIn(month) { var p = month.split('-').map(Number); return new Date(p[0], p[1], 0).getDate(); }
  function shortMonth(month) { var p = month.split('-').map(Number); return new Date(p[0], p[1] - 1, 1).toLocaleDateString('sv-SE', { month: 'short' }).replace('.', ''); }

  // Betyg 0–100 för en månad. Två delar:
  //  - Håller kontona (60 %): konton med budget som går över drar ner, viktat efter kontots storlek.
  //    Ett konto som går 50 % över räknas som helt missat.
  //  - Sparande (40 %): hur stor del av inkomsten som blir över (20 % eller mer = full pott, 0 % = hälften).
  // Pågående månad räknas som prognos: det som är kvar på kontona antas gå åt.
  function gradeFor(month, plans) {
    var now = monthKey(new Date());
    if (month > now) return null;
    var plan = month === state.month ? state.plan : planFor(month, plans);
    if (!plan) return null;
    var isNow = month === now;
    var limits = plan.limits || {};
    var income = plan.income.reduce(function (s, i) { return s + i.amount; }, 0);
    var rec = monthReceipts(month);
    if (!rec.length && !isNow) return null;
    var byAcc = {};
    var spent = 0;
    rec.forEach(function (r) { byAcc[r.category] = (byAcc[r.category] || 0) + r.amount; spent += r.amount; });
    var limited = state.accounts.filter(function (a) { return limits[a.id] > 0; });
    if (!income && !limited.length) return null;

    var acc = null, worst = null, best = null;
    if (limited.length) {
      var weight = 0, penalty = 0;
      limited.forEach(function (a) {
        var L = limits[a.id], s = byAcc[a.id] || 0, over = Math.max(0, s - L);
        penalty += Math.min(1, 2 * over / L) * L;
        weight += L;
        if (over > 0 && (!worst || over > worst.over)) worst = { id: a.id, over: over };
        if (s > 0 && s <= L && (!best || s / L < best.ratio)) best = { id: a.id, ratio: s / L, left: L - s };
      });
      acc = Math.round(100 * (1 - penalty / weight));
    }
    var save = null, rate = null;
    if (income) {
      var projected = spent;
      if (isNow) limited.forEach(function (a) { projected += Math.max(0, limits[a.id] - (byAcc[a.id] || 0)); });
      rate = (income - projected) / income;
      save = Math.round(Math.max(0, Math.min(100, 50 + rate * 250)));
    }
    var score = acc !== null && save !== null ? Math.round(acc * 0.6 + save * 0.4) : (acc !== null ? acc : save);
    var letter = LETTERS.filter(function (l) { return score >= l[0]; })[0][1];
    return { month: month, score: score, letter: letter, acc: acc, save: save, rate: rate, worst: worst, best: best, isNow: isNow };
  }

  function gradeTone(letter) { return letter <= 'B' ? 'good' : letter <= 'D' ? 'mid' : 'bad'; }

  function renderGrade(plans) {
    var g = gradeFor(state.month, plans);
    var prev = gradeFor(shiftMonth(state.month, -1), plans);
    var card = $('grade-card');
    var fill = $('ring-fill');
    var C = 2 * Math.PI * 52;
    fill.style.strokeDasharray = C;
    if (!g) {
      card.className = 'panel grade-card';
      $('grade-letter').textContent = '–';
      $('grade-score').textContent = '';
      $('grade-title').textContent = 'Inget betyg än';
      $('grade-text').textContent = 'Lägg in inkomster och budget under fliken Budget, så får du ett betyg för månaden.';
      $('grade-delta').textContent = '';
      fill.style.strokeDashoffset = C;
      $('grade-breakdown').innerHTML = '';
      $('grade-details').hidden = true;
    } else {
      card.className = 'panel grade-card tone-' + gradeTone(g.letter);
      $('grade-letter').textContent = g.letter;
      $('grade-score').textContent = g.score + '/100';
      $('grade-ring').setAttribute('aria-label', 'Månadsbetyg ' + g.letter + ', ' + g.score + ' av 100');
      $('grade-title').textContent = GRADE_TITLES[g.letter];
      var bits = [];
      if (g.isNow) bits.push('Prognos för månaden utifrån det du spenderat och det som är kvar på kontona.');
      if (g.worst) bits.push(accName(g.worst.id) + ' har gått ' + kr(g.worst.over) + ' över.');
      else if (g.acc !== null) bits.push('Inget konto har gått över budget.');
      if (g.rate !== null) bits.push(g.rate >= 0 ? 'Du får över ' + Math.round(g.rate * 100) + ' % av inkomsten.' : 'Du spenderar mer än du har in.');
      $('grade-text').textContent = bits.join(' ');
      var d = prev ? g.score - prev.score : null;
      var delta = $('grade-delta');
      delta.className = 'grade-delta' + (d > 0 ? ' up' : d < 0 ? ' down' : '');
      delta.textContent = d === null ? '' : (d > 0 ? '▲ +' + d : d < 0 ? '▼ −' + Math.abs(d) : '± 0') + ' mot ' + shortMonth(prev.month);
      // Ringen fylls från noll när värdet ändras
      var target = C * (1 - g.score / 100);
      if (calm()) fill.style.strokeDashoffset = target;
      else { fill.style.strokeDashoffset = C; void fill.getBoundingClientRect(); requestAnimationFrame(function () { fill.style.strokeDashoffset = target; }); }

      function part(label, val, note) {
        return val === null ? '' : '<div class="gb-row"><div class="gb-top"><span>' + label + '</span><b>' + val + '/100</b></div>' +
          '<div class="bar"><i style="width:' + val + '%"></i></div><p class="hint">' + note + '</p></div>';
      }
      var html = part('Håller kontona · 60 %', g.acc, 'Konton med budget som går över drar ner. Ett konto som går 50 % över räknas som helt missat.') +
        part('Sparande · 40 %', g.save, 'Hur mycket av inkomsten som blir över. 20 % eller mer ger full pott, 0 % ger hälften.');
      if (g.best) html += '<p class="gb-note good">Bäst: ' + esc(accName(g.best.id)) + ', ' + kr(g.best.left) + ' kvar (' + Math.round(g.best.ratio * 100) + ' % använt)</p>';
      if (g.worst) html += '<p class="gb-note bad">Behöver koll: ' + esc(accName(g.worst.id)) + ', ' + kr(g.worst.over) + ' över</p>';
      $('grade-breakdown').innerHTML = html;
      $('grade-details').hidden = false;
    }

    // Betyg för de senaste sex månaderna; klick går till månaden
    var hist = [];
    for (var i = 5; i >= 0; i--) {
      var m = shiftMonth(state.month, -i);
      var h = gradeFor(m, plans);
      hist.push('<li><button type="button" class="gh' + (m === state.month ? ' current' : '') + (h ? ' tone-' + gradeTone(h.letter) : ' none') + '" data-goto-month="' + m + '"' +
        ' aria-label="' + monthLabel(m) + (h ? ', betyg ' + h.letter : ', inget betyg') + '"><b>' + (h ? h.letter : '–') + '</b><span>' + shortMonth(m) + '</span></button></li>');
    }
    $('grade-history').innerHTML = hist.join('');
  }

  // Delad hovring för diagrammen: hittar närmaste punkt och visar en ruta
  function chartHover(box, svg, W, xs, onShow) {
    var tip = box.querySelector('.tip');
    function show(ev) {
      var r = svg.getBoundingClientRect();
      var px = (ev.clientX - r.left) * (W / r.width);
      var best = 0;
      for (var i = 1; i < xs.length; i++) if (Math.abs(xs[i] - px) < Math.abs(xs[best] - px)) best = i;
      var pos = onShow(best, tip);
      tip.hidden = false;
      tip.style.left = Math.max(80, Math.min(r.width - 80, pos.x * (r.width / W))) + 'px';
      tip.style.top = Math.max(0, pos.y * (r.height / svg.viewBox.baseVal.height) - 74) + 'px';
    }
    function hide() { tip.hidden = true; onShow(-1, tip); }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  }

  function niceStep(span, count) {
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    return [1, 2, 5, 10].map(function (k) { return k * mag; }).filter(function (s) { return s >= raw; })[0];
  }

  // Månaden hittills: spenderat dag för dag mot en jämn takt för budgeten
  function drawPace() {
    var box = $('pace-chart');
    var month = state.month;
    var now = monthKey(new Date());
    var dim = daysIn(month);
    var lastDay = month < now ? dim : month === now ? new Date().getDate() : 0;
    var target = state.alloc ? (state.alloc.planned || state.alloc.income) : 0;
    var status = $('pace-status');
    if (!lastDay) {
      box.innerHTML = '<p class="hint chart-empty">Månaden har inte börjat än.</p>';
      status.textContent = '';
      return;
    }
    var perDay = new Array(dim + 1).fill(0);
    monthReceipts(month).forEach(function (r) { perDay[Number(r.date.slice(8, 10))] += r.amount; });
    var cum = [0];
    for (var d = 1; d <= dim; d++) cum[d] = cum[d - 1] + perDay[d];

    var W = Math.max(280, box.clientWidth || 480), H = W < 420 ? 190 : 220;
    var padL = 8, padR = 8, padT = 14, padB = 26;
    var max = Math.max(target, cum[lastDay], 1) * 1.08;
    function x(day) { return padL + (day / dim) * (W - padL - padR); }
    function y(v) { return padT + (1 - v / max) * (H - padT - padB); }

    var step = niceStep(max, 3), grid = '';
    for (var gv = step; gv < max; gv += step) {
      grid += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(gv).toFixed(1) + '" y2="' + y(gv).toFixed(1) + '"/>' +
        '<text class="axis" x="' + (padL + 2) + '" y="' + (y(gv) - 4).toFixed(1) + '">' + kr(gv) + '</text>';
    }
    var pts = [];
    for (d = 0; d <= lastDay; d++) pts.push(x(d).toFixed(1) + ' ' + y(cum[d]).toFixed(1));
    var line = 'M' + pts.join('L');
    var area = line + 'L' + x(lastDay).toFixed(1) + ' ' + y(0) + 'L' + x(0) + ' ' + y(0) + 'Z';
    var pace = target ? '<line class="pace" x1="' + x(0) + '" y1="' + y(0) + '" x2="' + x(dim) + '" y2="' + y(target).toFixed(1) + '"/>' : '';
    var ahead = target ? cum[lastDay] - target * lastDay / dim : 0;
    var over = target && ahead > 0;

    box.innerHTML = '<svg class="pace-svg' + (over ? ' over' : '') + '" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Spenderat dag för dag i ' + monthLabel(month) + ': ' + kr(cum[lastDay]) + (target ? ', jämn takt hade varit ' + kr(target * lastDay / dim) : '') + '">' +
      '<defs><linearGradient id="pace-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="g0"/><stop offset="1" class="g1"/></linearGradient></defs>' +
      grid + '<line class="base0" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>' + pace +
      '<path class="area" d="' + area + '"/><path class="line" d="' + line + '"/>' +
      '<circle class="end" cx="' + x(lastDay).toFixed(1) + '" cy="' + y(cum[lastDay]).toFixed(1) + '" r="4.5"/>' +
      '<text class="axis" x="' + padL + '" y="' + (H - 8) + '">1 ' + shortMonth(month) + '</text>' +
      '<text class="axis" text-anchor="end" x="' + (W - padR) + '" y="' + (H - 8) + '">' + dim + ' ' + shortMonth(month) + '</text>' +
      '<g class="hover" visibility="hidden"><line class="cross" y1="' + padT + '" y2="' + y(0) + '"/><circle class="hdot" r="5"/></g>' +
      '<rect class="hit" x="0" y="0" width="' + W + '" height="' + H + '"/></svg><div class="tip" hidden></div>';

    if (target) {
      status.className = 'pace-status ' + (over ? 'bad' : 'good');
      status.textContent = over ? '▲ ' + kr(ahead) + ' före takten' : '▼ ' + kr(-ahead) + ' under takten';
    } else {
      status.textContent = '';
    }
    var svg = box.querySelector('svg');
    var hover = svg.querySelector('.hover');
    var xs = [];
    for (d = 1; d <= lastDay; d++) xs.push(x(d));
    chartHover(box, svg, W, xs, function (i, tip) {
      if (i < 0) { hover.setAttribute('visibility', 'hidden'); return null; }
      var day = i + 1, cx = x(day), cy = y(cum[day]);
      hover.setAttribute('visibility', 'visible');
      hover.querySelector('.cross').setAttribute('x1', cx);
      hover.querySelector('.cross').setAttribute('x2', cx);
      hover.querySelector('.hdot').setAttribute('cx', cx);
      hover.querySelector('.hdot').setAttribute('cy', cy);
      tip.innerHTML = '<b>' + kr(cum[day]) + '</b><span>' + day + ' ' + shortMonth(month) + (perDay[day] ? ' · ' + kr(perDay[day]) + ' den dagen' : '') + '</span>' +
        (target ? '<span>Jämn takt: ' + kr(target * day / dim) + '</span>' : '');
      return { x: cx, y: cy };
    });
  }

  // Senaste sex månaderna: inkomster och spenderat som staplar, klick går till månaden
  function drawMonths(plans) {
    var box = $('months-chart');
    var months = [];
    for (var i = 5; i >= 0; i--) {
      var m = shiftMonth(state.month, -i);
      var plan = m === state.month ? state.plan : planFor(m, plans);
      months.push({
        m: m,
        income: plan ? plan.income.reduce(function (s, x) { return s + x.amount; }, 0) : 0,
        spent: monthReceipts(m).reduce(function (s, r) { return s + r.amount; }, 0)
      });
    }
    var W = Math.max(280, box.clientWidth || 600), H = W < 420 ? 200 : 230;
    var padL = 8, padR = 8, padT = 14, padB = 28;
    var max = Math.max.apply(null, months.map(function (o) { return Math.max(o.income, o.spent); }).concat([1])) * 1.1;
    var slot = (W - padL - padR) / months.length;
    var bw = Math.min(26, slot * 0.28);
    function y(v) { return padT + (1 - v / max) * (H - padT - padB); }
    var base = y(0);
    var step = niceStep(max, 3), grid = '';
    for (var gv = step; gv < max; gv += step) {
      grid += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(gv).toFixed(1) + '" y2="' + y(gv).toFixed(1) + '"/>' +
        '<text class="axis" x="' + (padL + 2) + '" y="' + (y(gv) - 4).toFixed(1) + '">' + kr(gv) + '</text>';
    }
    // Stapel med rundade toppar, förankrad mot nollinjen
    function bar(x0, v, cls) {
      var h = Math.max(0, base - y(v));
      if (h < 1) return '';
      var r = Math.min(4, h, bw / 2);
      return '<path class="' + cls + '" d="M' + x0 + ' ' + base + 'V' + (base - h + r) + 'Q' + x0 + ' ' + (base - h) + ' ' + (x0 + r) + ' ' + (base - h) +
        'H' + (x0 + bw - r) + 'Q' + (x0 + bw) + ' ' + (base - h) + ' ' + (x0 + bw) + ' ' + (base - h + r) + 'V' + base + 'Z"/>';
    }
    var groups = months.map(function (o, k) {
      var cx = padL + slot * k + slot / 2;
      var cur = o.m === state.month;
      return '<g class="mg' + (cur ? ' current' : '') + '" data-goto-month="' + o.m + '">' +
        '<rect class="mg-bg" x="' + (cx - slot / 2 + 3) + '" y="' + padT + '" width="' + (slot - 6) + '" height="' + (H - padT - 4) + '" rx="10"/>' +
        bar(cx - bw - 1, o.income, 'b-in') + bar(cx + 1, o.spent, 'b-out' + (o.income && o.spent > o.income ? ' over' : '')) +
        '<text class="axis mlabel" text-anchor="middle" x="' + cx + '" y="' + (H - 9) + '">' + shortMonth(o.m) + '</text></g>';
    }).join('');
    box.innerHTML = '<svg class="months-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Inkomster och spenderat de senaste sex månaderna">' +
      grid + groups + '<line class="base0" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + base + '" y2="' + base + '"/></svg><div class="tip" hidden></div>';
    var svg = box.querySelector('svg');
    var xs = months.map(function (o, k) { return padL + slot * k + slot / 2; });
    var gs = svg.querySelectorAll('.mg');
    chartHover(box, svg, W, xs, function (k, tip) {
      gs.forEach(function (g, j) { g.classList.toggle('hot', j === k); });
      if (k < 0) return null;
      var o = months[k];
      var diff = o.income - o.spent;
      tip.innerHTML = '<b>' + monthLabel(o.m) + '</b><span>Spenderat ' + kr(o.spent) + '</span><span>Inkomster ' + kr(o.income) + '</span>' +
        (o.income ? '<span>' + (diff >= 0 ? 'Över: ' + kr(diff) : 'Minus: ' + kr(-diff)) + '</span>' : '');
      return { x: xs[k], y: y(Math.max(o.income, o.spent)) };
    });
  }

  var extrasTicket = 0;
  async function renderSpentExtras() {
    var ticket = ++extrasTicket;
    var plans = await DB.all('plans');
    if (ticket !== extrasTicket) return;
    renderGrade(plans);
    drawPace();
    drawMonths(plans);
  }

  async function gotoMonth(m) {
    if (!m || m === state.month) return;
    state.month = m;
    state.confirmDelete = null;
    await renderAll();
    enterView(state.view);
    window.scrollTo({ top: 0, behavior: calm() ? 'auto' : 'smooth' });
  }

  /* ---------- Menyn: glidande markering och adresser per flik ---------- */

  var ROUTES = { budget: 'budget', spent: 'spenderat', receipts: 'kvitton', balance: 'saldo' };
  var PAGE_TEXT = {
    budget: ['Budget', 'Planera månaden: inkomster och en maxsumma per konto'],
    spent: ['Spenderat', 'Så går det: betyg, grafer och budget mot utfall'],
    receipts: ['Kvitton', 'Scanna kvitton och se alla dina köp'],
    balance: ['Saldo', 'Pengarna på kontot över tid, och dina mål']
  };

  function viewFromHash() {
    var h = location.hash.replace('#', '');
    for (var v in ROUTES) if (ROUTES[v] === h) return v;
    return null;
  }

  function moveIndicator() {
    var ind = $('tab-ind');
    var tab = $('tab-' + state.view);
    if (!ind || !tab || !tab.offsetWidth) return;
    var first = !ind.classList.contains('ready');
    // Första gången placeras markeringen direkt; sedan glider den mellan flikarna
    if (first) ind.style.transition = 'none';
    ind.style.width = tab.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + tab.offsetLeft + 'px)';
    if (first) { void ind.offsetWidth; ind.style.transition = ''; }
    ind.classList.add('ready');
  }

  var VIEWS = ['budget', 'spent', 'receipts', 'balance'];

  function setView(v) {
    if (VIEWS.indexOf(v) === -1) v = 'budget';
    state.view = v;
    VIEWS.forEach(function (name) {
      $('view-' + name).hidden = v !== name;
      $('tab-' + name).setAttribute('aria-current', v === name ? 'page' : 'false');
    });
    // Saldot gäller hela tiden, inte en månad
    $('monthbar').hidden = v === 'balance';
    $('page-kicker').textContent = PAGE_TEXT[v][0];
    $('page-sub').textContent = PAGE_TEXT[v][1];
    document.title = PAGE_TEXT[v][0] + ' · Kassakoll';
    moveIndicator();
    // Graferna mäter sin bredd, så de ritas om när fliken blir synlig
    if (v === 'spent' && state.alloc) renderSpentExtras();
    if (v === 'balance' && state.balanceData) { state.chartAnimate = true; renderBalanceView(state.balanceData); }
    enterView(v);
    try { localStorage.setItem('kassakoll-view', v); } catch (e) { /* bara en bekvämlighet */ }
  }

  // Byter flik via adressen (#spenderat osv.), så att bakåtknappen och länkar fungerar
  function navigate(v) {
    if (viewFromHash() === v) setView(v);
    else location.hash = ROUTES[v];
  }

  function goTo(v) {
    navigate(v);
    window.scrollTo(0, 0);
  }

  async function changeMonth(delta) {
    state.month = shiftMonth(state.month, delta);
    state.confirmDelete = null;
    await renderAll();
    enterView(state.view);
  }

  function bind() {
    VIEWS.forEach(function (name) {
      $('tab-' + name).addEventListener('click', function () { navigate(name); });
    });
    window.addEventListener('hashchange', function () {
      var v = viewFromHash();
      if (v && v !== state.view) setView(v);
    });
    // Piltangenter flyttar mellan flikarna
    document.querySelector('.tabs').addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      var i = VIEWS.indexOf(state.view) + (ev.key === 'ArrowRight' ? 1 : -1);
      var v = VIEWS[(i + VIEWS.length) % VIEWS.length];
      navigate(v);
      $('tab-' + v).focus();
      ev.preventDefault();
    });
    // Klick på en månad i betygshistoriken eller månadsgrafen
    ['grade-history', 'months-chart'].forEach(function (id) {
      $(id).addEventListener('click', function (ev) {
        var t = ev.target.closest('[data-goto-month]');
        if (t) gotoMonth(t.getAttribute('data-goto-month'));
      });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveIndicator);
    $('see-all').addEventListener('click', function () { goTo('receipts'); });
    $('go-spent').addEventListener('click', function () { goTo('spent'); });

    $('bal-periods').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-period]');
      if (!b) return;
      $('bal-periods').querySelectorAll('[data-period]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      state.chartAnimate = true;
      if (state.balanceData) renderBalanceView(state.balanceData);
    });
    $('bal-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var raw = $('bal-input').value;
      if (raw === '') return;
      state.balance.anchors.push({ id: uid(), date: todayIso(), amount: Math.round(num(raw) * 100) / 100, createdAt: Date.now() });
      await saveBalance();
      ev.target.reset();
      await renderBalance();
    });
    $('bal-payday').addEventListener('change', async function (ev) {
      state.balance.payday = Number(ev.target.value);
      await saveBalance();
      await renderBalance();
    });
    $('goal-list').addEventListener('submit', async function (ev) {
      if (ev.target.id !== 'goal-form') return;
      ev.preventDefault();
      var name = $('goal-name').value.trim();
      var target = num($('goal-target').value);
      if (!name || !(target > 0) || !state.balanceData) return;
      var pts = state.balanceData.points;
      state.goals.push({
        id: uid(), name: name, type: $('goal-type').value, target: target,
        startBalance: pts[pts.length - 1].value, deadline: $('goal-deadline').value || null, createdAt: Date.now()
      });
      await saveGoals();
      ev.target.reset();
      renderGoals(state.balanceData);
    });
    $('goal-list').addEventListener('click', async function (ev) {
      var b = ev.target.closest('[data-goal-del]');
      if (!b) return;
      var id = b.getAttribute('data-goal-del');
      if (state.confirmGoalDelete !== id) {
        state.confirmGoalDelete = id;
      } else {
        state.confirmGoalDelete = null;
        state.goals = state.goals.filter(function (g) { return g.id !== id; });
        await saveGoals();
      }
      renderGoals(state.balanceData);
    });
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        moveIndicator();
        if (state.view === 'balance' && state.balanceData) renderBalanceView(state.balanceData);
        if (state.view === 'spent' && state.alloc) renderSpentExtras();
      }, 150);
    });
    $('prev-month').addEventListener('click', function () { changeMonth(-1); });
    $('next-month').addEventListener('click', function () { changeMonth(1); });

    $('income-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var name = $('inc-name').value.trim();
      var amount = num($('inc-amount').value);
      if (!name || !(amount > 0)) return;
      state.plan.income.push({ id: uid(), name: name, amount: amount });
      await savePlan();
      ev.target.reset();
      renderBudget();
    });

    $('income-list').addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-income-del]');
      if (!btn) return;
      var id = btn.getAttribute('data-income-del');
      state.plan.income = state.plan.income.filter(function (i) { return i.id !== id; });
      await savePlan();
      renderBudget();
    });

    $('cat-list').addEventListener('change', async function (ev) {
      var t = ev.target;
      if (t.hasAttribute('data-cat')) {
        state.plan.limits[t.getAttribute('data-cat')] = Math.max(0, num(t.value));
        await savePlan();
      } else if (t.hasAttribute('data-fallback')) {
        accById(t.getAttribute('data-fallback')).fallback = t.value;
        await saveAccounts();
      } else if (t.hasAttribute('data-acc-rename')) {
        var name = t.value.trim();
        if (name) {
          accById(t.getAttribute('data-acc-rename')).name = name;
          await saveAccounts();
          fillSelects();
          renderReceipts();
        }
      } else {
        return;
      }
      renderBudget();
    });

    $('cat-list').addEventListener('submit', async function (ev) {
      if (ev.target.id !== 'add-acc-form') return;
      ev.preventDefault();
      var name = $('new-acc-name').value.trim();
      if (!name) return;
      var taken = state.accounts.map(function (a) { return a.color % COLORS; });
      var color = 0;
      while (color < COLORS && taken.indexOf(color) !== -1) color++;
      state.accounts.push({ id: uid(), name: name, color: color < COLORS ? color : state.accounts.length, fallback: BUFFER });
      await saveAccounts();
      fillSelects();
      renderBudget();
      $('new-acc-name').focus();
    });

    $('cat-list').addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-acc-del]');
      if (!btn) return;
      var id = btn.getAttribute('data-acc-del');
      if (state.accounts.length < 2) { showBanner('Du behöver minst ett konto.'); return; }
      if (state.confirmAccDelete !== id) {
        state.confirmAccDelete = id;
        renderBudget();
        return;
      }
      state.confirmAccDelete = null;
      var acc = accById(id);
      var others = state.accounts.filter(function (a) { return a.id !== id; });
      // Kvitton i kontot flyttas till dess reservkonto (eller första andra kontot)
      var target = accById(acc.fallback) && acc.fallback !== id ? acc.fallback : others[0].id;
      var moved = state.receipts.filter(function (r) { return r.category === id; });
      for (var i = 0; i < moved.length; i++) {
        moved[i].category = target;
        await DB.put('receipts', moved[i]);
      }
      others.forEach(function (a) { if (a.fallback === id) a.fallback = BUFFER; });
      state.accounts = others;
      delete state.plan.limits[id];
      await saveAccounts();
      if (!state.inheritedFrom) await savePlan();
      showBanner(moved.length
        ? 'Kontot ' + acc.name + ' togs bort. ' + moved.length + (moved.length === 1 ? ' kvitto' : ' kvitton') + ' flyttades till ' + accName(target) + '.'
        : 'Kontot ' + acc.name + ' togs bort.');
      fillSelects();
      renderBudget();
      renderReceipts();
    });

    $('manage-btn').addEventListener('click', function () {
      state.manage = !state.manage;
      state.confirmAccDelete = null;
      renderBudget();
    });

    $('file-input').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (f) scanFile(f);
    });
    $('add-manual').addEventListener('click', function () { openDialog(null, true); });
    $('spent-manual').addEventListener('click', function () { openDialog(null, true); });

    // Plus-knappen på mobilen: välj mellan att scanna och att skriva in utan kvitto
    function setFabMenu(open) {
      $('fab-menu').hidden = !open;
      $('fab').setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    $('fab').addEventListener('click', function (ev) {
      ev.stopPropagation();
      setFabMenu($('fab-menu').hidden);
    });
    $('fab-scan').addEventListener('click', function () { setFabMenu(false); });
    $('fab-manual').addEventListener('click', function () { setFabMenu(false); openDialog(null, true); });
    document.addEventListener('click', function (ev) {
      if (!$('fab-menu').hidden && !ev.target.closest('.fab-wrap')) setFabMenu(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('fab-menu').hidden) { setFabMenu(false); $('fab').focus(); }
    });

    // Bifoga bild i dialogen (utan textläsning), t.ex. skärmdump av en orderbekräftelse
    $('r-image').addEventListener('change', async function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      try {
        state.draftImage = await shrink(f, 2000, 0.85);
        setPreview(state.draftImage);
        setStatus('');
      } catch (e) {
        setStatus('Bilden kunde inte öppnas. Välj en JPG eller PNG.', true);
      }
    });
    $('r-image-remove').addEventListener('click', function () {
      state.draftImage = null;
      setPreview(null);
      $('r-image').value = '';
    });
    $('receipt-form').addEventListener('submit', saveReceipt);
    $('dlg-close').addEventListener('click', closeDialog);
    $('dlg-cancel').addEventListener('click', closeDialog);
    $('receipt-dialog').addEventListener('cancel', function () { state.scanToken++; });

    ['f-search', 'f-cat', 'f-period'].forEach(function (id) {
      $(id).addEventListener('input', function () { state.confirmDelete = null; renderReceipts(); });
    });

    $('receipt-list').addEventListener('click', async function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      var rec;
      if (t.hasAttribute('data-view-img')) {
        rec = state.receipts.find(function (r) { return r.id === t.getAttribute('data-view-img'); });
        if (rec && rec.image) {
          var d = $('image-dialog');
          var img = $('big-img');
          freeUrl(img.dataset.url);
          var u = imageUrl(rec.image);
          img.src = u;
          img.dataset.url = u;
          d.showModal();
        }
      } else if (t.hasAttribute('data-edit')) {
        rec = state.receipts.find(function (r) { return r.id === t.getAttribute('data-edit'); });
        if (rec) openDialog(rec);
      } else if (t.hasAttribute('data-del')) {
        var id = t.getAttribute('data-del');
        if (state.confirmDelete === id) {
          state.confirmDelete = null;
          await DB.del('receipts', id);
          await loadReceipts();
          renderBudget();
          renderReceipts();
        } else {
          state.confirmDelete = id;
          renderReceipts();
        }
      }
    });

    $('img-close').addEventListener('click', function () { $('image-dialog').close(); });
    $('image-dialog').addEventListener('click', function (ev) { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });
  }

  /* ---------- Inloggning (Supabase) ---------- */

  var SUPABASE_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js';

  function cloudConfig() {
    var c = window.KASSAKOLL_CONFIG || {};
    return c.supabaseUrl && c.supabaseAnonKey ? c : null;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Kunde inte ladda inloggningen. Kontrollera internetanslutningen.')); };
      document.head.appendChild(s);
    });
  }

  // Supabase-fel på engelska -> begripliga meddelanden
  function authError(err) {
    var m = String((err && err.message) || err || '');
    if (/invalid login credentials/i.test(m)) return 'Fel e-post eller lösenord.';
    if (/email not confirmed/i.test(m)) return 'Bekräfta din e-post först. Kolla inkorgen (och skräpposten) efter mejlet från Kassakoll.';
    if (/already registered|already been registered/i.test(m)) return 'Det finns redan ett konto med den e-posten. Logga in i stället.';
    if (/password.*(at least|short|6)/i.test(m)) return 'Lösenordet måste vara minst 6 tecken.';
    if (/rate limit|too many|seconds/i.test(m)) return 'För många försök. Vänta en stund och prova igen.';
    if (/invalid.*email|email.*invalid/i.test(m)) return 'E-postadressen ser inte rätt ut.';
    if (/fetch|network|failed to/i.test(m)) return 'Kunde inte nå servern. Kontrollera internetanslutningen.';
    return 'Något gick fel: ' + m;
  }

  // Visar inloggningen och löser ut när någon är inloggad. mode: 'login' | 'signup' | 'forgot' | 'newpass'
  function showAuth(client, startMode) {
    return new Promise(function (resolve) {
      var mode;
      var form = $('auth-form');
      function msg(text, ok) {
        $('auth-msg').textContent = text || '';
        $('auth-msg').className = 'auth-msg' + (ok ? ' ok' : '');
        $('auth-msg').hidden = !text;
      }
      function setMode(m) {
        mode = m;
        var t = {
          login: ['Logga in', 'Din budget, dina kvitton och ditt saldo, på alla dina enheter.', 'Logga in', 'Inget konto? Skapa ett'],
          signup: ['Skapa konto', 'Gratis. Du får ett mejl för att bekräfta adressen.', 'Skapa konto', 'Har du ett konto? Logga in'],
          forgot: ['Glömt lösenord', 'Skriv din e-post så skickar vi en länk där du väljer ett nytt lösenord.', 'Skicka länk', 'Tillbaka till inloggningen'],
          newpass: ['Nytt lösenord', 'Välj ett nytt lösenord för ditt konto.', 'Spara lösenord', '']
        }[m];
        $('auth-title').textContent = t[0];
        $('auth-lead').textContent = t[1];
        $('auth-submit').textContent = t[2];
        $('auth-switch').textContent = t[3];
        $('auth-switch').hidden = !t[3];
        $('auth-forgot').hidden = m !== 'login';
        $('auth-email-field').hidden = m === 'newpass';
        $('auth-pass-field').hidden = m === 'forgot';
        $('auth-pass-label').textContent = m === 'newpass' ? 'Nytt lösenord' : 'Lösenord';
        $('auth-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
        msg('');
      }
      $('auth-switch').onclick = function () { setMode(mode === 'login' ? 'signup' : 'login'); };
      $('auth-forgot').onclick = function () { setMode('forgot'); };
      form.onsubmit = async function (ev) {
        ev.preventDefault();
        var email = $('auth-email').value.trim();
        var pass = $('auth-pass').value;
        if (mode !== 'newpass' && !email) { msg('Skriv din e-post.'); return; }
        if (mode !== 'forgot' && pass.length < 6) { msg('Lösenordet måste vara minst 6 tecken.'); return; }
        var btn = $('auth-submit');
        btn.disabled = true;
        msg('');
        var back = location.origin + location.pathname;
        try {
          var res;
          if (mode === 'login') {
            res = await client.auth.signInWithPassword({ email: email, password: pass });
          } else if (mode === 'signup') {
            res = await client.auth.signUp({ email: email, password: pass, options: { emailRedirectTo: back } });
          } else if (mode === 'forgot') {
            res = await client.auth.resetPasswordForEmail(email, { redirectTo: back });
          } else {
            res = await client.auth.updateUser({ password: pass });
          }
          if (res.error) throw res.error;
          if (mode === 'forgot') { msg('Klart! Kolla din e-post efter länken.', true); return; }
          var session = mode === 'newpass' ? (await client.auth.getSession()).data.session : res.data.session;
          if (!session) {
            // Supabase kräver bekräftelse av e-posten innan första inloggningen
            setMode('login');
            $('auth-email').value = email;
            msg('Nästan klart! Vi har skickat ett mejl till ' + email + '. Klicka på länken i det, sedan kan du logga in här.', true);
            return;
          }
          $('auth-pass').value = '';
          $('auth').hidden = true;
          resolve(session);
        } catch (e) {
          msg(authError(e));
        } finally {
          btn.disabled = false;
        }
      };
      setMode(startMode || 'login');
      $('auth').hidden = false;
      (mode === 'newpass' ? $('auth-pass') : $('auth-email')).focus();
    });
  }

  // Flyttar data som redan finns lokalt på enheten till ett tomt molnkonto (den lokala kopian ligger kvar)
  async function migrateLocal() {
    var stores = ['settings', 'plans', 'receipts'];
    var data = {};
    try {
      for (var i = 0; i < stores.length; i++) data[stores[i]] = await DB.local.all(stores[i]);
    } catch (e) {
      return 0;
    }
    var total = stores.reduce(function (s, k) { return s + data[k].length; }, 0);
    if (!total) return 0;
    showBanner('Flyttar dina data från den här enheten till ditt konto…');
    for (var j = 0; j < stores.length; j++) {
      for (var k = 0; k < data[stores[j]].length; k++) await DB.put(stores[j], data[stores[j]][k]);
    }
    return data.receipts.length;
  }

  // Startar molnläget: loggar in vid behov och byter lagringen till Supabase
  async function startCloud(cfg) {
    await loadScript(SUPABASE_URL);
    var client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    var recovering = /type=recovery/.test(location.hash);
    client.auth.onAuthStateChange(function (event) {
      if (event === 'PASSWORD_RECOVERY') recovering = true;
      if (event === 'SIGNED_OUT') location.reload();
    });
    var session = (await client.auth.getSession()).data.session;
    if (!session || recovering) session = await showAuth(client, recovering ? 'newpass' : 'login');
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);

    var count = await DB.useCloud(client, session.user.id);
    if (count === 0) {
      var moved = await migrateLocal();
      showBanner(moved ? moved + (moved === 1 ? ' kvitto' : ' kvitton') + ' och dina budgetar flyttades från den här enheten till ditt konto.' : '');
    }

    var out = $('logout');
    out.hidden = false;
    out.title = 'Logga ut (' + session.user.email + ')';
    out.setAttribute('aria-label', 'Logga ut ' + session.user.email);
    out.onclick = async function () {
      out.disabled = true;
      await client.auth.signOut();
      location.reload();
    };
  }

  async function init() {
    bind();
    var saved = null;
    try { saved = localStorage.getItem('kassakoll-view'); } catch (e) { /* ignoreras */ }
    setView(viewFromHash() || saved || 'budget');
    // Fel vid sparning till molnet (t.ex. utan internet) ska synas, inte försvinna tyst
    window.addEventListener('unhandledrejection', function (ev) {
      if (ev.reason && ev.reason.cloud) showBanner('Kunde inte spara till ditt konto. Kontrollera internetanslutningen och försök igen.', true);
    });
    var cfg = cloudConfig();
    if (cfg) {
      try {
        await startCloud(cfg);
      } catch (e) {
        $('auth').hidden = true;
        showBanner(e.cloud ? 'Kunde inte hämta dina data. Kontrollera internetanslutningen och ladda om sidan.' : authError(e), true);
        $('month-label').textContent = monthLabel(state.month);
        return;
      }
    }
    try {
      await loadAccounts();
      await loadBalance();
      await loadGoals();
      var days = [];
      for (var d = 1; d <= 31; d++) days.push('<option value="' + d + '">' + d + ((d % 10 === 1 || d % 10 === 2) && d !== 11 && d !== 12 ? ':a' : ':e') + '</option>');
      $('bal-payday').innerHTML = days.join('');
      $('bal-payday').value = String(state.balance.payday || 25);
      fillSelects();
      await loadReceipts();
      await renderAll();
      enterView(state.view);
      if (!DB.isCloud() && navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) {
      if (e && e.message === 'blocked') {
        showBanner('Kassakoll har uppdaterats. Stäng andra flikar där sidan är öppen och ladda om den här.', true);
        $('month-label').textContent = monthLabel(state.month);
        return;
      }
      showBanner('Webbläsaren tillåter inte att sidan sparar data (privat läge eller blockerad lagring). Budgeten och kvittona sparas inte.', true);
      $('month-label').textContent = monthLabel(state.month);
    }
  }

  init();
})();
