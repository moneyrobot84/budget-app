/**
 * BUDGET KELUARGA — backend Google Apps Script
 * Tempel seluruh isi file ini di: Spreadsheet > Ekstensi > Apps Script.
 * Lalu: menu "Budget App" > "Atur / Ganti PIN", dan Deploy sebagai Web App.
 */

var SHEET_IN = 'Pemasukan';
var SHEET_OUT = 'Pengeluaran';
var SHEET_BUDGET = 'Budget';
var SHEET_SET = 'Pengaturan';
var MAX_FAIL = 5;          // salah PIN berturut-turut sebelum dikunci
var LOCK_MINUTES = 15;     // lama kunci

/* ---------- Menu di spreadsheet ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Budget App')
    .addItem('Atur / Ganti PIN', 'aturPin')
    .addItem('Buka kunci (reset salah PIN)', 'resetKunci')
    .addToUi();
}

function aturPin() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('PIN aplikasi', 'Masukkan PIN baru (tepat 6 angka):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var pin = String(r.getResponseText()).trim();
  if (!/^\d{6}$/.test(pin)) { ui.alert('PIN harus tepat 6 angka. Coba lagi.'); return; }
  var salt = Utilities.getUuid();
  var p = PropertiesService.getScriptProperties();
  p.setProperty('PIN_SALT', salt);
  p.setProperty('PIN_HASH', hashPin_(salt, pin));
  p.deleteProperty('FAIL_COUNT');
  p.deleteProperty('LOCK_UNTIL');
  ui.alert('PIN tersimpan. PIN tidak disimpan dalam bentuk asli, jadi ingat baik-baik.');
}

function resetKunci() {
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty('FAIL_COUNT');
  p.deleteProperty('LOCK_UNTIL');
  SpreadsheetApp.getUi().alert('Kunci dibuka. Silakan coba masuk lagi dari aplikasi.');
}

function hashPin_(salt, pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

/* ---------- Pintu masuk API ---------- */

function doGet() {
  return json_({ ok: true, info: 'Budget App API aktif.' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var req = JSON.parse(e.postData.contents || '{}');
    var auth = cekPin_(req.pin);
    if (!auth.ok) return json_(auth);
    switch (req.action) {
      case 'sync': return json_(sync_());
      case 'add': return json_(add_(req.tx));
      case 'update': return json_(update_(req.tx));
      case 'delete': return json_(hapus_(req.id, req.type));
      default: return json_({ ok: false, error: 'Aksi tidak dikenal.' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'Kesalahan server: ' + err.message });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function cekPin_(pin) {
  var p = PropertiesService.getScriptProperties();
  var hash = p.getProperty('PIN_HASH');
  if (!hash) return { ok: false, code: 'NO_PIN', error: 'PIN belum diatur. Buka spreadsheet > menu Budget App > Atur PIN.' };
  var now = Date.now();
  var until = Number(p.getProperty('LOCK_UNTIL') || 0);
  if (until > now) {
    return { ok: false, code: 'LOCKED', error: 'Terlalu banyak percobaan. Coba lagi dalam ' + Math.ceil((until - now) / 60000) + ' menit.' };
  }
  if (hashPin_(p.getProperty('PIN_SALT'), String(pin || '')) === hash) {
    if (p.getProperty('FAIL_COUNT')) p.deleteProperty('FAIL_COUNT');
    return { ok: true };
  }
  var fails = Number(p.getProperty('FAIL_COUNT') || 0) + 1;
  if (fails >= MAX_FAIL) {
    p.setProperty('LOCK_UNTIL', String(now + LOCK_MINUTES * 60000));
    p.deleteProperty('FAIL_COUNT');
    return { ok: false, code: 'LOCKED', error: 'PIN salah ' + MAX_FAIL + ' kali. Aplikasi dikunci ' + LOCK_MINUTES + ' menit.' };
  }
  p.setProperty('FAIL_COUNT', String(fails));
  return { ok: false, code: 'BAD_PIN', error: 'PIN salah. Sisa percobaan: ' + (MAX_FAIL - fails) + '.' };
}

/* ---------- Bantuan sheet ---------- */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" tidak ditemukan.');
  return sh;
}

/** Peta nama header (huruf kecil) -> indeks kolom (mulai 0). Kolom boleh diurutkan ulang. */
function headerMap_(sh) {
  var last = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, last).getDisplayValues()[0];
  var map = {};
  head.forEach(function (h, i) { var k = String(h).trim().toLowerCase(); if (k) map[k] = i; });
  return { map: map, width: last, raw: head };
}

function butuhKolom_(hm, names, sheetName) {
  names.forEach(function (n) {
    if (!(n in hm.map)) throw new Error('Kolom "' + n + '" tidak ada di sheet ' + sheetName + '.');
  });
}

function tglKeTeks_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  var s = String(v || '').trim();
  var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);       // 16/11/2026
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

function teksKeTgl_(s) {
  return Utilities.parseDate(s, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

function angka_(v) {
  if (typeof v === 'number') return v;
  var s = String(v || '').replace(/[^\d,.\-]/g, '');
  if (!s) return 0;
  s = s.replace(/\./g, '').replace(',', '.');   // format Indonesia: 1.250.000,50
  var n = Number(s);
  return isNaN(n) ? 0 : n;
}

/** Baca semua transaksi satu sheet. Baris lama tanpa ID diberi ID (isi lain tidak disentuh). */
function bacaTx_(type) {
  var name = type === 'in' ? SHEET_IN : SHEET_OUT;
  var sh = sheet_(name);
  var hm = headerMap_(sh);
  butuhKolom_(hm, ['id', 'tanggal', 'kategori', 'nominal'], name);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var vals = sh.getRange(2, 1, lastRow - 1, hm.width).getValues();
  var c = hm.map, out = [];
  vals.forEach(function (r, i) {
    var date = tglKeTeks_(r[c['tanggal']]);
    var amount = angka_(r[c['nominal']]);
    if (!date || !(amount > 0)) return;            // lewati baris kosong / baris total
    var id = String(r[c['id']] || '').trim();
    if (!id) {
      id = buatId_();
      sh.getRange(i + 2, c['id'] + 1).setValue(id);
    }
    out.push({
      id: id, type: type, date: date, amount: amount,
      pos: 'pos' in c ? String(r[c['pos']] || '') : '',
      cat: String(r[c['kategori']] || ''),
      acc: 'rekening' in c ? String(r[c['rekening']] || '') : '',
      note: 'catatan' in c ? String(r[c['catatan']] || '') : ''
    });
  });
  return out;
}

function buatId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

function bacaBudget_() {
  var sh = sheet_(SHEET_BUDGET);
  var hm = headerMap_(sh);
  butuhKolom_(hm, ['pos', 'kategori', 'default'], SHEET_BUDGET);
  var c = hm.map;
  var monthCols = [];
  hm.raw.forEach(function (h, i) {
    var k = String(h).trim();
    if (/^\d{4}-\d{2}$/.test(k)) monthCols.push({ key: k, i: i });
  });
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, hm.width).getValues().filter(function (r) {
    return String(r[c['kategori']] || '').trim();
  }).map(function (r) {
    var over = {};
    monthCols.forEach(function (m) { if (r[m.i] !== '' && r[m.i] !== null) over[m.key] = angka_(r[m.i]); });
    return {
      pos: String(r[c['pos']] || '').trim(),
      cat: String(r[c['kategori']]).trim(),
      alert: 'alert' in c ? /^y/i.test(String(r[c['alert']])) : true,
      acc: 'rekening default' in c ? String(r[c['rekening default']] || '').trim() : '',
      def: angka_(r[c['default']]),
      over: over
    };
  });
}

function bacaPengaturan_() {
  var sh = sheet_(SHEET_SET);
  var vals = sh.getDataRange().getValues();
  var s = { cycleStart: 25, warnPct: 80, email: true, incomeCats: [], accounts: [] };
  for (var i = 1; i < vals.length; i++) {
    var k = String(vals[i][0] || '').trim().toLowerCase(), v = vals[i][1];
    if (k.indexOf('siklus') >= 0) s.cycleStart = Math.min(28, Math.max(1, Number(v) || 1));
    else if (k.indexOf('peringatan') >= 0) s.warnPct = Math.min(100, Math.max(1, Number(v) || 80));
    else if (k.indexOf('email') >= 0) s.email = /^y/i.test(String(v));
    if (String(vals[i][3] || '').trim()) s.incomeCats.push(String(vals[i][3]).trim());
    if (String(vals[i][5] || '').trim()) s.accounts.push(String(vals[i][5]).trim());
  }
  return s;
}

/* ---------- Aksi ---------- */

function sync_() {
  return {
    ok: true,
    tx: bacaTx_('in').concat(bacaTx_('out')),
    budget: bacaBudget_(),
    settings: bacaPengaturan_()
  };
}

function validasi_(tx) {
  if (!tx) return 'Data kosong.';
  if (tx.type !== 'in' && tx.type !== 'out') return 'Jenis transaksi tidak valid.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tx.date || ''))) return 'Tanggal tidak valid.';
  tx.amount = Number(tx.amount);
  if (!(tx.amount > 0) || !isFinite(tx.amount)) return 'Nominal harus lebih dari 0.';
  if (!String(tx.cat || '').trim()) return 'Kategori wajib dipilih.';
  tx.cat = String(tx.cat).trim().slice(0, 100);
  tx.pos = String(tx.pos || '').trim().slice(0, 100);
  tx.acc = String(tx.acc || '').trim().slice(0, 100);
  tx.note = String(tx.note || '').trim().slice(0, 300);
  return '';
}

/** Teks dari aplikasi tidak boleh dijalankan sebagai formula. */
function aman_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }

function barisDari_(hm, tx, lama) {
  var row = lama ? lama.slice() : new Array(hm.width).fill('');
  var c = hm.map;
  function set(k, v) { if (k in c) row[c[k]] = v; }
  set('id', tx.id);
  set('tanggal', teksKeTgl_(tx.date));
  set('pos', aman_(tx.pos));
  set('kategori', aman_(tx.cat));
  set('nominal', tx.amount);
  set('rekening', aman_(tx.acc));
  set('catatan', aman_(tx.note));
  if (!lama) set('dicatat', new Date());
  return row;
}

function tulisBaris_(sh, hm, rowIndex, row) {
  sh.getRange(rowIndex, 1, 1, hm.width).setValues([row]);
  var c = hm.map;
  if ('tanggal' in c) sh.getRange(rowIndex, c['tanggal'] + 1).setNumberFormat('dd/MM/yyyy');
  if ('nominal' in c) sh.getRange(rowIndex, c['nominal'] + 1).setNumberFormat('"Rp"#,##0');
  if ('dicatat' in c) sh.getRange(rowIndex, c['dicatat'] + 1).setNumberFormat('dd/MM/yyyy HH:mm');
}

function add_(tx) {
  var err = validasi_(tx);
  if (err) return { ok: false, error: err };
  tx.id = buatId_();
  var sh = sheet_(tx.type === 'in' ? SHEET_IN : SHEET_OUT);
  var hm = headerMap_(sh);
  var before = tx.type === 'out' ? bacaTx_('out') : null;
  tulisBaris_(sh, hm, sh.getLastRow() + 1, barisDari_(hm, tx, null));   // selalu baris baru di bawah
  if (before) kirimAlert_(tx, before);
  return { ok: true, tx: tx };
}

function cariBaris_(sh, hm, id) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2 || !('id' in hm.map)) return -1;
  var ids = sh.getRange(2, hm.map['id'] + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === String(id)) return i + 2;
  return -1;
}

function update_(tx) {
  var err = validasi_(tx);
  if (err) return { ok: false, error: err };
  if (!tx.id) return { ok: false, error: 'ID transaksi tidak ada.' };
  var asal = tx.origType === 'in' || tx.origType === 'out' ? tx.origType : tx.type;
  var shAsal = sheet_(asal === 'in' ? SHEET_IN : SHEET_OUT);
  var hmAsal = headerMap_(shAsal);
  var rowIndex = cariBaris_(shAsal, hmAsal, tx.id);
  if (rowIndex < 0) return { ok: false, error: 'Transaksi tidak ditemukan. Mungkin sudah dihapus dari spreadsheet.' };
  if (asal === tx.type) {
    var lama = shAsal.getRange(rowIndex, 1, 1, hmAsal.width).getValues()[0];
    tulisBaris_(shAsal, hmAsal, rowIndex, barisDari_(hmAsal, tx, lama));
  } else {                                            // pindah jenis: tulis dulu ke sheet tujuan, baru hapus
    var shBaru = sheet_(tx.type === 'in' ? SHEET_IN : SHEET_OUT);
    var hmBaru = headerMap_(shBaru);
    tulisBaris_(shBaru, hmBaru, shBaru.getLastRow() + 1, barisDari_(hmBaru, tx, null));
    shAsal.deleteRow(rowIndex);
  }
  delete tx.origType;
  return { ok: true, tx: tx };
}

function hapus_(id, type) {
  if (type !== 'in' && type !== 'out') return { ok: false, error: 'Jenis transaksi tidak valid.' };
  var sh = sheet_(type === 'in' ? SHEET_IN : SHEET_OUT);
  var hm = headerMap_(sh);
  var rowIndex = cariBaris_(sh, hm, id);
  if (rowIndex < 0) return { ok: false, error: 'Transaksi tidak ditemukan.' };
  sh.deleteRow(rowIndex);
  return { ok: true, id: id };
}

/* ---------- Alert budget lewat email ---------- */

/** Kunci siklus "yyyy-MM" untuk sebuah tanggal. Siklus mulai tgl 25 dinamai bulan berikutnya. */
function kunciSiklus_(dateStr, start) {
  var y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7)), d = Number(dateStr.slice(8, 10));
  if (start > 1 && d >= start) { m++; if (m > 12) { m = 1; y++; } }
  return y + '-' + ('0' + m).slice(-2);
}

function kirimAlert_(tx, before) {
  try {
    var s = bacaPengaturan_();
    if (!s.email) return;
    var key = kunciSiklus_(tx.date, s.cycleStart);
    var budget = bacaBudget_();
    function bud(b) { return key in b.over ? b.over[key] : b.def; }
    var inCycle = before.filter(function (t) { return kunciSiklus_(t.date, s.cycleStart) === key; });
    var pesan = [];

    function cek(label, limit, lama, baru) {
      if (limit <= 0) {
        if (lama === 0 && baru > 0) pesan.push(label + ': bulan ini tidak ada jatah, tetapi sudah terpakai ' + rp_(baru) + '.');
        return;
      }
      var w = limit * s.warnPct / 100;
      if (lama <= limit && baru > limit) pesan.push(label + ': MELEWATI budget. Terpakai ' + rp_(baru) + ' dari ' + rp_(limit) + '.');
      else if (lama < w && baru >= w && baru <= limit) pesan.push(label + ': sudah ' + Math.round(baru / limit * 100) + '% dari budget. Sisa ' + rp_(limit - baru) + '.');
    }

    var row = budget.filter(function (b) { return b.cat === tx.cat; })[0];
    if (row && row.alert) {
      var lamaCat = inCycle.filter(function (t) { return t.cat === tx.cat; }).reduce(function (a, t) { return a + t.amount; }, 0);
      cek('Kategori ' + tx.cat, bud(row), lamaCat, lamaCat + tx.amount);
    }
    var pos = row ? row.pos : tx.pos;
    var rowsPos = budget.filter(function (b) { return b.pos === pos; });
    if (pos && rowsPos.some(function (b) { return b.alert; })) {
      var cats = rowsPos.map(function (b) { return b.cat; });
      var lamaPos = inCycle.filter(function (t) { return cats.indexOf(t.cat) >= 0; }).reduce(function (a, t) { return a + t.amount; }, 0);
      var limitPos = rowsPos.reduce(function (a, b) { return a + bud(b); }, 0);
      if (limitPos > 0) cek('Pos ' + pos, limitPos, lamaPos, lamaPos + tx.amount);
    }
    if (!pesan.length) return;
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      'Peringatan budget ' + key + ': ' + (row ? tx.cat : pos),
      pesan.join('\n') + '\n\nTransaksi terakhir: ' + tx.cat + ' ' + rp_(tx.amount) + ' (' + tx.date + ').\n\nDikirim otomatis oleh Budget App.');
  } catch (e) { /* alert email tidak boleh menggagalkan penyimpanan */ }
}

function rp_(n) {
  return 'Rp ' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/* ---------- Izin ---------- */

/** Jalankan sekali dari editor (pilih "izinkan" > Run) untuk memunculkan layar izin Google yang lengkap. */
function izinkan() {
  var nama = SpreadsheetApp.getActiveSpreadsheet().getName();
  MailApp.getRemainingDailyQuota();
  Logger.log('Izin lengkap untuk: ' + nama);
}
