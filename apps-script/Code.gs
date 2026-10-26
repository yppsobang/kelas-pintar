/**
 * KELAS PINTAR v2 - Backend API (Google Apps Script, terikat ke Google Sheet)
 * Frontend dihosting terpisah (Netlify) dan memanggil web app ini lewat fetch (JSON).
 *
 * Penyimpanan:
 *  - Database  : Google Sheet (tab Users, Mapel, Posts, Subs, QA, Kelas)
 *  - File      : Google Drive, folder "KelasPintar" (dibuat otomatis oleh setup())
 *  - Rahasia   : Script Properties (secret token, pepper password, API key Gemini)
 */
const TZ = 'Asia/Jakarta';
const PROP = PropertiesService.getScriptProperties();
const DEF_MODEL = 'gemini-flash-lite-latest'; // ringan & cepat; pilihan lain ada di menu Akun
const TIPE = ['materi', 'tugas', 'kuis', 'lkpd', 'pengumuman'];
const NILAI = ['kuis', 'tugas', 'lkpd'];
const MAX_DOC = 8e6;        // lampiran PDF/foto/dokumen (byte)
const MAX_VID = 5e8;        // video (byte), diunggah langsung browser -> Drive
const MAX_HTML = 8e6;       // file HTML interaktif (materi dari guru / pekerjaan siswa), byte
const TOKEN_TTL = 24 * 3600 * 1000;
const SCHEMA = {
  Users: ['id', 'role', 'username', 'nama', 'pass', 'nisn', 'lahir', 'kelas', 'model'],
  Mapel: ['id', 'nama', 'guru', 'kelas'],
  Posts: ['id', 'mapel', 'tipe', 'judul', 'isi', 'link', 'file', 'soal', 'mode', 'dibuat', 'kelas', 'fmt'],
  Subs: ['id', 'post', 'siswa', 'jawab', 'nilai', 'waktu', 'file', 'catatan'],
  QA: ['id', 'mapel', 'siswa', 'tanya', 'jawab', 'waktu'],
  Kelas: ['id', 'nama']
};
const SMALL = ['Users', 'Mapel', 'Kelas']; // tabel kecil: di-cache lintas request
const G = ['guru', 'admin'];
let M = {};                                  // memo per eksekusi

/* =====================  SETUP (jalankan SEKALI dari editor)  ===================== */
function setup() {
  const ss = SpreadsheetApp.getActive();
  PROP.setProperty('SS', ss.getId());
  M = { ss };
  pepper_(); secret_();
  Object.keys(SCHEMA).forEach(n => {
    let t = ss.getSheetByName(n);
    if (!t) {
      t = ss.insertSheet(n);
      t.getRange(1, 1, 1, SCHEMA[n].length).setValues([SCHEMA[n]]);
      t.setFrozenRows(1);
    } else { // sheet lama: tambahkan kolom yang belum ada, data tetap aman
      const h = t.getRange(1, 1, 1, Math.max(1, t.getLastColumn())).getValues()[0].map(String);
      SCHEMA[n].forEach(k => { if (h.indexOf(k) < 0) { t.getRange(1, h.length + 1).setValue(k); h.push(k); } });
    }
    cdel_('db_' + n);
  });
  M = { ss };
  rootF_(); upF_(); vidF_(); subF_();
  // migrasi dari versi lama: API key dipindah dari sheet ke Script Properties
  const hu = hdr_('Users'), ix = hu.indexOf('apikey');
  if (ix >= 0) all_('Users').forEach(u => { if (u.apikey) { PROP.setProperty('gk_' + u.id, u.apikey); tab_('Users').getRange(u._r, ix + 1).setValue(''); } });
  M = { ss };
  // isi tabel Kelas dari data lama (jika ada)
  const have = new Set(all_('Kelas').map(k => k.nama.toLowerCase()));
  const addK = nm => { if (nm && !have.has(nm.toLowerCase())) { add_('Kelas', { nama: nm }); have.add(nm.toLowerCase()); } };
  all_('Users').filter(u => u.role === 'siswa').forEach(u => addK(u.kelas));
  all_('Mapel').forEach(m => kls_(m).forEach(addK));
  M = { ss };
  let msg = 'Setup selesai. Folder Drive: ' + rootF_().getUrl();
  if (!all_('Users').some(u => u.role === 'admin')) {
    const pw = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    add_('Users', { role: 'admin', username: 'admin', nama: 'Administrator', pass: hp_(pw) });
    msg += '\nAKUN ADMIN  username: admin  password: ' + pw + '  (segera ganti di menu Akun)';
  }
  Logger.log(msg); return msg;
}
// Lupa password admin? Jalankan fungsi ini dari editor, lihat password baru di log.
function resetAdminPassword() {
  M = {};
  const a = all_('Users').find(u => u.role === 'admin'); if (!a) throw new Error('Belum ada admin, jalankan setup()');
  const pw = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  upd_('Users', a, { pass: hp_(pw) });
  Logger.log('Admin "' + a.username + '" password baru: ' + pw); return pw;
}
// Paksa semua pengguna login ulang (mis. jika token bocor)
function cabutSemuaSesi() { PROP.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid()); }

/* =====================  ENTRY POINT  ===================== */
function doGet() { return json_({ ok: 1, d: { app: 'Kelas Pintar API', v: 2 } }); }
function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    out = { ok: 1, d: handle_(req) };
  } catch (err) {
    out = { ok: 0, e: String((err && err.message) || err).replace(/^Exception: /, '') };
  }
  return json_(out);
}
const json_ = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

function handle_(req) {
  const act = String(req.act || ''), p = req.p || {};
  if (act === 'login') return login_(p);
  const me = auth_(req.tok);
  const h = ACT[act]; if (!h) throw new Error('Aksi tidak dikenal');
  if (h[0] && h[0].indexOf(me.role) < 0) throw new Error('Tidak diizinkan');
  return h[1] ? locked_(() => h[2](me, p)) : h[2](me, p);
}
function locked_(f) {
  const L = LockService.getScriptLock();
  try { L.waitLock(30000); } catch (e) { throw new Error('Server sedang sibuk, coba lagi sebentar lagi.'); }
  try {
    Object.keys(M).forEach(k => { if (k !== 'ss') delete M[k]; });
    M.fresh = true; // di dalam lock: selalu baca data terbaru, lewati cache
    return f();
  } finally { L.releaseLock(); }
}

/* =====================  DATA LAYER  ===================== */
function ss_() {
  if (!M.ss) { const id = PROP.getProperty('SS'); M.ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive(); }
  return M.ss;
}
const tab_ = n => ss_().getSheetByName(n);
const uid_ = () => Utilities.getUuid().replace(/-/g, '').slice(0, 10);
const now_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');

// cache bertingkat (CacheService maks 100 KB/item -> dipecah)
function cget_(key) {
  const c = CacheService.getScriptCache(), n = Number(c.get(key + '#n') || 0); if (!n) return null;
  const ks = []; for (let i = 0; i < n; i++) ks.push(key + '#' + i);
  const o = c.getAll(ks), parts = ks.map(k => o[k]); if (parts.some(x => x == null)) return null;
  try { return JSON.parse(parts.join('')); } catch (e) { return null; }
}
function cput_(key, val, ttl) {
  const s = JSON.stringify(val), o = {}; let n = 0;
  for (let i = 0; i < s.length; i += 30000) o[key + '#' + (n++)] = s.slice(i, i + 30000);
  if (n > 20) return; // terlalu besar, lewati cache
  o[key + '#n'] = String(n);
  try { CacheService.getScriptCache().putAll(o, ttl); } catch (e) {}
}
function cdel_(key) {
  const ks = [key + '#n']; for (let i = 0; i < 20; i++) ks.push(key + '#' + i);
  CacheService.getScriptCache().removeAll(ks);
}
function inval_(n) { delete M[n]; if (SMALL.indexOf(n) >= 0) cdel_('db_' + n); }

function hdr_(n) {
  if (!M['h' + n]) {
    const t = tab_(n), h = t.getRange(1, 1, 1, t.getLastColumn()).getValues()[0].map(String);
    (SCHEMA[n] || []).forEach(k => { if (h.indexOf(k) < 0) { t.getRange(1, h.length + 1).setValue(k); h.push(k); } }); // kolom baru ditambah otomatis
    M['h' + n] = h;
  }
  return M['h' + n];
}
function all_(n) {
  if (M[n]) return M[n];
  const small = SMALL.indexOf(n) >= 0;
  if (small && !M.fresh) { const c = cget_('db_' + n); if (c) return (M[n] = c); }
  const v = tab_(n).getDataRange().getValues(), h = v.shift().map(String);
  const out = [];
  v.forEach((r, i) => {
    const o = { _r: i + 2 };
    h.forEach((k, j) => { const x = r[j]; o[k] = x instanceof Date ? Utilities.formatDate(x, TZ, 'yyyy-MM-dd') : String(x); });
    if (o.id) out.push(o);
  });
  M[n] = out;
  if (small && !M.fresh) cput_('db_' + n, out, 600);
  return out;
}
function addMany_(n, list) {
  if (!list.length) return;
  const t = tab_(n), h = hdr_(n), start = t.getLastRow() + 1, end = start + list.length - 1;
  if (end > t.getMaxRows()) t.insertRowsAfter(t.getMaxRows(), Math.max(200, end - t.getMaxRows()));
  list.forEach(o => { o.id = o.id || uid_(); });
  const g = t.getRange(start, 1, list.length, h.length);
  g.setNumberFormat('@'); // semua teks (NISN, tanggal tidak berubah format)
  g.setValues(list.map(o => h.map(k => o[k] == null ? '' : String(o[k]))));
  inval_(n);
}
function add_(n, o) { addMany_(n, [o]); return o; }
function upd_(n, r, o) {
  const h = hdr_(n), g = tab_(n).getRange(r._r, 1, 1, h.length), cur = g.getValues()[0];
  g.setValues([h.map((k, i) => k in o ? String(o[k]) : cur[i])]);
  inval_(n);
}
function del_(n, list) { // hapus banyak baris sekaligus (dikelompokkan per blok)
  if (!list.length) return;
  const rs = list.map(x => x._r).sort((a, b) => b - a), t = tab_(n);
  let i = 0;
  while (i < rs.length) {
    let j = i; while (j + 1 < rs.length && rs[j + 1] === rs[j] - 1) j++;
    t.deleteRows(rs[j], j - i + 1); i = j + 1;
  }
  inval_(n);
}
const usr_ = id => all_('Users').find(x => x.id === id);
const kls_ = m => String(m.kelas || '').split(',').map(s => s.trim()).filter(Boolean);
const kmap_ = () => { const o = {}; all_('Kelas').forEach(k => o[k.nama.toLowerCase()] = k.nama); return o; };
function nd_(s) { // normalisasi tanggal -> yyyy-mm-dd
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}
function visMapel_(me) {
  const L = all_('Mapel');
  if (me.role === 'admin') return L;
  if (me.role === 'guru') return L.filter(m => m.guru === me.id);
  return L.filter(m => kls_(m).indexOf(me.kelas) >= 0);
}
function ownMapel_(me, id) {
  const m = all_('Mapel').find(x => x.id === id);
  if (!m || (me.role !== 'admin' && m.guru !== me.id)) throw new Error('Mapel tidak ditemukan / bukan milik Anda');
  return m;
}
const pk_ = x => String(x.kelas || '').split(',').map(s => s.trim()).filter(Boolean);       // kelas tujuan postingan (kosong = semua kelas mapel)
const canSee_ = (me, x) => me.role !== 'siswa' || !pk_(x).length || pk_(x).indexOf(me.kelas) >= 0;
function pickKelas_(m, raw) { // validasi pilihan kelas postingan; semua kelas terpilih disimpan kosong
  if (raw == null) return ''; // klien lama tanpa pilihan kelas = semua kelas mapel
  const mk = kls_(m), a = [...new Set((Array.isArray(raw) ? raw : []).map(x => String(x).trim()).filter(x => mk.indexOf(x) >= 0))];
  if (!a.length) throw new Error('Pilih minimal satu kelas tujuan postingan');
  return a.length === mk.length ? '' : a.join(',');
}
const avg_ = a => { const v = a.filter(x => x !== '').map(Number); return v.length ? Math.round(v.reduce((x, y) => x + y) / v.length) : ''; };

/* =====================  KEAMANAN  ===================== */
function secret_() { let s = PROP.getProperty('SECRET'); if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); PROP.setProperty('SECRET', s); } return s; }
function pepper_() { let s = PROP.getProperty('PEPPER'); if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); PROP.setProperty('PEPPER', s); } return s; }
const hex_ = b => b.map(x => ('0' + (x & 255).toString(16)).slice(-2)).join('');
function hp_(pw, salt) { // password: HMAC-SHA256 + salt unik per akun + pepper server
  salt = salt || uid_() + uid_();
  return salt + '$' + hex_(Utilities.computeHmacSha256Signature(salt + ':' + pw, pepper_()));
}
function chk_(pw, stored) {
  stored = String(stored || ''); if (!stored) return false;
  if (stored.indexOf('$') < 0) // hash versi lama (SHA-256 'kp:'+pw)
    return stored === hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'kp:' + pw));
  return hp_(pw, stored.split('$')[0]) === stored;
}
function mk_(id) {
  const b = Utilities.base64EncodeWebSafe(JSON.stringify({ i: id, e: Date.now() + TOKEN_TTL }));
  return b + '.' + Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(b, secret_()));
}
function auth_(tok) {
  const a = String(tok || '').split('.'); if (a.length !== 2) throw new Error('AUTH');
  if (Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(a[0], secret_())) !== a[1]) throw new Error('AUTH');
  let d; try { d = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(a[0])).getDataAsString()); } catch (e) { throw new Error('AUTH'); }
  if (!d || !(d.e > Date.now())) throw new Error('AUTH');
  const me = usr_(d.i); if (!me) throw new Error('AUTH');
  return me;
}
function login_(d) {
  const c = CacheService.getScriptCache();
  const key = 'lf_' + (d.siswa ? 'n' + String(d.nisn || '').trim() : 'u' + String(d.username || '').trim().toLowerCase());
  const fails = Number(c.get(key) || 0);
  if (fails >= 6) throw new Error('Terlalu banyak percobaan gagal. Coba lagi 10 menit lagi.');
  const U = all_('Users'); let u;
  if (d.siswa) u = U.find(x => x.role === 'siswa' && x.nisn === String(d.nisn || '').trim() && x.lahir === nd_(d.lahir));
  else {
    u = U.find(x => x.role !== 'siswa' && x.username === String(d.username || '').trim());
    if (u && !chk_(String(d.pass || ''), u.pass)) u = null;
  }
  if (!u) { c.put(key, String(fails + 1), 600); throw new Error('Data login tidak cocok'); }
  c.remove(key);
  if (!d.siswa && u.pass.indexOf('$') < 0) // naikkan hash lama ke format baru
    locked_(() => { const f = usr_(u.id); if (f) upd_('Users', f, { pass: hp_(String(d.pass)) }); });
  return { token: mk_(u.id), user: pub_(u) };
}
const props_ = () => M.props || (M.props = PROP.getProperties());
const cfg_ = k => props_()['C_' + k] || '';
const model_ = u => (u.model && u.model !== 'gemini-2.5-flash') ? u.model : DEF_MODEL;
const pub_ = u => ({ id: u.id, role: u.role, nama: u.nama, kelas: u.kelas, hasKey: !!(props_()['gk_' + u.id] || props_().GK), model: model_(u), sekolah: cfg_('sekolah') });

/* =====================  DRIVE  ===================== */
function folder_(key, name, parent) {
  const id = PROP.getProperty(key);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = (parent || DriveApp.getRootFolder()).createFolder(name); PROP.setProperty(key, f.getId()); M.props = null; return f;
}
const akun_ = () => { try { return Session.getEffectiveUser().getEmail(); } catch (e) { return ''; } };
const rootF_ = () => folder_('F_ROOT', 'KelasPintar');
const upF_ = () => folder_('F_UP', 'Lampiran Materi', rootF_());
const vidF_ = () => folder_('F_VID', 'Video', rootF_());
const subF_ = () => folder_('F_SUB', 'Pengumpulan Siswa', rootF_());
const ownIds_ = () => M.own || (M.own = [upF_(), vidF_(), subF_()].map(f => f.getId()));
function inOwn_(f) {
  const own = ownIds_(), it = f.getParents();
  while (it.hasNext()) if (own.indexOf(it.next().getId()) >= 0) return true;
  return false;
}
function inFolder_(f, fid) { const it = f.getParents(); while (it.hasNext()) if (it.next().getId() === fid) return true; return false; }
const MIME_OK = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|application\/msword|application\/vnd\.(openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation|spreadsheetml\.sheet)|ms-excel|ms-powerpoint)|text\/plain)$/;
function saveFile_(folder, f, label) { // base64 dari browser -> file Drive, kembalikan "id|nama"
  if (!f || !f.b64) return '';
  if (String(f.b64).length > MAX_DOC * 1.4) throw new Error('File maks 8 MB');
  const mime = String(f.mime || '');
  if (!MIME_OK.test(mime)) throw new Error('Jenis file tidak diizinkan (boleh: PDF, foto, Word/Excel/PowerPoint, teks)');
  const name = String(f.name || 'file').replace(/[\\\/|]/g, '-').slice(0, 120);
  const b = Utilities.newBlob(Utilities.base64Decode(f.b64), mime, (label ? label + ' - ' : '') + name);
  if (b.getBytes().length > MAX_DOC) throw new Error('File maks 8 MB');
  const x = folder.createFile(b);
  x.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return x.getId() + '|' + name;
}
// Nama berkas pekerjaan siswa: Nama_Materi.html (tanpa spasi/tanda baca; harus sama dengan hname() di app.js)
function hname_(nama, judul) {
  const sl = (s, n) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, n).replace(/_+$/, '');
  return (sl(nama, 40) || 'Siswa') + '_' + (sl(judul, 60) || 'Materi') + '.html';
}
// File HTML interaktif: disimpan PRIVAT di Drive (tanpa tautan publik). Siswa/guru membukanya lewat API (htmlGet), bukan lewat Drive.
function saveHtml_(folder, f, name) {
  if (!f || !f.b64) throw new Error('File HTML kosong');
  if (String(f.b64).length > MAX_HTML * 1.4) throw new Error('File HTML maks 8 MB');
  const bytes = Utilities.base64Decode(f.b64);
  if (bytes.length > MAX_HTML) throw new Error('File HTML maks 8 MB');
  name = String(name || f.name || 'materi.html').replace(/[\\\/|]/g, '-').slice(0, 120);
  if (!/\.html?$/i.test(name)) name += '.html';
  const head = Utilities.newBlob(bytes.slice(0, 4000)).getDataAsString('UTF-8');
  if (!/<\s*(!doctype|html|head|body|div|p|h1|section|script|style)\b/i.test(head)) throw new Error('Isi file bukan HTML yang valid (gunakan file .html berformat UTF-8)');
  const x = folder.createFile(Utilities.newBlob(bytes, 'text/html', name));
  return x.getId() + '|' + name;
}
function readHtml_(ref) { // ref = "id|nama"
  const a = String(ref || '').split('|'), id = a[0];
  if (!/^[\w-]{10,}$/.test(id)) throw new Error('File HTML tidak ditemukan');
  let f; try { f = DriveApp.getFileById(id); } catch (e) { throw new Error('File HTML tidak ditemukan di Drive (mungkin sudah dihapus)'); }
  if (!/^text\/html/.test(f.getMimeType())) throw new Error('Berkas ini bukan file HTML');
  if (f.getSize() > MAX_HTML * 1.05) throw new Error('File HTML terlalu besar');
  return { name: a[1] || f.getName(), html: f.getBlob().getDataAsString('UTF-8') };
}
const cleanStat_ = s => { // ringkasan isian dari file siswa (hanya saran untuk guru; angka dibatasi)
  const n = x => Math.max(0, Math.min(999, Math.round(Number(x)) || 0)), o = {};
  if (!s || typeof s !== 'object') return o;
  if (s.q) o.q = { t: n(s.q.t), d: n(s.q.d), r: n(s.q.r) };   // kuis di dalam file: jumlah, terjawab, benar
  if (s.f) o.f = { t: n(s.f.t), f: n(s.f.f) };                 // kolom isian: jumlah, terisi
  if (s.c) o.c = { t: n(s.c.t), c: n(s.c.c) };                 // ceklis: jumlah, tercentang
  return o;
};
function trashOwn_(s) { // hanya membuang file yang dibuat aplikasi ini
  const id = String(s || '').split('|')[0]; if (!id) return;
  try { const f = DriveApp.getFileById(id); if (inOwn_(f)) f.setTrashed(true); } catch (e) {}
}
function fid_(s) {
  s = String(s || '').trim(); if (!s) return '';
  const m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : (/^[\w-]{10,}$/.test(s) ? s : '');
}
function bukuList_(fresh) {
  const id = cfg_('buku'); if (!id) return { need: 1, list: [] };
  const c = CacheService.getScriptCache(), ck = 'buku_' + id;
  if (fresh) c.remove(ck); else { const k = c.get(ck); if (k) return JSON.parse(k); }
  const out = [], F = DriveApp.getFolderById(id);
  const grab = (f, nama) => {
    const a = [], it = f.getFiles();
    while (it.hasNext()) { const x = it.next(); a.push({ n: x.getName(), id: x.getId() }); }
    a.sort((x, y) => x.n.localeCompare(y.n, 'id', { numeric: true }));
    if (a.length) out.push({ f: nama, a });
  };
  grab(F, 'Buku Paket');
  const s = F.getFolders(); while (s.hasNext()) { const g = s.next(); grab(g, g.getName()); }
  const r = { need: 0, list: out };
  try { c.put(ck, JSON.stringify(r), 600); } catch (e) {}
  return r;
}

/* =====================  POSTING  ===================== */
function pubPost(p, me, mine) {
  const o = Object.assign({}, p); delete o._r;
  o.soal = p.soal ? JSON.parse(p.soal) : [];
  if (me.role === 'siswa') { o.soal = o.soal.map(q => ({ t: q.t, q: q.q, o: q.o })); o.mine = mine || null; } // kunci tidak dikirim ke siswa
  return o;
}
function cleanSoal_(raw) {
  const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
  const soal = arr.map(q => q.t === 'pg'
    ? { t: 'pg', q: String(q.q || '').trim(), o: (q.o || []).slice(0, 4).map(x => String(x).trim()), k: Number(q.k) || 0 }
    : { t: 'uraian', q: String(q.q || '').trim(), k: String(q.k || '') });
  if (soal.some(q => !q.q || (q.t === 'pg' && (q.o.length < 2 || q.o.some(x => !x))))) throw new Error('Ada soal/opsi yang masih kosong');
  if (JSON.stringify(soal).length > 45000) throw new Error('Soal terlalu banyak untuk satu postingan (batas ±45.000 karakter). Pecah menjadi dua postingan.');
  return soal;
}
function rmSubs_(pred) { // hapus pengumpulan + lampirannya
  const list = all_('Subs').filter(pred);
  list.forEach(s => trashOwn_(s.file));
  del_('Subs', list);
}

const ACT = {
  me: [null, 0, me => pub_(me)],
  pass: [G, 1, (me, p) => {
    const u = usr_(me.id);
    if (String(p.pass || '').length < 6) throw new Error('Password minimal 6 karakter');
    if (!chk_(String(p.old || ''), u.pass)) throw new Error('Password lama salah');
    upd_('Users', u, { pass: hp_(String(p.pass)) }); return 1;
  }],
  saveKey: [G, 1, (me, p) => {
    if (p.clear) PROP.deleteProperty('gk_' + me.id);
    else if (p.key) PROP.setProperty('gk_' + me.id, String(p.key).trim());
    upd_('Users', usr_(me.id), { model: String(p.model || DEF_MODEL).trim() });
    M.props = null; return 1;
  }],

  /* ---- pengaturan (admin) ---- */
  cfgGet: [['admin'], 0, () => ({
    sekolah: cfg_('sekolah'), buku: cfg_('buku'), hasGlobalKey: !!props_().GK,
    root: rootF_().getUrl(), up: upF_().getUrl(), vid: vidF_().getUrl(), sub: subF_().getUrl(),
    upId: upF_().getId(), vidId: vidF_().getId(), subId: subF_().getId(), akun: akun_()
  })],
  cfgSet: [['admin'], 1, (me, p) => {
    if ('sekolah' in p) PROP.setProperty('C_sekolah', String(p.sekolah || '').trim().slice(0, 80));
    if ('buku' in p) {
      const raw = String(p.buku || '').trim();
      if (!raw) PROP.deleteProperty('C_buku');
      else {
        const id = fid_(raw); if (!id) throw new Error('Tautan folder Drive tidak valid');
        try { DriveApp.getFolderById(id).getName(); } catch (e) { throw new Error('Folder tidak bisa dibuka oleh akun pemilik script. Pastikan folder milik akun ini atau dibagikan ke akun ini.'); }
        PROP.setProperty('C_buku', id);
      }
    }
    const FK = [['fup', 'F_UP', 'Lampiran Materi'], ['fvid', 'F_VID', 'Video'], ['fsub', 'F_SUB', 'Pengumpulan Siswa']], ganti = [];
    FK.forEach(k => { // validasi semua dulu, simpan hanya jika semuanya benar
      const raw = String(p[k[0]] || '').trim(); if (!raw) return;
      const id = fid_(raw); if (!id) throw new Error('Tautan/ID folder ' + k[2] + ' tidak valid');
      let f; try { f = DriveApp.getFolderById(id); f.getName(); } catch (e) { throw new Error('Folder ' + k[2] + ' tidak bisa dibuka. Bagikan folder ke akun ' + (akun_() || 'pemilik script') + ' sebagai Editor.'); }
      try { f.createFile('tes-akses.txt', 'ok').setTrashed(true); } catch (e) { throw new Error('Folder ' + k[2] + ' hanya bisa dibaca. Ubah akses akun ' + (akun_() || 'pemilik script') + ' menjadi Editor.'); }
      ganti.push([k[1], id]);
    });
    ganti.forEach(g => PROP.setProperty(g[0], g[1]));
    if (p.gkey) PROP.setProperty('GK', String(p.gkey).trim());
    if (p.gclear) PROP.deleteProperty('GK');
    M.props = null; return 1;
  }],

  /* ---- admin: pengguna ---- */
  users: [['admin'], 0, (me, p) => {
    const q = String(p.q || '').toLowerCase(), k = String(p.kelas || '');
    const l = all_('Users').filter(u => (k === '' || (k === '__staf' ? u.role !== 'siswa' : u.kelas === k)) && (u.nama + ' ' + u.nisn + ' ' + u.username).toLowerCase().indexOf(q) >= 0);
    return { total: l.length, list: l.slice(0, 100).map(u => ({ id: u.id, role: u.role, username: u.username, nama: u.nama, nisn: u.nisn, lahir: u.lahir, kelas: u.kelas })) };
  }],
  guruList: [['admin'], 0, () => all_('Users').filter(u => u.role !== 'siswa').map(u => ({ id: u.id, nama: u.nama }))],
  userAdd: [['admin'], 1, (me, p) => {
    const U = all_('Users'), nama = String(p.nama || '').trim();
    if (p.role === 'siswa') {
      const nisn = String(p.nisn || '').trim(), l = nd_(p.lahir);
      if (!nisn || !nama || !l) throw new Error('NISN, nama, dan tanggal lahir wajib diisi');
      if (U.some(x => x.nisn === nisn)) throw new Error('NISN sudah terdaftar');
      const kc = kmap_()[String(p.kelas || '').trim().toLowerCase()];
      if (!kc) throw new Error('Pilih kelas yang sudah dibuat di menu Kelas');
      add_('Users', { role: 'siswa', nisn, lahir: l, nama, kelas: kc });
    } else {
      const un = String(p.username || '').trim();
      if (['guru', 'admin'].indexOf(p.role) < 0 || !un || !nama || String(p.pass || '').length < 6) throw new Error('Username, nama, password (min. 6) wajib');
      if (U.some(x => x.username === un)) throw new Error('Username sudah dipakai');
      add_('Users', { role: p.role, username: un, nama, pass: hp_(String(p.pass)) });
    }
    return 1;
  }],
  userBulk: [['admin'], 1, (me, p) => {
    const have = new Set(all_('Users').map(x => x.nisn)), out = [], err = [], KM = kmap_();
    const src = (p.rows || []).slice(0, 2000);
    src.forEach((r, i) => {
      const nisn = String(r[0] == null ? '' : r[0]).trim(), nama = String(r[1] || '').trim(), kelas = String(r[2] || '').trim(), l = nd_(r[3]);
      if (!nisn || !nama || !l) { err.push('Baris ' + (i + 1) + ': data tidak lengkap/tanggal tidak terbaca'); return; }
      if (have.has(nisn)) { err.push('Baris ' + (i + 1) + ': NISN ' + nisn + ' sudah ada'); return; }
      const kc = KM[kelas.toLowerCase()];
      if (!kc) { err.push('Baris ' + (i + 1) + ': kelas "' + kelas + '" belum dibuat di menu Kelas'); return; }
      have.add(nisn); out.push({ role: 'siswa', nisn, lahir: l, nama, kelas: kc });
    });
    addMany_('Users', out);
    return { ok: out.length, err };
  }],
  userDel: [['admin'], 1, (me, p) => {
    if (p.id === me.id) throw new Error('Tidak bisa menghapus akun sendiri');
    const u = usr_(p.id); if (!u) return 1;
    if (u.role !== 'siswa' && all_('Mapel').some(m => m.guru === u.id)) throw new Error('Guru ini masih mengampu mapel. Hapus/pindahkan mapelnya dulu.');
    if (u.role === 'siswa') { rmSubs_(s => s.siswa === u.id); del_('QA', all_('QA').filter(x => x.siswa === u.id)); }
    del_('Users', [u]); return 1;
  }],

  /* ---- kelas ---- */
  kelasList: [null, 0, () => all_('Kelas').map(k => k.nama).sort((a, b) => a.localeCompare(b, 'id', { numeric: true }))],
  kelasInfo: [['admin'], 0, () => {
    const c = {}; all_('Users').forEach(u => { if (u.role === 'siswa') c[u.kelas] = (c[u.kelas] || 0) + 1; });
    return all_('Kelas').map(k => ({ nama: k.nama, n: c[k.nama] || 0 })).sort((a, b) => a.nama.localeCompare(b.nama, 'id', { numeric: true }));
  }],
  kelasAdd: [['admin'], 1, (me, p) => {
    const KM = kmap_(), list = [];
    String(p.names || '').split(/[,\n;]+/).map(x => x.trim()).filter(Boolean).forEach(x => { if (!KM[x.toLowerCase()]) { list.push({ nama: x }); KM[x.toLowerCase()] = x; } });
    if (!list.length) throw new Error('Tidak ada kelas baru (kosong atau sudah ada)');
    addMany_('Kelas', list); return list.length;
  }],
  kelasDel: [['admin'], 1, (me, p) => {
    const k = all_('Kelas').find(x => x.nama === p.nama); if (!k) return 1;
    if (all_('Users').some(u => u.role === 'siswa' && u.kelas === k.nama)) throw new Error('Masih ada siswa di kelas ini');
    if (all_('Mapel').some(m => kls_(m).indexOf(k.nama) >= 0)) throw new Error('Kelas masih dipakai mapel');
    del_('Kelas', [k]); return 1;
  }],

  /* ---- beranda ---- */
  stat: [null, 0, me => {
    const Mp = visMapel_(me), ids = new Set(Mp.map(m => m.id)), P = all_('Posts').filter(x => ids.has(x.mapel) && canSee_(me, x));
    if (me.role === 'siswa') {
      const mine = all_('Subs').filter(x => x.siswa === me.id), done = new Set(mine.map(x => x.post));
      return { mapel: Mp.length, todo: P.filter(x => NILAI.indexOf(x.tipe) >= 0 && !done.has(x.id)).length, avg: (a => a === '' ? '-' : a)(avg_(mine.map(x => x.nilai))) };
    }
    if (me.role === 'guru') {
      const pid = new Set(P.map(x => x.id));
      return { mapel: Mp.length, post: P.length, nilai: all_('Subs').filter(x => pid.has(x.post) && x.nilai === '').length, tanya: all_('QA').filter(x => ids.has(x.mapel) && !x.jawab).length };
    }
    const U = all_('Users');
    return { siswa: U.filter(x => x.role === 'siswa').length, guru: U.filter(x => x.role === 'guru').length, kelas: all_('Kelas').length, mapel: Mp.length };
  }],
  feed: [null, 0, me => {
    const Mp = {}; visMapel_(me).forEach(m => Mp[m.id] = m.nama);
    return all_('Posts').filter(x => Mp[x.mapel] && canSee_(me, x)).reverse().slice(0, 30)
      .map(x => ({ id: x.id, mapel: x.mapel, mn: Mp[x.mapel], tipe: x.tipe, judul: x.judul, dibuat: x.dibuat }));
  }],

  /* ---- mapel ---- */
  mapelList: [null, 0, me => {
    const U = {}; all_('Users').forEach(u => U[u.id] = u.nama);
    return visMapel_(me).map(m => ({ id: m.id, nama: m.nama, kelas: m.kelas, gn: U[m.guru] || '-', g: m.guru }));
  }],
  mapelAdd: [G, 1, (me, p) => {
    const nama = String(p.nama || '').trim(), KM = kmap_();
    const ks = [...new Set((Array.isArray(p.kelas) ? p.kelas : []).map(x => KM[String(x).toLowerCase()]).filter(Boolean))];
    if (!nama || !ks.length) throw new Error('Nama mapel dan minimal satu kelas wajib');
    const guru = me.role === 'admin' ? p.guru : me.id;
    if (!all_('Users').some(u => u.id === guru && u.role !== 'siswa')) throw new Error('Guru pengampu tidak valid');
    add_('Mapel', { nama, kelas: ks.join(','), guru }); return 1;
  }],
  mapelDel: [G, 1, (me, p) => { // hapus mapel + postingan, pengumpulan, tanya jawab, dan file Drive-nya
    const m = ownMapel_(me, p.id), ps = all_('Posts').filter(x => x.mapel === m.id), pid = new Set(ps.map(x => x.id));
    rmSubs_(s => pid.has(s.post));
    del_('QA', all_('QA').filter(x => x.mapel === m.id));
    ps.forEach(x => trashOwn_(x.file));
    del_('Posts', ps); del_('Mapel', [m]); return 1;
  }],

  /* ---- postingan ---- */
  postList: [null, 0, (me, p) => {
    if (!visMapel_(me).some(m => m.id === p.mapel)) throw new Error('Tidak diizinkan');
    const S = {}; if (me.role === 'siswa') all_('Subs').filter(x => x.siswa === me.id).forEach(x => S[x.post] = { nilai: x.nilai, waktu: x.waktu, catatan: x.catatan || '' });
    return all_('Posts').filter(x => x.mapel === p.mapel && canSee_(me, x)).reverse().map(x => pubPost(x, me, S[x.id]));
  }],
  postAdd: [G, 1, (me, p) => {
    const m = ownMapel_(me, p.mapel), judul = String(p.judul || '').trim();
    if (TIPE.indexOf(p.tipe) < 0 || !judul) throw new Error('Jenis dan judul wajib diisi');
    if (p.link && !/^https?:\/\//i.test(p.link)) throw new Error('Tautan harus diawali http:// atau https://');
    const isHtml = !!(p.html && p.html.b64);
    if (isHtml && ['materi', 'tugas', 'lkpd'].indexOf(p.tipe) < 0) throw new Error('File HTML hanya untuk Materi, Tugas, atau LKPD');
    if (isHtml && (p.file || (p.vfile && p.vfile.id))) throw new Error('Pilih salah satu: file HTML, PDF/foto, atau video');
    const soal = NILAI.indexOf(p.tipe) >= 0 && !isHtml ? cleanSoal_(p.soal) : [];
    if (p.file && p.vfile && p.vfile.id) throw new Error('Pilih salah satu: file PDF/foto atau video');
    let file = '';
    if (isHtml) file = saveHtml_(upF_(), p.html);
    else if (p.file) file = saveFile_(upF_(), p.file);
    if (p.vfile && p.vfile.id) {
      const vid = String(p.vfile.id);
      if (!/^[\w-]{10,}$/.test(vid)) throw new Error('ID video tidak valid');
      if (!inFolder_(DriveApp.getFileById(vid), vidF_().getId())) throw new Error('Video tidak ditemukan di folder aplikasi');
      file = vid + '|' + String(p.vfile.name || 'video.mp4').replace(/\|/g, '-');
    }
    add_('Posts', { kelas: pickKelas_(m, p.kelas), mapel: m.id, tipe: p.tipe, judul, isi: String(p.isi || '').slice(0, 20000), link: p.link || '', file, fmt: isHtml ? 'html' : '', soal: JSON.stringify(soal), mode: p.tipe === 'lkpd' ? (p.mode === 'kelompok' ? 'kelompok' : 'individu') : '', dibuat: now_() });
    return 1;
  }],
  postEdit: [G, 1, (me, p) => { // ubah judul/isi/tautan tanpa menghapus & membuat ulang
    const x = all_('Posts').find(y => y.id === p.id); if (!x) throw new Error('Postingan tidak ditemukan');
    ownMapel_(me, x.mapel);
    const judul = String(p.judul || '').trim(); if (!judul) throw new Error('Judul wajib diisi');
    if (p.link && !/^https?:\/\//i.test(p.link)) throw new Error('Tautan harus diawali http:// atau https://');
    const o = { judul, isi: String(p.isi || '').slice(0, 20000), link: p.link || '' };
    if (Array.isArray(p.kelas)) o.kelas = pickKelas_(ownMapel_(me, x.mapel), p.kelas);
    if (p.html && p.html.b64) { // ganti file HTML (pengumpulan siswa yang sudah ada tidak berubah)
      if (x.fmt !== 'html') throw new Error('Postingan ini bukan postingan file HTML');
      o.file = saveHtml_(upF_(), p.html);
    }
    upd_('Posts', x, o);
    if (o.file) trashOwn_(x.file);
    return 1;
  }],
  vidInit: [G, 0, (me, p) => { // sesi unggah: browser mengirim video langsung ke Drive (tanpa lewat server)
    ownMapel_(me, p.mapel);
    if (Number(p.size) > MAX_VID) throw new Error('Video maks 500 MB');
    const tok = ScriptApp.getOAuthToken(), mime = String(p.mime || 'video/mp4');
    if (!/^video\//.test(mime)) throw new Error('File bukan video');
    const name = String(p.name || 'video.mp4').replace(/[\\\/|]/g, '-').slice(0, 150);
    const gi = JSON.parse(UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive', { headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true }).getContentText());
    const id = (gi.ids || [])[0]; if (!id) throw new Error('Gagal menyiapkan unggahan: ' + JSON.stringify(gi).slice(0, 200));
    const r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
      method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + tok, 'X-Upload-Content-Type': mime, Origin: String(p.origin || '') },
      payload: JSON.stringify({ id, name, mimeType: mime, parents: [vidF_().getId()] })
    });
    if (r.getResponseCode() !== 200) throw new Error('Drive ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
    const h = r.getAllHeaders(), url = h.Location || h.location;
    if (!url) throw new Error('Drive tidak memberi alamat unggahan');
    return { url, id, name };
  }],
  vidDone: [G, 0, (me, p) => { // buka akses "siapa saja dengan tautan" agar siswa bisa memutar
    const f = DriveApp.getFileById(String(p.id));
    if (!inFolder_(f, vidF_().getId())) throw new Error('Bukan file video aplikasi');
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); return 1;
  }],
  postDel: [G, 1, (me, p) => {
    const x = all_('Posts').find(y => y.id === p.id); if (!x) return 1;
    ownMapel_(me, x.mapel);
    rmSubs_(s => s.post === x.id); trashOwn_(x.file); del_('Posts', [x]); return 1;
  }],

  /* ---- pengumpulan & nilai ---- */
  submit: [['siswa'], 1, (me, p) => {
    const po = all_('Posts').find(x => x.id === p.post);
    if (!po || NILAI.indexOf(po.tipe) < 0 || !visMapel_(me).some(m => m.id === po.mapel) || !canSee_(me, po)) throw new Error('Tidak diizinkan');
    const old = all_('Subs').find(x => x.post === po.id && x.siswa === me.id);
    if (old && po.tipe === 'kuis') throw new Error('Kuis sudah dikerjakan');
    const so = po.soal ? JSON.parse(po.soal) : [], ans = (Array.isArray(p.ans) ? p.ans : []).map(a => String(a).slice(0, 3000));
    let nilai = '';
    if (po.tipe === 'kuis' && so.length && so.every(q => q.t === 'pg')) {
      let b = 0; so.forEach((q, i) => { if (String(ans[i]) === String(q.k)) b++; });
      nilai = String(Math.round(b / so.length * 100));
    }
    let file = old ? old.file : '', stat;
    if (po.fmt === 'html') { // pekerjaan = snapshot file HTML yang diisi siswa, disimpan sebagai Nama_Materi.html
      if (p.html && p.html.b64) { const nf = saveHtml_(subF_(), p.html, hname_(me.nama, po.judul)); if (old) trashOwn_(old.file); file = nf; stat = cleanStat_(p.stat); }
      else if (!old || !old.file) throw new Error('Pekerjaan belum ada. Buka file, kerjakan, lalu kirim.');
    } else if (p.file && po.tipe !== 'kuis') { const nf = saveFile_(subF_(), p.file, me.nama); if (old) trashOwn_(old.file); file = nf; }
    const jw = { ans, teks: String(p.teks || '').slice(0, 15000), anggota: String(p.anggota || '').slice(0, 500) };
    if (stat) jw.stat = stat;
    else if (po.fmt === 'html' && old) { try { const oj = JSON.parse(old.jawab || '{}'); if (oj.stat) jw.stat = oj.stat; } catch (e) {} }
    const o = { post: po.id, siswa: me.id, jawab: JSON.stringify(jw), nilai, waktu: now_(), file, catatan: '' };
    if (old) upd_('Subs', old, o); else add_('Subs', o);
    return { nilai, name: po.fmt === 'html' ? hname_(me.nama, po.judul) : '' };
  }],
  subs: [G, 0, (me, p) => {
    const po = all_('Posts').find(x => x.id === p.post); if (!po) throw new Error('Tidak ditemukan');
    ownMapel_(me, po.mapel);
    const U = {}; all_('Users').forEach(u => U[u.id] = u);
    return all_('Subs').filter(x => x.post === po.id).map(x => ({ id: x.id, nama: (U[x.siswa] || {}).nama, kelas: (U[x.siswa] || {}).kelas, jawab: x.jawab, nilai: x.nilai, waktu: x.waktu, file: x.file, catatan: x.catatan || '' }));
  }],
  nilaiSub: [G, 1, (me, p) => {
    const s = all_('Subs').find(x => x.id === p.id); if (!s) throw new Error('Tidak ditemukan');
    const po = all_('Posts').find(x => x.id === s.post); if (!po) throw new Error('Postingan sudah dihapus');
    ownMapel_(me, po.mapel);
    const n = Number(p.nilai); if (p.nilai !== '' && !(n >= 0 && n <= 100)) throw new Error('Nilai 0-100');
    const o = { nilai: p.nilai === '' ? '' : String(n) };
    if ('catatan' in p) o.catatan = String(p.catatan || '').trim().slice(0, 1000);
    upd_('Subs', s, o); return 1;
  }],
  // daftar pengumpulan satu postingan + siswa yang belum mengumpulkan (untuk layar penilaian file HTML)
  subsHtml: [G, 0, (me, p) => {
    const po = all_('Posts').find(x => x.id === p.post); if (!po) throw new Error('Tidak ditemukan');
    const m = ownMapel_(me, po.mapel), U = {}; all_('Users').forEach(u => U[u.id] = u);
    const kt = pk_(po).length ? pk_(po) : kls_(m), by = {};
    const list = all_('Subs').filter(x => x.post === po.id).map(x => { by[x.siswa] = 1; const u = U[x.siswa] || {}; return { id: x.id, nama: u.nama || '(siswa dihapus)', kelas: u.kelas || '', jawab: x.jawab, nilai: x.nilai, waktu: x.waktu, file: x.file, catatan: x.catatan || '' }; });
    list.sort((a, b) => (a.kelas + a.nama).localeCompare(b.kelas + b.nama, 'id'));
    const belum = all_('Users').filter(u => u.role === 'siswa' && kt.indexOf(u.kelas) >= 0 && !by[u.id]).sort((a, b) => (a.kelas + a.nama).localeCompare(b.kelas + b.nama, 'id')).map(u => ({ nama: u.nama, kelas: u.kelas }));
    return { post: { id: po.id, judul: po.judul, tipe: po.tipe, mode: po.mode }, list, belum };
  }],
  // isi file HTML: asli milik postingan (semua yang berhak melihat), atau pekerjaan siswa (guru pemilik mapel / siswa itu sendiri)
  htmlGet: [null, 0, (me, p) => {
    if (p.sub) {
      const s = all_('Subs').find(x => x.id === p.sub); if (!s) throw new Error('Pengumpulan tidak ditemukan');
      const po = all_('Posts').find(x => x.id === s.post); if (!po) throw new Error('Postingan sudah dihapus');
      if (me.role === 'siswa') { if (s.siswa !== me.id) throw new Error('Tidak diizinkan'); } else ownMapel_(me, po.mapel);
      return readHtml_(s.file);
    }
    const po = all_('Posts').find(x => x.id === p.post); if (!po) throw new Error('Postingan tidak ditemukan');
    if (!visMapel_(me).some(m => m.id === po.mapel) || !canSee_(me, po)) throw new Error('Tidak diizinkan');
    if (po.fmt !== 'html') throw new Error('Postingan ini bukan file HTML');
    if (p.mine) { // pekerjaan milik siswa yang sedang login
      const s = all_('Subs').find(x => x.post === po.id && x.siswa === me.id);
      if (!s || !s.file) throw new Error('Kamu belum mengirim pekerjaan untuk tugas ini');
      return readHtml_(s.file);
    }
    return readHtml_(po.file);
  }],
  rekap: [G, 0, (me, p) => {
    const m = ownMapel_(me, p.mapel), P = all_('Posts').filter(x => x.mapel === m.id && NILAI.indexOf(x.tipe) >= 0), K = kls_(m);
    const idx = {}; all_('Subs').forEach(b => idx[b.post + '|' + b.siswa] = b.nilai);
    const S = all_('Users').filter(u => u.role === 'siswa' && K.indexOf(u.kelas) >= 0).sort((a, b) => (a.kelas + a.nama).localeCompare(b.kelas + b.nama));
    return { kolom: P.map(x => x.judul), baris: S.map(s => { const n = P.map(x => idx[x.id + '|' + s.id] || ''); return { nama: s.nama, kelas: s.kelas, n, avg: avg_(n) }; }) };
  }],

  /* ---- tanya jawab ---- */
  tanya: [['siswa'], 1, (me, p) => {
    const t = String(p.t || '').trim().slice(0, 3000);
    if (!t || !visMapel_(me).some(m => m.id === p.mapel)) throw new Error('Data tidak valid');
    add_('QA', { mapel: p.mapel, siswa: me.id, tanya: t, waktu: now_() }); return 1;
  }],
  qaList: [null, 0, (me, p) => {
    if (!visMapel_(me).some(m => m.id === p.mapel)) throw new Error('Tidak diizinkan');
    const U = {}; all_('Users').forEach(u => U[u.id] = u.nama);
    return all_('QA').filter(x => x.mapel === p.mapel && (me.role !== 'siswa' || x.siswa === me.id)).reverse()
      .map(x => ({ id: x.id, nama: U[x.siswa], tanya: x.tanya, jawab: x.jawab, waktu: x.waktu }));
  }],
  qaDel: [G, 1, (me, p) => { // hapus satu pertanyaan beserta jawabannya
    const q = all_('QA').find(x => x.id === p.id); if (!q) return 1;
    ownMapel_(me, q.mapel); del_('QA', [q]); return 1;
  }],
  qaClear: [G, 1, (me, p) => { // kosongkan seluruh tanya jawab satu mapel
    const m = ownMapel_(me, p.mapel), l = all_('QA').filter(x => x.mapel === m.id);
    del_('QA', l); return l.length;
  }],
  jawab: [G, 1, (me, p) => {
    const q = all_('QA').find(x => x.id === p.id); if (!q) throw new Error('Tidak ditemukan');
    ownMapel_(me, q.mapel); upd_('QA', q, { jawab: String(p.t || '').trim().slice(0, 3000) }); return 1;
  }],

  /* ---- buku paket (folder Drive diatur admin di menu Pengaturan) ---- */
  buku: [null, 0, (me, p) => bukuList_(false)],
  bukuFresh: [null, 0, () => bukuList_(true)],

  /* ---- generate soal AI (Gemini) ---- */
  gen: [G, 0, (me, p) => {
    const key = props_()['gk_' + me.id] || props_().GK;
    if (!key) throw new Error('Isi API key Gemini dulu di menu Akun (atau minta admin mengisi di Pengaturan)');
    const pg = Math.max(0, Math.min(20, Number(p.pg) || 0)), ur = Math.max(0, Math.min(10, Number(p.uraian) || 0));
    if (!pg && !ur) throw new Error('Jumlah soal 0');
    const head = 'Kamu pembuat soal SMP sesuai Kurikulum Merdeka dan BSKAP terbaru (Capaian Pembelajaran Fase D). ' +
      'Mapel: ' + String(p.mapel || '').slice(0, 100) + '. Kelas: ' + String(p.kelas || '').slice(0, 30) + '. Topik/Tujuan Pembelajaran: ' + String(p.topik || '').slice(0, 500) + '. ';
    const tail = ' Bahasa Indonesia baku, jelas, hanya satu jawaban benar. Balas HANYA JSON array tanpa teks lain: ' +
      '[{"t":"pg","q":"...","o":["..","..","..",".."],"k":0},{"t":"uraian","q":"...","k":"..."}] ("k" pada pg = indeks kunci 0-3, pada uraian = pedoman skor singkat).';
    // Pecah jadi beberapa permintaan kecil yang dijalankan PARALEL (jauh lebih cepat daripada satu permintaan besar)
    const parts = [];
    if (pg + ur <= 6) parts.push({ pg, ur });
    else {
      const n = Math.ceil(pg / 5);
      for (let i = 0; i < n; i++) parts.push({ pg: Math.floor(pg / n) + (i < pg % n ? 1 : 0), ur: 0 });
      if (ur) parts.push({ pg: 0, ur });
    }
    const FOK = ['pemahaman konsep dasar dan istilah (C1-C2)', 'penerapan pada contoh nyata (C3)', 'analisis dan perbandingan (C4)', 'pemecahan masalah dan kesalahan umum (C3-C4)', 'proses atau langkah-langkah'];
    const prompts = parts.map((x, i) => head + 'Buat ' + [x.pg ? x.pg + ' soal pilihan ganda (tepat 4 opsi tanpa awalan huruf)' : '', x.ur ? x.ur + ' soal uraian' : ''].filter(Boolean).join(' dan ') + '.' +
      (parts.length > 1 ? ' Ini bagian ' + (i + 1) + ' dari ' + parts.length + '; fokus ' + (x.pg ? FOK[i % FOK.length] : 'penalaran tingkat tinggi (C4-C5)') + ', agar tidak sama dengan bagian lain.' : ' Tingkat kognitif bervariasi (C1-C4).') + tail);
    const res = geminiBatch_(key, model_(me), prompts);
    let out = [], err = '';
    res.forEach(r => {
      try {
        if (r.getResponseCode() !== 200) throw new Error(gemErr_(r));
        out = out.concat(parseSoal(r.getContentText()));
      } catch (e) { err = err || e.message; }
    });
    if (!out.length) throw new Error(err || 'AI tidak mengembalikan soal. Perjelas topik lalu generate ulang');
    return out;
  }]
};

/* =====================  PARSER HASIL AI  ===================== */
// Panggil Gemini untuk beberapa prompt sekaligus (paralel) dengan "berpikir" dimatikan/seminimal mungkin agar cepat.
// Tiap keluarga model memakai pengaturan berbeda (2.5: thinkingBudget; 3.x: thinkingLevel), jadi dicoba bertingkat:
// budget 0 -> level minimal -> level low -> tanpa pengaturan. Varian yang berhasil diingat per model (cache 6 jam).
const THINK_VARIANTS = [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, null];
function gemErr_(r) {
  const c = r.getResponseCode(), t = r.getContentText();
  let m = ''; try { m = JSON.parse(t).error.message; } catch (e) { m = t.slice(0, 200); }
  if (c === 429) return 'Gemini: kuota/batas permintaan tercapai. Tunggu sebentar atau ganti model di menu Akun (mis. gemini-flash-lite-latest)';
  if (c === 404) return 'Gemini: model tidak ditemukan. Ganti model di menu Akun (mis. gemini-flash-lite-latest)';
  if (/API key/i.test(m)) return 'Gemini: API key tidak valid. Periksa key di menu Akun';
  return 'Gemini ' + c + ': ' + String(m).slice(0, 200);
}
function geminiBatch_(key, model, prompts) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const mk = (pr, v) => {
    const g = { responseMimeType: 'application/json', temperature: 0.6, maxOutputTokens: 8192 };
    if (v) g.thinkingConfig = v;
    return { url, method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true, payload: JSON.stringify({ contents: [{ parts: [{ text: pr }] }], generationConfig: g }) };
  };
  const ck = 'gv_' + model, cc = CacheService.getScriptCache();
  let vi = Number(cc.get(ck)); if (!(vi >= 0 && vi < THINK_VARIANTS.length)) vi = 0;
  let res = UrlFetchApp.fetchAll(prompts.map(x => mk(x, THINK_VARIANTS[vi])));
  const bad = r => r.getResponseCode() === 400 && !/API key/i.test(r.getContentText());
  while (res.some(bad) && vi < THINK_VARIANTS.length - 1) { // pengaturan berpikir ditolak model ini -> coba varian berikutnya
    vi++; const idx = []; res.forEach((r, i) => { if (bad(r)) idx.push(i); });
    const rr = UrlFetchApp.fetchAll(idx.map(i => mk(prompts[i], THINK_VARIANTS[vi]))); idx.forEach((i, k) => { res[i] = rr[k]; });
    if (!res.some(bad)) cc.put(ck, String(vi), 21600);
  }
  const retry = []; res.forEach((r, i) => { if ([429, 500, 503].indexOf(r.getResponseCode()) >= 0) retry.push(i); });
  if (retry.length) { Utilities.sleep(2500); const rr = UrlFetchApp.fetchAll(retry.map(i => mk(prompts[i], THINK_VARIANTS[vi]))); retry.forEach((i, k) => { res[i] = rr[k]; }); }
  return res;
}

function parseSoal(raw) {
  const j = JSON.parse(raw), c = (j.candidates || [])[0];
  if (!c || !c.content) throw new Error('AI tidak memberi jawaban (' + ((c && c.finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || 'kosong') + ')');
  const t = (c.content.parts || []).filter(x => !x.thought && x.text).map(x => x.text).join('').replace(/```json|```/g, '').trim();
  let a;
  try { a = JSON.parse(t); } catch (e) {
    const i = t.indexOf('['), k = t.lastIndexOf(']');
    try { a = JSON.parse(t.slice(i, k + 1)); } catch (e2) { throw new Error('Respons AI terpotong/tidak terbaca. Kurangi jumlah soal lalu coba lagi'); }
  }
  if (!Array.isArray(a)) a = a.soal || a.questions || a.data || Object.values(a).find(Array.isArray) || [];
  return a.map(normSoal).filter(Boolean);
}
function normSoal(q) {
  if (!q) return null;
  const tx = String(q.q || q.pertanyaan || q.soal || '').trim(); if (!tx) return null;
  const o = q.o || q.opsi || q.options;
  if (Array.isArray(o) && o.length >= 2) {
    const op = o.slice(0, 4).map(x => String(x).replace(/^\s*[A-Da-d][\.\)]\s+/, '').trim());
    let k = q.k != null ? q.k : (q.kunci != null ? q.kunci : q.jawaban);
    if (typeof k === 'string') { const z = k.trim(); k = /^\d$/.test(z) ? Number(z) : (z.length === 1 && 'ABCD'.indexOf(z.toUpperCase()) >= 0 ? 'ABCD'.indexOf(z.toUpperCase()) : op.indexOf(z)); }
    k = Number(k); if (!(k >= 0 && k < op.length)) k = 0;
    return { t: 'pg', q: tx, o: op, k };
  }
  return { t: 'uraian', q: tx, k: String(q.k || q.kunci || q.jawaban || q.pedoman || '') };
}
