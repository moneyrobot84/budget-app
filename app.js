/* Budget Keluarga — frontend PWA. Data hanya ada di memori selama aplikasi terbuka. */
(function () {
  'use strict';

  var LS_URL = 'budget.api';
  var LOCK_AFTER_MS = 30000;      // kunci ulang jika aplikasi ditinggal lebih dari 30 detik
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    url: '', pin: '', tx: [], budget: [],
    settings: { cycleStart: 25, warnPct: 80, incomeCats: [], accounts: [] },
    view: 'home', period: 'cycle', from: '', to: '', cycleOffset: 0,
    hist: { q: '', type: '', cat: '', month: '' },
    form: { type: 'out', cat: '', id: null, origType: null }
  };

  /* ================= Util ================= */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rp(n) { return (n < 0 ? '-' : '') + 'Rp ' + Math.abs(Math.round(n)).toLocaleString('id-ID'); }
  function rpShort(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',').replace(',0', '') + ' M';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' jt';
    if (n >= 1e3) return Math.round(n / 1e3) + ' rb';
    return String(Math.round(n));
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function today() { return iso(new Date()); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 864e5) + 1; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var DAY = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  function fmtDate(s, withDay) { var d = parse(s); return (withDay ? DAY[d.getDay()] + ', ' : '') + d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); }
  function fmtShort(s) { var d = parse(s); return d.getDate() + ' ' + MON[d.getMonth()]; }
  function monthLabel(key) { return MON[+key.slice(5, 7) - 1] + ' ' + key.slice(0, 4); }
  function sum(list) { return list.reduce(function (a, t) { return a + t.amount; }, 0); }

  /* ================= Siklus & periode ================= */
  function cycleKey(dateStr) {
    var st = S.settings.cycleStart, y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
    if (st > 1 && d >= st) { m++; if (m > 12) { m = 1; y++; } }
    return y + '-' + pad(m);
  }
  function shiftKey(key, n) { var d = new Date(+key.slice(0, 4), +key.slice(5, 7) - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function cycleRange(key) {
    var st = S.settings.cycleStart, y = +key.slice(0, 4), m = +key.slice(5, 7);
    if (st <= 1) return { from: key + '-01', to: iso(new Date(y, m, 0)) };
    return { from: iso(new Date(y, m - 2, st)), to: iso(new Date(y, m - 1, st - 1)) };
  }
  function periodRange(p) {
    var t = today(), d = parse(t);
    if (p === 'today') return { from: t, to: t };
    if (p === 'week') { var dow = (d.getDay() + 6) % 7; var f = addDays(t, -dow); return { from: f, to: addDays(f, 6) }; }
    if (p === 'month') return { from: iso(new Date(d.getFullYear(), d.getMonth(), 1)), to: iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
    if (p === 'custom') { var a = S.from || t, b = S.to || t; return a <= b ? { from: a, to: b } : { from: b, to: a }; }
    return cycleRange(cycleKey(t));
  }
  function prevRange(p, r) {
    var d = parse(r.from);
    if (p === 'month') return { from: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: iso(new Date(d.getFullYear(), d.getMonth(), 0)) };
    if (p === 'cycle') return cycleRange(shiftKey(cycleKey(r.from), -1));
    var n = daysBetween(r.from, r.to);
    return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
  }
  function inRange(r) { return S.tx.filter(function (t) { return t.date >= r.from && t.date <= r.to; }); }

  /* ================= Budget ================= */
  function limitOf(b, key) { return key in b.over ? b.over[key] : b.def; }
  function statusOf(limit, spent, alertOn) {
    if (limit <= 0) return spent > 0 && alertOn ? 'over' : 'none';
    if (spent > limit) return 'over';
    if (spent === limit) return 'full';
    if (alertOn && spent >= limit * S.settings.warnPct / 100) return 'warn';
    return 'ok';
  }
  /** Hitung budget vs realisasi untuk satu siklus. */
  function budgetFor(key) {
    var r = cycleRange(key);
    var outs = inRange(r).filter(function (t) { return t.type === 'out'; });
    var spentBy = {};
    outs.forEach(function (t) { spentBy[t.cat] = (spentBy[t.cat] || 0) + t.amount; });
    var groups = [], idx = {};
    function grp(pos) {
      if (!(pos in idx)) { idx[pos] = groups.length; groups.push({ pos: pos, limit: 0, spent: 0, alertOn: false, rows: [] }); }
      return groups[idx[pos]];
    }
    var known = {};
    S.budget.forEach(function (b) {
      known[b.cat] = 1;
      var g = grp(b.pos || 'Lainnya'), limit = limitOf(b, key), spent = spentBy[b.cat] || 0;
      g.rows.push({ cat: b.cat, limit: limit, spent: spent, alertOn: b.alert, status: statusOf(limit, spent, b.alert) });
      g.limit += limit; g.spent += spent; g.alertOn = g.alertOn || b.alert;
    });
    Object.keys(spentBy).forEach(function (cat) {
      if (known[cat]) return;
      var g = grp('Di luar budget');
      g.rows.push({ cat: cat || '(tanpa kategori)', limit: 0, spent: spentBy[cat], alertOn: false, status: 'none' });
      g.spent += spentBy[cat];
    });
    groups.forEach(function (g) { g.status = statusOf(g.limit, g.spent, g.alertOn); });
    return { key: key, range: r, groups: groups };
  }
  function alertsFor(bf) {
    var out = [];
    bf.groups.forEach(function (g) {
      if (g.alertOn && (g.status === 'warn' || g.status === 'over') && g.limit > 0) out.push({ label: 'Pos ' + g.pos, limit: g.limit, spent: g.spent, status: g.status });
      g.rows.forEach(function (x) {
        if (x.alertOn && (x.status === 'warn' || x.status === 'over')) out.push({ label: x.cat, limit: x.limit, spent: x.spent, status: x.status });
      });
    });
    out.sort(function (a, b) { return (b.status === 'over') - (a.status === 'over'); });
    return out;
  }
  function alertText(a) {
    if (a.limit <= 0) return 'Tidak ada jatah siklus ini, sudah terpakai ' + rp(a.spent);
    if (a.status === 'over') return 'Lewat ' + rp(a.spent - a.limit) + ' · ' + rp(a.spent) + ' dari ' + rp(a.limit);
    return Math.round(a.spent / a.limit * 100) + '% terpakai · sisa ' + rp(a.limit - a.spent);
  }
  function barHtml(limit, spent, status) {
    var w = limit > 0 ? Math.min(100, spent / limit * 100) : (spent > 0 ? 100 : 0);
    return '<div class="bar ' + status + '"><i style="width:' + w + '%"></i></div>';
  }

  /* ================= API ================= */
  function api(action, payload) {
    var body = Object.assign({ pin: S.pin, action: action }, payload || {});
    return fetch(S.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function (e) { return { ok: false, code: 'NET', error: navigator.onLine === false ? 'Tidak ada koneksi internet.' : 'Gagal menghubungi server. Periksa koneksi atau URL.' }; })
      .then(function (res) {
        if (!res.ok && (res.code === 'BAD_PIN' || res.code === 'LOCKED') && !$('app').hidden) lock(res.error);
        return res;
      });
  }
  function applySync(res) {
    S.tx = res.tx || [];
    S.budget = res.budget || [];
    S.settings = Object.assign(S.settings, res.settings || {});
  }

  /* ================= Toast ================= */
  function toast(msg, kind, ms) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 320); }, ms || 2600);
  }

  /* ================= Gerbang: setup & PIN ================= */
  var pinBuf = '';
  function showSetup() {
    $('app').hidden = true; $('lock').hidden = true; $('setup').hidden = false;
    $('setup-url').value = S.url || '';
  }
  function lock(msg) {
    S.pin = ''; S.tx = []; S.budget = []; pinBuf = '';
    closeForm(); $('confirm').hidden = true;
    ['view-home', 'view-history', 'view-budget', 'view-charts'].forEach(function (id) { $(id).innerHTML = ''; });
    $('app').hidden = true; $('setup').hidden = true; $('lock').hidden = false;
    drawDots(); setLockMsg(msg || '', !!msg);
  }
  function drawDots() { Array.prototype.forEach.call($('pin-dots').children, function (d, i) { d.classList.toggle('on', i < pinBuf.length); }); }
  function setLockMsg(m, bad) { var el = $('lock-msg'); el.textContent = m || ' '; el.classList.toggle('bad', !!bad); }
  function tryUnlock() {
    S.pin = pinBuf;
    $('keypad').classList.add('busy'); setLockMsg('Memuat data…');
    api('sync').then(function (res) {
      $('keypad').classList.remove('busy');
      if (!res.ok) {
        S.pin = ''; pinBuf = ''; drawDots(); setLockMsg(res.error || 'Gagal masuk.', true);
        $('pin-dots').classList.add('shake'); setTimeout(function () { $('pin-dots').classList.remove('shake'); }, 450);
        return;
      }
      pinBuf = ''; applySync(res);
      $('lock').hidden = true; $('app').hidden = false;
      S.cycleOffset = 0; go('home');
    });
  }
  $('keypad').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var k = b.dataset.k;
    if (k === 'del') pinBuf = pinBuf.slice(0, -1);
    else if (pinBuf.length < 6) pinBuf += k;
    setLockMsg(''); drawDots();
    if (pinBuf.length === 6) tryUnlock();
  });
  document.addEventListener('keydown', function (e) {
    if ($('lock').hidden || $('keypad').classList.contains('busy')) return;
    if (/^\d$/.test(e.key) && pinBuf.length < 6) pinBuf += e.key;
    else if (e.key === 'Backspace') pinBuf = pinBuf.slice(0, -1);
    else return;
    drawDots(); if (pinBuf.length === 6) tryUnlock();
  });
  $('change-url').addEventListener('click', showSetup);
  $('setup-save').addEventListener('click', function () {
    var u = $('setup-url').value.trim(), err = $('setup-err');
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) {
      err.textContent = 'URL harus berbentuk https://script.google.com/macros/s/…/exec'; err.hidden = false; return;
    }
    err.hidden = true; S.url = u;
    try { localStorage.setItem(LS_URL, u); } catch (x) {}
    lock();
  });
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS && !$('app').hidden) lock();
  });
  $('btn-lock').addEventListener('click', function () { lock(); });
  $('btn-refresh').addEventListener('click', function () {
    var b = $('btn-refresh'); b.classList.add('spin');
    api('sync').then(function (res) {
      b.classList.remove('spin');
      if (res.ok) { applySync(res); render(); toast('Data diperbarui', 'ok', 1500); }
      else if (res.code === 'NET') toast(res.error, 'bad');
    });
  });

  /* ================= Navigasi ================= */
  var TITLES = { home: 'Beranda', history: 'Riwayat', budget: 'Budget', charts: 'Grafik' };
  function go(v) {
    S.view = v;
    ['home', 'history', 'budget', 'charts'].forEach(function (n) { $('view-' + n).hidden = n !== v; });
    Array.prototype.forEach.call(document.querySelectorAll('.bottom [data-view]'), function (b) { b.classList.toggle('active', b.dataset.view === v); });
    $('top-title').textContent = TITLES[v];
    window.scrollTo(0, 0); render();
  }
  document.querySelector('.bottom').addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]'); if (b) go(b.dataset.view);
  });
  function render() {
    if (S.view === 'home') renderHome();
    else if (S.view === 'history') renderHistory();
    else if (S.view === 'budget') renderBudget();
    else renderCharts();
  }

  /* ================= Bagian bersama ================= */
  var PERIODS = [['today', 'Hari ini'], ['week', 'Minggu ini'], ['month', 'Bulan ini'], ['cycle', 'Siklus gaji'], ['custom', 'Custom']];
  function periodHtml() {
    var r = periodRange(S.period);
    var h = '<div class="chips">' + PERIODS.map(function (p) { return '<button class="chip' + (S.period === p[0] ? ' active' : '') + '" data-period="' + p[0] + '">' + p[1] + '</button>'; }).join('') + '</div>';
    if (S.period === 'custom') h += '<div class="range"><input class="field" type="date" data-range="from" value="' + r.from + '" aria-label="Dari tanggal"><input class="field" type="date" data-range="to" value="' + r.to + '" aria-label="Sampai tanggal"></div>';
    h += '<p class="period-note">' + (r.from === r.to ? fmtDate(r.from, true) : fmtShort(r.from) + ' – ' + fmtDate(r.to)) + '</p>';
    return h;
  }
  function bindPeriod(root) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-period]'); if (!b) return;
      S.period = b.dataset.period;
      if (S.period === 'custom' && !S.from) { var m = periodRange('month'); S.from = m.from; S.to = today(); }
      render();
    });
    root.addEventListener('change', function (e) {
      var k = e.target.dataset && e.target.dataset.range; if (!k || !e.target.value) return;
      S[k] = e.target.value; render();
    });
  }
  function txHtml(t) {
    var sub = [t.note, t.acc].filter(Boolean).join(' · ');
    return '<button class="tx ' + t.type + '" data-id="' + esc(t.id) + '"><span class="ic">' + (t.type === 'in' ? '↓' : '↑') + '</span>' +
      '<span class="mid"><span class="t">' + esc(t.cat || '(tanpa kategori)') + '</span><span class="s" style="display:block">' + esc(sub || (t.type === 'in' ? 'Pemasukan' : t.pos || 'Pengeluaran')) + '</span></span>' +
      '<span class="amt num">' + (t.type === 'in' ? '+' : '−') + rp(t.amount).replace('Rp ', 'Rp ') + '</span></button>';
  }
  function emptyHtml(title, text) { return '<div class="empty"><div class="em">＋</div><b>' + title + '</b>' + text + '</div>'; }
  function byNewest(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }
  function bindTxClicks(root) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('.tx'); if (!b) return;
      var t = S.tx.filter(function (x) { return x.id === b.dataset.id; })[0];
      if (t) openForm(t);
    });
  }

  /* ================= Beranda ================= */
  function renderHome() {
    var r = periodRange(S.period), list = inRange(r);
    var ins = list.filter(function (t) { return t.type === 'in'; }), outs = list.filter(function (t) { return t.type === 'out'; });
    var tin = sum(ins), tout = sum(outs);
    var h = periodHtml();
    h += '<div class="hero"><small>Saldo bersih</small><b class="num">' + rp(tin - tout) + '</b><div class="hero-row">' +
      '<div><span>Pemasukan</span><strong class="num">' + rp(tin) + '</strong></div>' +
      '<div><span>Pengeluaran</span><strong class="num">' + rp(tout) + '</strong></div></div></div>';

    // Alert budget: selalu untuk siklus berjalan
    var bf = budgetFor(cycleKey(today())), al = alertsFor(bf);
    h += '<p class="sec-title">Peringatan budget · ' + monthLabel(bf.key) + '</p>';
    if (!S.budget.length) h += '<div class="card muted">Sheet Budget masih kosong.</div>';
    else if (!al.length) h += '<div class="all-good">✓ Semua pos masih di bawah ' + S.settings.warnPct + '% budget</div>';
    else h += al.map(function (a) {
      return '<div class="alert ' + a.status + '"><span class="ic">!</span><div><b>' + esc(a.label) + (a.status === 'over' ? ' melewati budget' : ' hampir habis') + '</b><span class="num">' + alertText(a) + '</span>' + barHtml(a.limit, a.spent, a.status) + '</div></div>';
    }).join('');

    // Insight
    h += '<p class="sec-title">Insight</p><div class="card insights">';
    if (!outs.length) h += '<p class="muted">Belum ada pengeluaran pada periode ini.</p>';
    else {
      var byCat = {}; outs.forEach(function (t) { byCat[t.cat] = (byCat[t.cat] || 0) + t.amount; });
      var top = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; })[0];
      var endDay = r.to < today() ? r.to : (r.from > today() ? r.from : today());
      var nDays = Math.max(1, daysBetween(r.from, endDay));
      var prev = sum(inRange(prevRange(S.period, r)).filter(function (t) { return t.type === 'out'; }));
      var cmp = '<b class="muted">Belum ada data pembanding</b>';
      if (prev > 0) { var pc = (tout - prev) / prev * 100; cmp = '<b class="' + (pc > 0 ? 'up' : 'down') + '">' + (pc > 0 ? '▲ naik ' : '▼ turun ') + Math.abs(pc).toFixed(0) + '%</b>'; }
      h += '<div class="insight"><span>Kategori terbesar</span><b>' + esc(top) + '<br><span class="num">' + rp(byCat[top]) + ' · ' + Math.round(byCat[top] / tout * 100) + '%</span></b></div>' +
        '<div class="insight"><span>Rata-rata pengeluaran harian</span><b class="num">' + rp(tout / nDays) + '</b></div>' +
        '<div class="insight"><span>Pengeluaran vs periode sebelumnya</span>' + cmp + '</div>';
    }
    h += '</div>';

    // Transaksi terbaru (semua periode)
    var recent = S.tx.slice().sort(byNewest).slice(0, 5);
    h += '<p class="sec-title">Transaksi terbaru</p><div class="card">' +
      (recent.length ? '<div class="tx-list">' + recent.map(txHtml).join('') + '</div>' : emptyHtml('Belum ada transaksi', 'Ketuk tombol + di bawah untuk mencatat yang pertama.')) + '</div>';
    $('view-home').innerHTML = h;
  }

  /* ================= Riwayat ================= */
  function renderHistory() {
    var f = S.hist;
    var cats = {}; S.tx.forEach(function (t) { if (t.cat) cats[t.cat] = 1; });
    var h = '<input id="h-q" class="field" type="search" placeholder="Cari catatan, kategori, nominal…" value="' + esc(f.q) + '">' +
      '<div class="chips">' + [['', 'Semua'], ['out', 'Pengeluaran'], ['in', 'Pemasukan']].map(function (x) { return '<button class="chip' + (f.type === x[0] ? ' active' : '') + '" data-htype="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="filters"><select id="h-cat" class="field" aria-label="Kategori"><option value="">Semua kategori</option>' +
      Object.keys(cats).sort().map(function (c) { return '<option' + (f.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
      '<input id="h-month" class="field" type="month" value="' + esc(f.month) + '" aria-label="Bulan"></div>' +
      '<div id="h-list" class="card"></div>';
    $('view-history').innerHTML = h;
    drawHistoryList();
  }
  function drawHistoryList() {
    var f = S.hist, q = f.q.trim().toLowerCase(), qNum = q.replace(/\D/g, '');
    var list = S.tx.filter(function (t) {
      if (f.type && t.type !== f.type) return false;
      if (f.cat && t.cat !== f.cat) return false;
      if (f.month && t.date.slice(0, 7) !== f.month) return false;
      if (q) {
        var hay = (t.cat + ' ' + t.note + ' ' + t.acc + ' ' + t.pos).toLowerCase();
        if (hay.indexOf(q) < 0 && !(qNum && String(Math.round(t.amount)).indexOf(qNum) >= 0)) return false;
      }
      return true;
    }).sort(byNewest);
    var el = $('h-list');
    if (!list.length) { el.innerHTML = S.tx.length ? emptyHtml('Tidak ada yang cocok', 'Coba ubah kata kunci atau filter.') : emptyHtml('Belum ada transaksi', 'Ketuk tombol + di bawah untuk mulai mencatat.'); return; }
    var h = '', last = '', shown = list.slice(0, 300);
    shown.forEach(function (t) {
      if (t.date !== last) {
        var day = shown.filter(function (x) { return x.date === t.date; });
        var net = sum(day.filter(function (x) { return x.type === 'in'; })) - sum(day.filter(function (x) { return x.type === 'out'; }));
        h += '<div class="day-head"><span>' + fmtDate(t.date, true) + '</span><span class="num">' + rp(net) + '</span></div>'; last = t.date;
      }
      h += txHtml(t);
    });
    if (list.length > shown.length) h += '<p class="sub">Menampilkan 300 dari ' + list.length + ' transaksi. Persempit dengan filter.</p>';
    el.innerHTML = '<div class="tx-list">' + h + '</div>';
  }
  (function () {
    var root = $('view-history');
    root.addEventListener('input', function (e) { if (e.target.id === 'h-q') { S.hist.q = e.target.value; drawHistoryList(); } });
    root.addEventListener('change', function (e) {
      if (e.target.id === 'h-cat') S.hist.cat = e.target.value; else if (e.target.id === 'h-month') S.hist.month = e.target.value; else return;
      drawHistoryList();
    });
    root.addEventListener('click', function (e) { var b = e.target.closest('[data-htype]'); if (b) { S.hist.type = b.dataset.htype; renderHistory(); } });
  })();

  /* ================= Budget ================= */
  var BADGE = { warn: 'Hampir habis', over: 'Melewati', full: 'Terpenuhi' };
  function renderBudget() {
    var key = shiftKey(cycleKey(today()), S.cycleOffset), bf = budgetFor(key);
    var tl = 0, ts = 0; bf.groups.forEach(function (g) { tl += g.limit; ts += g.spent; });
    var h = '<div class="card cycle-nav"><button class="icon-btn" data-cyc="-1" aria-label="Siklus sebelumnya">‹</button><div><b>Budget ' + monthLabel(key) + '</b><small>' + fmtShort(bf.range.from) + ' – ' + fmtDate(bf.range.to) + '</small></div><button class="icon-btn" data-cyc="1" aria-label="Siklus berikutnya">›</button></div>';
    if (!S.budget.length) { $('view-budget').innerHTML = h + '<div class="card">' + emptyHtml('Budget belum diisi', 'Isi sheet "Budget" di spreadsheet.') + '</div>'; return; }
    h += '<div class="card"><div class="pos-head"><h3>Total terpakai</h3><span class="num"><b>' + rp(ts) + '</b> / ' + rp(tl) + '</span></div>' + barHtml(tl, ts, ts > tl ? 'over' : 'ok') + '<p class="sub num">' + (ts > tl ? 'Lewat ' + rp(ts - tl) : 'Sisa ' + rp(tl - ts)) + '</p></div>';
    bf.groups.forEach(function (g) {
      h += '<div class="card"><div class="pos-head"><h3>' + esc(g.pos) + (BADGE[g.status] ? ' <span class="badge ' + g.status + '">' + BADGE[g.status] + '</span>' : '') + '</h3><span class="num"><b>' + rp(g.spent) + '</b>' + (g.limit > 0 || g.alertOn ? ' / ' + rp(g.limit) : '') + '</span></div>' + barHtml(g.limit, g.spent, g.status);
      g.rows.forEach(function (x) {
        h += '<div class="bud-row"><div class="l"><span>' + esc(x.cat) + '</span><span class="num">' + (BADGE[x.status] && x.status !== 'full' ? '<span class="badge ' + x.status + '">' + BADGE[x.status] + '</span> ' : '') + rp(x.spent) + (x.limit > 0 || x.alertOn ? ' / ' + rp(x.limit) : '') + '</span></div>' + barHtml(x.limit, x.spent, x.status) + '</div>';
      });
      h += '</div>';
    });
    $('view-budget').innerHTML = h;
  }
  $('view-budget').addEventListener('click', function (e) { var b = e.target.closest('[data-cyc]'); if (b) { S.cycleOffset += +b.dataset.cyc; renderBudget(); } });

  /* ================= Grafik ================= */
  /** Grafik batang SVG dengan satu sumbu. Ketuk batang untuk melihat angkanya. */
  function barChart(host, labels, series, tickEvery) {
    var W = 340, H = 170, L = 42, R = 4, T = 8, B = 20, n = labels.length;
    var max = 0; series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    if (max <= 0) max = 1;
    var pw = W - L - R, ph = H - T - B, slot = pw / n, k = series.length;
    var bw = Math.max(2, Math.min(22, (slot - 2 - (k - 1) * 2) / k));
    var svg = '';
    [0, .5, 1].forEach(function (f) {
      var y = T + ph - ph * f;
      svg += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (L - 5) + '" y="' + (y + 3) + '" text-anchor="end">' + (f ? rpShort(max * f) : '0') + '</text>';
    });
    for (var i = 0; i < n; i++) {
      var x0 = L + slot * i, gw = k * bw + (k - 1) * 2, gx = x0 + (slot - gw) / 2;
      svg += '<rect class="sel" data-sel="' + i + '" x="' + x0 + '" y="' + T + '" width="' + slot + '" height="' + ph + '" visibility="hidden"/>';
      series.forEach(function (s, j) {
        var v = s.values[i]; if (!(v > 0)) return;
        var bh = Math.max(1.5, ph * v / max), x = gx + j * (bw + 2), y = T + ph - bh, rr = Math.min(4, bw / 2, bh);
        svg += '<path fill="' + s.color + '" d="M' + x + ' ' + (y + bh) + 'V' + (y + rr) + 'Q' + x + ' ' + y + ' ' + (x + rr) + ' ' + y + 'H' + (x + bw - rr) + 'Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + (y + rr) + 'V' + (y + bh) + 'Z"/>';
      });
      if (i % tickEvery === 0) svg += '<text x="' + (x0 + slot / 2) + '" y="' + (H - 5) + '" text-anchor="middle">' + esc(labels[i].short) + '</text>';
      svg += '<rect class="hit" data-i="' + i + '" x="' + x0 + '" y="0" width="' + slot + '" height="' + H + '"/>';
    }
    var legend = k > 1 ? '<div class="legend">' + series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + s.name + '</span>'; }).join('') + '</div>' : '';
    host.innerHTML = legend + '<div class="readout"></div><svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img">' + svg + '</svg>';
    var ro = host.querySelector('.readout');
    function show(i) {
      Array.prototype.forEach.call(host.querySelectorAll('[data-sel]'), function (el) { el.setAttribute('visibility', +el.dataset.sel === i ? 'visible' : 'hidden'); });
      if (i < 0) { ro.innerHTML = '<span class="muted">Ketuk batang untuk melihat rinciannya</span>'; return; }
      ro.innerHTML = '<span>' + esc(labels[i].full) + '</span><span class="num">' + series.map(function (s) { return (k > 1 ? s.name + ' ' : '') + '<b>' + rp(s.values[i]) + '</b>'; }).join(' · ') + '</span>';
    }
    show(-1);
    function pick(e) { var t = e.target.closest('.hit'); if (t) show(+t.dataset.i); }
    host.querySelector('svg').addEventListener('click', pick);
    host.querySelector('svg').addEventListener('mousemove', pick);
  }

  function renderCharts() {
    var r = periodRange(S.period), list = inRange(r), outs = list.filter(function (t) { return t.type === 'out'; });
    var h = periodHtml();
    h += '<div class="card"><h3>Pengeluaran per kategori</h3><div id="c-cat"></div></div>' +
      '<div class="card"><h3 id="c-trend-title">Tren pengeluaran</h3><div id="c-trend"></div></div>' +
      '<div class="card"><h3>Pemasukan vs pengeluaran · 6 bulan terakhir</h3><div id="c-cmp"></div></div>';
    $('view-charts').innerHTML = h;

    // 1) Per kategori: batang mendatar, satu warna, berlabel langsung
    var byCat = {}; outs.forEach(function (t) { var c = t.cat || '(tanpa kategori)'; byCat[c] = (byCat[c] || 0) + t.amount; });
    var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; });
    if (!cats.length) $('c-cat').innerHTML = emptyHtml('Belum ada pengeluaran', 'Tidak ada data pada periode ini.');
    else {
      var total = sum(outs), top = cats.slice(0, 7), rest = cats.slice(7), items = top.map(function (c) { return [c, byCat[c]]; });
      if (rest.length) items.push(['Lainnya (' + rest.length + ' kategori)', rest.reduce(function (a, c) { return a + byCat[c]; }, 0)]);
      var mx = items.reduce(function (a, x) { return Math.max(a, x[1]); }, 0);
      $('c-cat').innerHTML = '<div class="hbar">' + items.map(function (x) {
        return '<div><div class="l"><span>' + esc(x[0]) + '</span><span class="num"><b>' + rp(x[1]) + '</b> · ' + Math.round(x[1] / total * 100) + '%</span></div><div class="bar"><i style="width:' + Math.max(1.5, x[1] / mx * 100) + '%"></i></div></div>';
      }).join('') + '</div>';
    }

    // 2) Tren: harian, atau bulanan jika periodenya panjang
    var nDays = daysBetween(r.from, r.to), labels = [], vals = [], map = {};
    if (!outs.length) $('c-trend').innerHTML = emptyHtml('Belum ada pengeluaran', 'Tidak ada data pada periode ini.');
    else if (nDays <= 45) {
      $('c-trend-title').textContent = 'Tren pengeluaran harian';
      outs.forEach(function (t) { map[t.date] = (map[t.date] || 0) + t.amount; });
      for (var d = r.from; d <= r.to; d = addDays(d, 1)) { labels.push({ short: String(+d.slice(8)), full: fmtDate(d, true) }); vals.push(map[d] || 0); }
      barChart($('c-trend'), labels, [{ name: 'Pengeluaran', color: 'var(--out)', values: vals }], nDays > 16 ? 5 : nDays > 8 ? 2 : 1);
    } else {
      $('c-trend-title').textContent = 'Tren pengeluaran bulanan';
      outs.forEach(function (t) { var k = t.date.slice(0, 7); map[k] = (map[k] || 0) + t.amount; });
      for (var k = r.from.slice(0, 7); k <= r.to.slice(0, 7); k = shiftKey(k, 1)) { labels.push({ short: MON[+k.slice(5) - 1], full: monthLabel(k) }); vals.push(map[k] || 0); }
      barChart($('c-trend'), labels, [{ name: 'Pengeluaran', color: 'var(--out)', values: vals }], Math.ceil(labels.length / 8));
    }

    // 3) Pemasukan vs pengeluaran per bulan kalender
    if (!S.tx.length) { $('c-cmp').innerHTML = emptyHtml('Belum ada transaksi', 'Grafik muncul setelah ada data.'); return; }
    var cur = today().slice(0, 7), L2 = [], vi = [], vo = [];
    for (var i = -5; i <= 0; i++) {
      var mk = shiftKey(cur, i), a = 0, b = 0;
      S.tx.forEach(function (t) { if (t.date.slice(0, 7) === mk) { if (t.type === 'in') a += t.amount; else b += t.amount; } });
      L2.push({ short: MON[+mk.slice(5) - 1], full: monthLabel(mk) }); vi.push(a); vo.push(b);
    }
    barChart($('c-cmp'), L2, [{ name: 'Pemasukan', color: 'var(--in)', values: vi }, { name: 'Pengeluaran', color: 'var(--out)', values: vo }], 1);
  }

  /* ================= Form transaksi ================= */
  function fmtAmountInput() {
    var el = $('f-amount'), digits = el.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 13);
    el.value = digits ? Number(digits).toLocaleString('id-ID') : '';
  }
  function drawCats() {
    var h = '', F = S.form;
    function chip(c) { return '<button type="button" class="chip' + (F.cat === c ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>'; }
    if (F.type === 'in') h = (S.settings.incomeCats.length ? S.settings.incomeCats : ['Gaji', 'Lainnya']).map(chip).join('');
    else {
      var last = null;
      S.budget.forEach(function (b) { if (b.pos !== last) { h += '<span class="grp">' + esc(b.pos) + '</span>'; last = b.pos; } h += chip(b.cat); });
      if (!S.budget.length) h = chip('Lainnya');
    }
    // kategori lama yang tidak ada di daftar tetap bisa dipertahankan saat mengedit
    if (F.cat && h.indexOf('data-cat="' + esc(F.cat) + '"') < 0) h = chip(F.cat) + h;
    $('f-cats').innerHTML = h;
  }
  function setType(t) {
    S.form.type = t;
    Array.prototype.forEach.call($('form-type').children, function (b) { b.classList.toggle('active', b.dataset.type === t); });
    drawCats();
  }
  function openForm(tx) {
    var F = S.form;
    F.id = tx ? tx.id : null; F.origType = tx ? tx.type : null; F.cat = tx ? tx.cat : '';
    $('form-title').textContent = tx ? 'Ubah transaksi' : 'Tambah transaksi';
    $('f-amount').value = tx ? String(Math.round(tx.amount)) : ''; fmtAmountInput();
    $('f-date').value = tx ? tx.date : today();
    $('f-note').value = tx ? tx.note : '';
    var accs = S.settings.accounts.slice();
    if (tx && tx.acc && accs.indexOf(tx.acc) < 0) accs.unshift(tx.acc);
    $('f-acc').innerHTML = '<option value="">—</option>' + accs.map(function (a) { return '<option>' + esc(a) + '</option>'; }).join('');
    $('f-acc').value = tx ? tx.acc : '';
    $('f-err').hidden = true; $('f-delete').hidden = !tx;
    setSaving(false);
    setType(tx ? tx.type : 'out');
    $('sheet').hidden = false;
    if (!tx) setTimeout(function () { $('f-amount').focus(); }, 60);
  }
  function closeForm() { $('sheet').hidden = true; }
  function setSaving(on) {
    var b = $('f-save'); b.disabled = on;
    b.innerHTML = on ? '<span class="spinner"></span> Menyimpan…' : 'Simpan';
    $('f-delete').disabled = on;
  }
  $('fab').addEventListener('click', function () { openForm(null); });
  $('form-close').addEventListener('click', closeForm);
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) closeForm(); });
  $('f-amount').addEventListener('input', fmtAmountInput);
  $('form-type').addEventListener('click', function (e) { var b = e.target.closest('[data-type]'); if (b && b.dataset.type !== S.form.type) { S.form.cat = ''; setType(b.dataset.type); } });
  $('f-cats').addEventListener('click', function (e) {
    var b = e.target.closest('[data-cat]'); if (!b) return;
    S.form.cat = b.dataset.cat; drawCats();
    var row = S.budget.filter(function (x) { return x.cat === S.form.cat; })[0];   // isi rekening otomatis
    if (S.form.type === 'out' && row && row.acc && S.settings.accounts.indexOf(row.acc) >= 0) $('f-acc').value = row.acc;
  });
  $('tx-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var F = S.form, err = $('f-err'), amount = Number($('f-amount').value.replace(/\D/g, ''));
    var msg = !amount || amount <= 0 ? 'Nominal wajib diisi dan harus lebih dari 0.' : !F.cat ? 'Pilih kategori dulu.' : !$('f-date').value ? 'Tanggal wajib diisi.' : '';
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    err.hidden = true;
    var row = S.budget.filter(function (x) { return x.cat === F.cat; })[0];
    var tx = { type: F.type, amount: amount, cat: F.cat, pos: F.type === 'out' && row ? row.pos : '', date: $('f-date').value, acc: $('f-acc').value, note: $('f-note').value.trim() };
    var editing = !!F.id;
    if (editing) { tx.id = F.id; tx.origType = F.origType; }
    var before = tx.type === 'out' ? alertKeys(tx.date) : null;
    setSaving(true);
    api(editing ? 'update' : 'add', { tx: tx }).then(function (res) {
      setSaving(false);
      if (!res.ok) { if (res.code !== 'BAD_PIN' && res.code !== 'LOCKED') { err.textContent = res.error || 'Gagal menyimpan.'; err.hidden = false; toast('Gagal menyimpan', 'bad'); } return; }
      if (editing) S.tx = S.tx.filter(function (t) { return t.id !== tx.id; });
      S.tx.push(res.tx);
      closeForm(); render();
      toast(editing ? 'Perubahan tersimpan' : (tx.type === 'in' ? 'Pemasukan' : 'Pengeluaran') + ' ' + rp(amount) + ' tersimpan', 'ok');
      if (before) {                                       // notifikasi jika transaksi ini memicu peringatan baru
        alertsFor(budgetFor(cycleKey(tx.date))).forEach(function (a) {
          if (before[a.label] !== a.status) toast((a.status === 'over' ? '⚠ ' + a.label + ' melewati budget. ' : '⚠ ' + a.label + ' hampir habis. ') + alertText(a), a.status === 'over' ? 'bad' : 'warn', 6000);
        });
      }
    });
  });
  function alertKeys(dateStr) { var m = {}; alertsFor(budgetFor(cycleKey(dateStr))).forEach(function (a) { m[a.label] = a.status; }); return m; }

  /* ================= Hapus ================= */
  $('f-delete').addEventListener('click', function () {
    var t = S.tx.filter(function (x) { return x.id === S.form.id; })[0]; if (!t) return;
    $('confirm-text').textContent = t.cat + ' · ' + rp(t.amount) + ' · ' + fmtDate(t.date) + '. Baris ini juga dihapus dari spreadsheet dan tidak bisa dikembalikan dari aplikasi.';
    $('confirm').hidden = false;
  });
  $('confirm-no').addEventListener('click', function () { $('confirm').hidden = true; });
  $('confirm-yes').addEventListener('click', function () {
    var id = S.form.id, type = S.form.origType, b = $('confirm-yes');
    b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
    api('delete', { id: id, type: type }).then(function (res) {
      b.disabled = false; b.textContent = 'Hapus'; $('confirm').hidden = true;
      if (!res.ok) { if (res.code !== 'BAD_PIN' && res.code !== 'LOCKED') toast(res.error || 'Gagal menghapus', 'bad'); return; }
      S.tx = S.tx.filter(function (t) { return t.id !== id; });
      closeForm(); render(); toast('Transaksi dihapus', 'ok');
    });
  });

  /* ================= Mulai ================= */
  bindPeriod($('view-home')); bindPeriod($('view-charts'));
  bindTxClicks($('view-home')); bindTxClicks($('view-history'));
  try { S.url = localStorage.getItem(LS_URL) || ''; } catch (x) {}
  if (S.url) lock(); else showSetup();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
})();
