'use strict';
/* KELAS PINTAR v2 - frontend statis (Netlify). Backend: Google Apps Script (lihat js/config.js) */
const API = (window.KP_CONFIG || {}).API || '';
const $ = s => document.querySelector(s);
const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ST = { get() { try { return localStorage.getItem('kp2') || ''; } catch (e) { return ''; } }, set(v) { try { v ? localStorage.setItem('kp2', v) : localStorage.removeItem('kp2'); } catch (e) {} } };
const READ = new Set(['feed', 'stat', 'postList', 'qaList', 'rekap', 'mapelList', 'kelasList', 'kelasInfo', 'users', 'guruList', 'buku', 'bukuFresh', 'cfgGet', 'me', 'subs']);
const NL = ['kuis', 'tugas', 'lkpd'], COL = ['#0f766e', '#2563eb', '#9333ea', '#c2410c', '#be123c', '#4d7c0f', '#0e7490'];
const VEXT = /\.(mp4|webm|mov|m4v|mkv|avi|3gp|ogv)$/i;
let S = { tok: ST.get(), me: null, m: null }, D = {}, V = 'home', MT = 'post', LT = 1, SO = [], W = null, AT = 'kelas', NT = 'materi', FM = {}, RT = 0, nreq = 0;
const sk = n => '<div class="sk"></div>'.repeat(n || 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dl = id => 'https://drive.google.com/file/d/' + id + '/view';

/* ---------- util UI ---------- */
function toast(m, err) { const d = document.createElement('div'); d.textContent = m; if (err) d.className = 'err'; $('#toast').appendChild(d); setTimeout(() => d.remove(), err ? 9000 : 3200); }
window.addEventListener('unhandledrejection', e => toast('Error: ' + ((e.reason && e.reason.message) || e.reason), 1));
window.addEventListener('error', e => toast('Error: ' + e.message, 1));
async function run(f) { try { return await f(); } catch (e) { toast(e.message || String(e), 1); } }
function busy(m) { if (m) { $('#bm').textContent = m; $('#busy').classList.add('on'); } else if (!nreq) $('#busy').classList.remove('on'); }
function modal(h) { closeM(); const o = document.createElement('div'); o.className = 'ov'; o.id = 'md'; o.innerHTML = `<div class="sheet">${h}</div>`; o.addEventListener('mousedown', e => { if (e.target === o && !o.dataset.lock) closeM(); }); document.body.appendChild(o); return o; }
function closeM() { secureOff(); const o = $('#md'); if (o) o.remove(); }
function sure(msg, label) { // tampil di atas jendela lain (jendela kuis tidak ikut tertutup)
  return new Promise(res => {
    const o = document.createElement('div'); o.className = 'ov'; o.id = 'cf'; o.style.zIndex = 90;
    o.innerHTML = `<div class="sheet"><h3 style="margin-top:0">Konfirmasi</h3><p>${E(msg)}</p><div class="row"><button class="btn" id="cn">Batal</button><button class="btn pri" id="cy">${E(label || 'Ya')}</button></div></div>`;
    document.body.appendChild(o);
    const done = v => { o.remove(); res(v); };
    $('#cn').onclick = () => done(false); $('#cy').onclick = () => done(true);
  });
}
const head = t => `<div class="hd"><h3 style="margin:0">${t}</h3><button class="x" onclick="closeM()">✕</button></div>`;
const av = n => `<div class="av" style="background:${COL[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % COL.length]}">${E(String(n).trim().charAt(0).toUpperCase())}</div>`;

/* ---------- API client ---------- */
async function call(a, p, msg) {
  if (!API || /GANTI/.test(API)) throw new Error('Alamat backend belum diisi. Edit web/js/config.js atau set KP_API_URL di Netlify.');
  const rt = RT, isRead = READ.has(a);
  nreq++; $('#bar').style.width = '70%'; if (msg) busy(msg);
  try {
    let r = null;
    for (let n = 0, max = isRead ? 3 : 1; n < max; n++) {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 70000);
      try {
        const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ act: a, tok: S.tok, p: p || {} }), signal: ctl.signal });
        r = await res.json(); break;
      } catch (e) {
        if (n === max - 1) throw new Error(e.name === 'AbortError' ? 'Server terlalu lama merespons. Coba lagi.' : 'Tidak bisa terhubung ke server. Periksa internet, dan pastikan Web App Apps Script di-deploy dengan akses "Siapa saja".');
        await sleep(700 * (n + 1));
      } finally { clearTimeout(to); }
    }
    if (isRead && !(p && p.fresh) && rt !== RT) return new Promise(() => {}); // pengguna sudah pindah halaman
    if (r.ok) return r.d;
    if (r.e === 'AUTH') { ST.set(''); S.tok = ''; S.me = null; render(); throw new Error('Sesi habis, silakan login ulang'); }
    throw new Error(r.e);
  } finally {
    nreq--; if (!nreq) { $('#bar').style.width = '100%'; setTimeout(() => { if (!nreq) $('#bar').style.width = '0'; }, 250); $('#busy').classList.remove('on'); }
  }
}
const CC = {};
async function cached(k, ttl, f) { const c = CC[k]; if (c && Date.now() - c.t < ttl) return c.v; const v = await f(); CC[k] = { t: Date.now(), v }; return v; }
const bust = (...ks) => ks.forEach(k => delete CC[k]);
const loadK = async () => (D.kl = await cached('kl', 60000, () => call('kelasList')));
const loadM = async () => (D.ml = await cached('ml', 30000, () => call('mapelList')));

/* ---------- file helpers ---------- */
function fileB64(f) { return new Promise((ok, no) => { const r = new FileReader(); r.onerror = () => no(new Error('File tidak bisa dibaca')); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(f); }); }
async function prep(f) { // foto besar dikecilkan di browser sebelum diunggah (hemat kuota & waktu)
  if (/^image\/(jpeg|png|webp)$/.test(f.type) && f.size > 3e5) {
    try {
      const bm = await createImageBitmap(f), k = Math.min(1, 1600 / Math.max(bm.width, bm.height)), c = document.createElement('canvas');
      c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k); c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
      const b = await new Promise(r => c.toBlob(r, 'image/jpeg', .82));
      if (b && b.size < f.size) return { name: f.name.replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg', b64: await fileB64(b) };
    } catch (e) { /* pakai file asli */ }
  }
  const b64 = await fileB64(f);
  if (b64.length * .75 > 8e6) throw new Error('File terlalu besar (maks 8 MB)');
  return { name: f.name, mime: f.type || 'application/octet-stream', b64 };
}
function loadXLSX() { if (window.XLSX) return Promise.resolve(); return new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = ok; s.onerror = () => no(new Error('Gagal memuat pustaka Excel. Periksa koneksi.')); document.head.appendChild(s); }); }

/* ---------- login ---------- */
async function init() {
  if (API) fetch(API, { mode: 'no-cors' }).catch(() => {}); // "bangunkan" server Apps Script lebih awal
  if (S.tok) { try { S.me = await call('me'); } catch (e) { S.me = null; S.tok = ''; ST.set(''); setTimeout(() => toast('Sesi tidak bisa dimuat: ' + (e.message || e), 1), 100); } }
  render();
}
function render() { S.me ? main() : loginView(); }
function loginView() {
  LT = 1;
  $('#app').innerHTML = `<div class="login"><div class="card"><div style="text-align:center"><div class="mark" style="margin:auto;width:48px;height:48px;font-size:24px">🎓</div><h1>Kelas Online YPP</h1><p class="mu" style="margin:0 0 14px">Ruang belajar sekolah kita</p></div>
<div class="seg"><button id="t1" class="on" onclick="lt(1)">Siswa</button><button id="t2" onclick="lt(2)">Guru / Admin</button></div>
<div id="f1"><label class="f">NISN</label><input id="nisn" inputmode="numeric" autocomplete="off"><label class="f">Tanggal lahir</label><input id="lhr" type="date"></div>
<div id="f2" hidden><label class="f">Username</label><input id="usr" autocapitalize="none" autocomplete="username"><label class="f">Password</label><input id="pw" type="password" autocomplete="current-password"></div>
<button class="btn pri blk" onclick="doLogin()">Masuk</button></div></div>`;
  document.onkeydown = e => { if (e.key === 'Enter' && !S.me && $('#f1')) doLogin(); };
}
function lt(n) { LT = n; $('#f1').hidden = n !== 1; $('#f2').hidden = n !== 2; $('#t1').className = n == 1 ? 'on' : ''; $('#t2').className = n == 2 ? 'on' : ''; }
function doLogin() { run(async () => { const p = LT == 1 ? { siswa: 1, nisn: $('#nisn').value, lahir: $('#lhr').value } : { username: $('#usr').value, pass: $('#pw').value }; const r = await call('login', p, 'Masuk…'); S.tok = r.token; ST.set(r.token); S.me = r.user; V = 'home'; render(); }); }
function out() { ST.set(''); S.tok = ''; S.me = null; Object.keys(CC).forEach(k => delete CC[k]); render(); }

/* ---------- kerangka ---------- */
function main() {
  RT++; const m = S.me, t = [['home', '🏠', 'Beranda'], ['mapel', '📚', 'Mapel'], ['buku', '📖', 'Buku']];
  if (m.role === 'admin') t.push(['admin', '⚙️', 'Admin']); t.push(['akun', '👤', 'Akun']);
  const rl = { admin: 'Admin', guru: 'Guru', siswa: 'Siswa' }[m.role];
  $('#app').innerHTML = `<div class="top"><div class="brand"><div class="mark">🎓</div><div>Kelas Pintar${m.sekolah ? `<small>${E(m.sekolah)}</small>` : ''}</div></div><div class="sp"></div><div class="who"><b>${E(m.nama)}</b><small>${rl}${m.kelas ? ' · ' + E(m.kelas) : ''}</small></div></div>
<div class="shell"><nav>${t.map(x => `<button class="${V == x[0] || (V == 'm' && x[0] == 'mapel') ? 'on' : ''}" onclick="go('${x[0]}')"><i>${x[1]}</i>${x[2]}</button>`).join('')}</nav><main id="v"></main></div>`;
  ({ home: vHome, mapel: vMapel, buku: vBuku, admin: vAdmin, akun: vAkun, m: vM })[V](); window.scrollTo(0, 0);
}
function go(v) { V = v; main(); }
async function openM(id) { await run(async () => { await loadM(); S.m = D.ml.find(x => x.id === id); if (!S.m) { bust('ml'); await loadM(); S.m = D.ml.find(x => x.id === id); } if (!S.m) throw new Error('Mapel tidak ditemukan'); MT = 'post'; go('m'); }); }

/* ---------- beranda ---------- */
function vHome() {
  $('#v').innerHTML = sk(4);
  run(async () => {
    const [st, f] = await Promise.all([call('stat'), call('feed')]), r = S.me.role;
    const c = r === 'siswa' ? [['Mapel', st.mapel], ['Tugas belum dikerjakan', st.todo, st.todo > 0], ['Rata-rata nilai', st.avg]] : r === 'guru' ? [['Mapel', st.mapel], ['Postingan', st.post], ['Perlu dinilai', st.nilai, st.nilai > 0], ['Pertanyaan baru', st.tanya, st.tanya > 0]] : [['Siswa', st.siswa], ['Guru', st.guru], ['Kelas', st.kelas], ['Mapel', st.mapel]];
    $('#v').innerHTML = `<h2>Halo, ${E(S.me.nama.split(' ')[0])} 👋</h2><p class="lead">Ringkasan hari ini</p><div class="stats">${c.map(x => `<div class="stat ${x[2] ? 'hot' : ''}"><b>${E(x[1])}</b><span>${x[0]}</span></div>`).join('')}</div><h3>Terbaru</h3>` +
      (f.length ? f.map(x => `<div class="card cl" onclick="openM('${x.mapel}')"><span class="tag">${E(x.tipe)}</span> <b>${E(x.judul)}</b><br><small>${E(x.mn)} · ${E(x.dibuat)}</small></div>`).join('') : '<div class="empty">Belum ada pengumuman.</div>');
  });
}

/* ---------- mapel ---------- */
function vMapel() {
  $('#v').innerHTML = sk(3);
  run(async () => {
    const l = await loadM(), g = S.me.role !== 'siswa';
    $('#v').innerHTML = `<div class="row"><div><h2>Mata Pelajaran</h2></div><div class="sp"></div>${g ? '<button class="btn pri" onclick="mapelForm()">＋ Mapel</button>' : ''}</div>` + (l.length ? `<div class="grid">${l.map(x => `<div class="card cl mrow" onclick="openM('${x.id}')">${av(x.nama)}<div><b>${E(x.nama)}</b><br><small>Kelas ${E(x.kelas)} · ${E(x.gn)}</small></div></div>`).join('')}</div>` : '<div class="empty">Belum ada mapel.</div>');
  });
}
function mapelForm() {
  run(async () => {
    const k = await loadK(), ad = S.me.role === 'admin', gl = ad ? await call('guruList') : [];
    if (!k.length) return modal(head('Tambah Mapel') + `<div class="note">Belum ada kelas. ${ad ? 'Buat dulu di menu Admin → Kelas.' : 'Minta admin membuat kelas terlebih dahulu.'}</div>`);
    modal(head('Tambah Mapel') + `<label class="f">Nama mapel</label><input id="mn" placeholder="mis. IPA">` + (ad ? `<label class="f">Guru pengampu</label><select id="mg">${gl.map(x => `<option value="${x.id}">${E(x.nama)}</option>`).join('')}</select>` : '') + `<label class="f">Kelas (pilih satu atau lebih)</label><div class="chips">${k.map(x => `<label class="chip"><input type="checkbox" value="${E(x)}"><span>${E(x)}</span></label>`).join('')}</div><button class="btn pri blk" onclick="addMapel()">Simpan</button>`);
  });
}
function addMapel() { run(async () => { const kelas = [...document.querySelectorAll('#md .chip input:checked')].map(x => x.value); await call('mapelAdd', { nama: $('#mn').value, kelas, guru: $('#mg') ? $('#mg').value : '' }, 'Menyimpan…'); bust('ml'); closeM(); toast('Mapel disimpan'); V == 'admin' ? vAdmin() : vMapel(); }); }
function vM() {
  RT++; const m = S.m, g = S.me.role !== 'siswa', T = [['post', 'Materi & Tugas'], ['qa', 'Tanya Jawab']].concat(g ? [['new', 'Buat'], ['nilai', 'Nilai']] : []);
  $('#v').innerHTML = `<button class="btn sm" onclick="go('mapel')">← Mapel</button><div class="mrow" style="margin:12px 0">${av(m.nama)}<div><h2 style="margin:0">${E(m.nama)}</h2><small>Kelas ${E(m.kelas)} · ${E(m.gn)}</small></div></div><div class="seg">${T.map(t => `<button class="${MT == t[0] ? 'on' : ''}" onclick="MT='${t[0]}';vM()">${t[1]}</button>`).join('')}</div><div id="mc">${sk(2)}</div>`;
  ({ post: tPost, qa: tQA, new: tNew, nilai: tNilai })[MT]();
}

/* ---------- pemutar video ---------- */
function vurl(u) {
  u = String(u || ''); let m;
  if (m = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/)) return { k: 'yt', id: m[1] };
  if (m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || u.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/)) return { k: 'dr', id: m[1] };
  if (/\.(mp4|webm|ogv|m4v)(\?|#|$)/i.test(u)) return { k: 'mp', u };
  return null;
}
function player(v) {
  if (!v) return '';
  if (v.k === 'yt') return `<div class="vid"><iframe src="https://www.youtube-nocookie.com/embed/${E(v.id)}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  if (v.k === 'dr') return `<div class="vid"><iframe src="https://drive.google.com/file/d/${E(v.id)}/preview" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  return `<div class="vid"><video controls preload="metadata" src="${E(v.u)}"></video></div>`;
}
function putFile(url, f, mime) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest(); x.open('PUT', url); x.setRequestHeader('Content-Type', mime);
    x.upload.onprogress = e => { if (e.lengthComputable) $('#bm').textContent = 'Mengunggah video… ' + Math.round(e.loaded / e.total * 100) + '%'; };
    x.onload = () => x.status >= 200 && x.status < 300 ? ok() : no(new Error('Unggah video gagal (kode ' + x.status + ')'));
    x.onerror = () => no(new Error('Unggah video terputus. Coba lagi, atau pakai tautan YouTube/Drive.'));
    x.send(f);
  });
}

/* ---------- postingan ---------- */
function tPost() { run(async () => { const l = D.posts = await call('postList', { mapel: S.m.id }); $('#mc').innerHTML = l.length ? l.map(postCard).join('') : '<div class="empty">Belum ada postingan.</div>'; }); }
function postCard(p) {
  const g = S.me.role !== 'siswa';
  let h = `<div class="card"><span class="tag">${E(p.tipe)}${p.mode ? ' · ' + E(p.mode) : ''}</span> <b>${E(p.judul)}</b><br><small>${E(p.dibuat)}${p.kelas ? ' · Kelas ' + E(p.kelas.split(',').join(', ')) : ''}${p.soal.length ? ' · ' + p.soal.length + ' soal' : ''}</small>${p.isi ? `<div class="tx">${E(p.isi)}</div>` : ''}`;
  if (p.link) { h += player(vurl(p.link)); h += `<p><a href="${E(p.link)}" target="_blank" rel="noopener">🔗 Buka tautan</a></p>`; }
  if (p.file) { const a = p.file.split('|'); if (VEXT.test(a[1] || '')) h += player({ k: 'dr', id: a[0] }); h += `<p><a href="${dl(E(a[0]))}" target="_blank" rel="noopener">📎 ${E(a[1])}</a></p>`; }
  if (g) h += '<div class="row">' + (p.soal.length ? `<button class="btn sm" onclick="cetak('${p.id}',0)">🖨 Soal</button><button class="btn sm" onclick="cetak('${p.id}',1)">🔑 Kunci</button>` : '') + (NL.includes(p.tipe) ? `<button class="btn sm" onclick="hasil('${p.id}')">📊 Hasil</button>` : '') + `<button class="btn sm" onclick="editPost('${p.id}')">✏️ Ubah</button><button class="btn sm dg" onclick="delPost('${p.id}')">Hapus</button></div><div id="h${p.id}"></div>`;
  else if (NL.includes(p.tipe)) {
    if (p.mine) h += `<p class="ok">✔ Sudah dikirim${p.mine.nilai ? ' · Nilai <b>' + E(p.mine.nilai) + '</b>' : ' · menunggu penilaian guru'}</p>`;
    if (!(p.mine && p.tipe === 'kuis')) h += `<button class="btn pri" onclick="mulai('${p.id}')">${p.mine ? 'Kirim ulang' : p.tipe === 'kuis' ? '▶ Mulai kuis' : '✏️ Kerjakan'}</button>`;
  }
  return h + '</div>';
}
async function delPost(id) { if (await sure('Hapus postingan ini beserta pengumpulan dan filenya di Drive?', 'Hapus')) run(async () => { await call('postDel', { id }, 'Menghapus…'); tPost(); }); }
function editPost(id) {
  const p = D.posts.find(x => x.id === id);
  modal(head('Ubah postingan') + `<label class="f">Judul</label><input id="ej" value="${E(p.judul)}"><label class="f">Deskripsi / isi teks</label><textarea id="ei" rows="6">${E(p.isi)}</textarea><label class="f">Tautan</label><input id="el" type="url" value="${E(p.link)}">${mapelKelas().length > 1 ? `<label class="f">Untuk kelas</label>${kelasChips(mapelKelas(), p.kelas ? p.kelas.split(',') : mapelKelas(), 0)}` : ''}<p class="mu"><small>Soal dan file tidak diubah di sini. Untuk mengganti soal/file, buat postingan baru.</small></p><button class="btn pri blk" onclick="saveEdit('${id}')">Simpan</button>`);
}
function saveEdit(id) { run(async () => { await call('postEdit', { id, judul: $('#ej').value, isi: $('#ei').value, link: $('#el').value.trim(), kelas: mapelKelas().length > 1 ? [...document.querySelectorAll('#md .chip input:checked')].map(x => x.value) : undefined }, 'Menyimpan…'); closeM(); toast('Postingan diperbarui'); tPost(); }); }
function hasil(id) {
  run(async () => {
    const l = await call('subs', { post: id }), po = D.posts.find(x => x.id === id);
    $('#h' + id).innerHTML = l.length ? l.map(s => {
      const j = JSON.parse(s.jawab || '{}'), f = s.file ? s.file.split('|') : null;
      return `<div class="q"><b>${E(s.nama)}</b> <small>${E(s.kelas)} · ${E(s.waktu)}</small>${j.anggota ? `<div>Kelompok: ${E(j.anggota)}</div>` : ''}${j.teks ? `<div class="tx">${E(j.teks)}</div>` : ''}${f ? `<p><a href="${dl(E(f[0]))}" target="_blank" rel="noopener">📎 ${E(f[1])}</a></p>` : ''}${(j.ans || []).map((a, i) => { const q = po.soal[i]; return `<div class="tx">${i + 1}. ${E(q && q.t === 'pg' ? ('ABCD'[a] || '-') + (String(q.k) === String(a) ? ' ✔' : ' ✘') : a)}</div>`; }).join('')}<div class="row"><input id="n${s.id}" type="number" min="0" max="100" value="${E(s.nilai)}" placeholder="Nilai 0-100" style="max-width:140px;margin:0"><button class="btn sm pri" onclick="setN('${s.id}')">Simpan nilai</button></div></div>`;
    }).join('') : '<p class="mu">Belum ada pengumpulan.</p>';
  });
}
function setN(id) { run(async () => { await call('nilaiSub', { id, nilai: $('#n' + id).value }); toast('Nilai tersimpan'); }); }

/* ---------- siswa mengerjakan ---------- */
function mulai(id) { const p = D.posts.find(x => x.id === id); W = { p, i: 0, a: p.soal.map(() => ''), teks: '', ang: '', file: null }; drawW(true); }
function drawW(first) {
  const { p, i } = W, n = p.soal.length; let h = head(E(p.judul)), fin = i >= n;
  if (!fin) {
    const q = p.soal[i];
    h += `<div class="prog"><i style="width:${(i + 1) / n * 100}%"></i></div><small>Soal ${i + 1} dari ${n}</small><h3 style="margin-top:6px">${E(q.q)}</h3>` + (q.t === 'pg' ? q.o.map((o, j) => `<button class="opt ${W.a[i] === String(j) ? 'sel' : ''}" onclick="pick(${j})"><b>${'ABCD'[j]}</b><span>${E(o)}</span></button>`).join('') : `<textarea rows="5" placeholder="Tulis jawabanmu…" oninput="W.a[${i}]=this.value">${E(W.a[i])}</textarea>`);
  } else {
    const k = W.a.filter(x => x !== '').length;
    h += `<h3 style="margin-top:0">${n ? 'Periksa & kirim' : 'Kerjakan'}</h3>` + (n ? `<p>Terjawab <b>${k}</b> dari ${n} soal.${k < n ? ' <span class="er">Masih ada yang kosong.</span>' : ''}</p>` : '') +
      (p.tipe !== 'kuis' || !n ? `<label class="f">Jawaban / catatan</label><textarea rows="5" oninput="W.teks=this.value">${E(W.teks)}</textarea>` : '') +
      (p.tipe !== 'kuis' ? `<label class="f">Lampirkan foto/berkas pekerjaan (opsional, maks 8 MB)</label><input type="file" accept="image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt" onchange="W.file=this.files[0]||null">` : '') +
      (p.mode === 'kelompok' ? `<label class="f">Nama anggota kelompok</label><input value="${E(W.ang)}" oninput="W.ang=this.value">` : '');
  }
  if (n) h += `<div class="dots">${W.a.map((x, k) => `<span class="${k == i ? 'cur' : ''} ${x !== '' ? 'fill' : ''}" onclick="W.i=${k};drawW()"></span>`).join('')}</div>`;
  h += `<div class="row">${i > 0 ? '<button class="btn" onclick="W.i--;drawW()">← Kembali</button>' : ''}<div class="sp" style="flex:1"></div>${fin ? '<button class="btn pri" onclick="sendW()">Kirim jawaban</button>' : '<button class="btn pri" onclick="W.i++;drawW()">' + (i == n - 1 ? 'Selesai →' : 'Lanjut →') + '</button>'}</div>`;
  if (first) { modal(h); $('#md').dataset.lock = 1; if (p.tipe === 'kuis') secureOn(); } else $('#md .sheet').innerHTML = h;
}

/* ---------- pengaman tampilan kuis (penghalang, bukan jaminan mutlak) ---------- */
const SEC = { h: [] };
function secureOff() { SEC.h.forEach(x => x[0].removeEventListener(x[1], x[2], x[3])); SEC.h = []; }
function secureOn() {
  secureOff(); const o = $('#md'); if (!o) return; o.classList.add('secure');
  const t = (S.me.nama + ' · ' + (S.me.kelas || '') + ' · ' + new Date().toLocaleString('id-ID')).replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="170"><text x="10" y="95" transform="rotate(-22 240 85)" font-size="13" font-family="sans-serif" fill="#808080" fill-opacity=".28">${t}</text></svg>`;
  const wm = document.createElement('div'); wm.className = 'wm'; wm.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")'; o.appendChild(wm);
  const field = e => e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName);
  const stop = e => { if (e.type === 'selectstart' && field(e)) return; e.preventDefault(); };
  const key = e => {
    const k = String(e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && 'cxpsu'.indexOf(k) >= 0 && k.length === 1) e.preventDefault();
    if (k === 'printscreen') { try { navigator.clipboard.writeText(''); } catch (x) {} o.classList.add('hide'); setTimeout(() => o.classList.remove('hide'), 1500); }
  };
  const hide = () => o.classList.add('hide'), show = () => o.classList.remove('hide');
  // blur/focus elemen anak (mis. tombol yang hilang saat soal digambar ulang) ikut sampai ke window pada fase capture,
  // jadi hanya blur/focus milik window itu sendiri yang dihitung
  const wblur = e => { if (e.target === window) hide(); }, wfocus = e => { if (e.target === window) show(); };
  [[o, 'contextmenu', stop, true], [o, 'selectstart', stop, true], [o, 'dragstart', stop, true], [document, 'copy', stop, true], [document, 'cut', stop, true], [document, 'keydown', key, true], [document, 'keyup', key, true],
   [document, 'visibilitychange', () => document.hidden ? hide() : show(), false], [window, 'blur', wblur, false], [window, 'focus', wfocus, false],
   [o, 'pointerdown', () => { if (document.hasFocus() && !document.hidden) show(); }, false]]
    .forEach(x => { x[0].addEventListener(x[1], x[2], x[3]); SEC.h.push(x); });
}
function pick(j) { W.a[W.i] = String(j); drawW(); }
async function sendW() {
  const k = W.a.filter(x => x === '').length;
  if (k && !await sure(k + ' soal belum dijawab. Tetap kirim?', 'Kirim')) return;
  if (W.p.tipe === 'kuis' && !await sure('Kuis hanya bisa dikirim sekali. Lanjut kirim?', 'Kirim')) return;
  run(async () => {
    let file = null;
    if (W.file) { busy('Menyiapkan lampiran…'); try { file = await prep(W.file); } finally { busy(0); } }
    const r = await call('submit', { post: W.p.id, ans: W.a, teks: W.teks, anggota: W.ang, file }, 'Mengirim…');
    modal((r.nilai ? `<p class="mu" style="text-align:center">Nilai kamu</p><div class="score">${E(r.nilai)}</div>` : '<div class="score">✔</div><p style="text-align:center">Jawaban terkirim. Nilai akan diberikan guru.</p>') + '<button class="btn pri blk" onclick="closeM()">Tutup</button>');
    tPost();
  });
}

/* ---------- tanya jawab & nilai ---------- */
function tQA() {
  run(async () => {
    const l = await call('qaList', { mapel: S.m.id }), g = S.me.role !== 'siswa';
    let h = g ? '' : '<div class="card"><textarea id="qt" rows="3" placeholder="Tulis pertanyaan untuk guru…"></textarea><button class="btn pri" onclick="ask()">Kirim pertanyaan</button></div>';
    if (g && l.length) h += `<div class="row"><small class="mu">${l.length} pertanyaan</small><div class="sp" style="flex:1"></div><button class="btn sm dg" onclick="clearQA()">🗑 Hapus semua</button></div>`;
    h += l.map(x => `<div class="card"><div class="row" style="margin:0"><small style="flex:1">${E(x.nama)} · ${E(x.waktu)}</small>${g ? `<button class="btn sm dg" onclick="delQA('${x.id}')">Hapus</button>` : ''}</div><div class="tx">${E(x.tanya)}</div>${x.jawab ? `<div class="ans"><b>Jawaban guru</b><div class="tx">${E(x.jawab)}</div></div>` : g ? `<textarea id="j${x.id}" rows="2" placeholder="Tulis jawaban"></textarea><button class="btn pri sm" onclick="jwb('${x.id}')">Kirim jawaban</button>` : '<small>⏳ Menunggu jawaban…</small>'}</div>`).join('');
    $('#mc').innerHTML = h || '<div class="empty">Belum ada pertanyaan.</div>';
  });
}
async function delQA(id) { if (await sure('Hapus pertanyaan ini beserta jawabannya?', 'Hapus')) run(async () => { await call('qaDel', { id }, 'Menghapus…'); toast('Dihapus'); tQA(); }); }
async function clearQA() { if (await sure('Hapus SEMUA tanya jawab di mapel ' + S.m.nama + '? Tindakan ini tidak bisa dibatalkan.', 'Hapus semua')) run(async () => { const n = await call('qaClear', { mapel: S.m.id }, 'Menghapus…'); toast(n + ' pertanyaan dihapus'); tQA(); }); }
function ask() { run(async () => { await call('tanya', { mapel: S.m.id, t: $('#qt').value }, 'Mengirim…'); toast('Terkirim'); tQA(); }); }
function jwb(id) { run(async () => { await call('jawab', { id, t: $('#j' + id).value }, 'Mengirim…'); tQA(); }); }
function tNilai() {
  run(async () => {
    const r = await call('rekap', { mapel: S.m.id });
    $('#mc').innerHTML = r.baris.length ? `<div class="scroll card"><table><tr><th>Nama</th><th>Kelas</th>${r.kolom.map(k => `<th>${E(k)}</th>`).join('')}<th>Rata-rata</th></tr>${r.baris.map(b => `<tr><td>${E(b.nama)}</td><td>${E(b.kelas)}</td>${b.n.map(x => `<td>${E(x)}</td>`).join('')}<td><b>${E(b.avg)}</b></td></tr>`).join('')}</table></div><button class="btn" onclick="csvRekap()">⬇ Unduh CSV</button>` : '<div class="empty">Belum ada siswa di kelas mapel ini.</div>';
    D.rekap = r;
  });
}
function csvRekap() {
  const r = D.rekap, q = x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
  const rows = [['Nama', 'Kelas'].concat(r.kolom, ['Rata-rata'])].concat(r.baris.map(b => [b.nama, b.kelas].concat(b.n, [b.avg])));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.map(x => x.map(q).join(',')).join('\n')], { type: 'text/csv' })); a.download = 'rekap_nilai_' + S.m.nama + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- buat postingan + soal ---------- */
const mapelKelas = () => String(S.m.kelas || '').split(',').map(x => x.trim()).filter(Boolean);
function togK(el) { FM.kc = el.checked ? [...new Set((FM.kc || []).concat(el.value))] : (FM.kc || []).filter(x => x !== el.value); }
function kelasChips(ks, sel, cb) { return `<div class="chips">${ks.map(x => `<label class="chip"><input type="checkbox" value="${E(x)}" ${sel.includes(x) ? 'checked' : ''} ${cb ? 'onchange="togK(this)"' : ''}><span>${E(x)}</span></label>`).join('')}</div>`; }
function tNew(t0, keep) {
  if (!keep) { SO = []; FM = { j: '', i: '', l: '', mo: 'individu', file: null, video: null, gt: '', gp: '5', gu: '2', kc: mapelKelas() }; }
  NT = NL.concat(['materi', 'pengumuman']).includes(t0) ? t0 : 'materi';
  const T = [['materi', 'Materi'], ['tugas', 'Tugas'], ['kuis', 'Kuis'], ['lkpd', 'LKPD'], ['pengumuman', 'Pengumuman']];
  $('#mc').innerHTML = `<div class="card"><label class="f">Jenis postingan</label><div class="seg" id="ptt">${T.map(t => `<button data-t="${t[0]}" class="${t[0] === NT ? 'on' : ''}" onclick="setT('${t[0]}')">${t[1]}</button>`).join('')}</div>
${mapelKelas().length > 1 ? `<label class="f">Untuk kelas (hanya kelas yang dipilih yang bisa membuka)</label>${kelasChips(mapelKelas(), FM.kc || [], 1)}` : ''}
<div id="pm"><label class="f">LKPD dikerjakan secara</label><select id="pmo" onchange="FM.mo=this.value"><option value="individu">Individu</option><option value="kelompok">Kelompok</option></select></div>
<label class="f">Judul</label><input id="pj" value="${E(FM.j)}" oninput="FM.j=this.value"><label class="f">Deskripsi / isi teks</label><textarea id="pi" rows="5" oninput="FM.i=this.value">${E(FM.i)}</textarea>
<label class="f">Tautan video / sumber (opsional): YouTube, Google Drive, atau .mp4 akan diputar langsung di web</label><input id="pl" type="url" placeholder="https://" value="${E(FM.l)}" oninput="FM.l=this.value"><label class="f">Unggah PDF / foto / dokumen (maks 8 MB; foto otomatis dikecilkan)</label><input id="pf" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,image/*" onchange="FM.file=this.files[0]||null">
<div id="pv"><label class="f">Atau unggah video dari perangkat (tersimpan di Google Drive, maks 500 MB)</label><input id="pvf" type="file" accept="video/*" onchange="FM.video=this.files[0]||null"></div></div>
<div id="ps"><div class="card"><b>✨ Buat soal dengan AI</b><p class="mu" style="margin:2px 0 8px">Butuh API key Gemini di menu Akun.</p><label class="f">Topik / tujuan pembelajaran</label><input id="gt" value="${E(FM.gt)}" oninput="FM.gt=this.value"><div class="row"><div class="f"><label class="f">Jumlah PG</label><input id="gp" type="number" value="${E(FM.gp)}" min="0" max="20" oninput="FM.gp=this.value"></div><div class="f"><label class="f">Jumlah uraian</label><input id="gu" type="number" value="${E(FM.gu)}" min="0" max="10" oninput="FM.gu=this.value"></div></div><button class="btn pri" onclick="genAI()">Generate soal</button></div>
<h3>Daftar soal <span id="sc" class="mu"></span></h3><div id="sl"></div><div class="row"><button class="btn" onclick="addQ('pg')">＋ Pilihan ganda</button><button class="btn" onclick="addQ('uraian')">＋ Uraian</button></div></div>
<div id="pe"></div><button id="pb" class="btn pri blk" onclick="savePost()">Publikasikan</button>`;
  const g = id => document.getElementById(id); g('pm').hidden = NT !== 'lkpd'; g('ps').hidden = !NL.includes(NT); g('pv').hidden = !(NT === 'materi' || NT === 'lkpd'); g('pmo').value = FM.mo; rSO();
}
function setT(t) {
  NT = t; document.querySelectorAll('#ptt button').forEach(x => x.classList.toggle('on', x.dataset.t === t));
  const a = document.getElementById('pm'), b = document.getElementById('ps'); if (!a || !b) { tNew(t, 1); return; }
  a.hidden = t !== 'lkpd'; b.hidden = !NL.includes(t); const c = document.getElementById('pv'); if (c) c.hidden = !(t === 'materi' || t === 'lkpd');
}
function addQ(t) { SO.push(t === 'pg' ? { t: 'pg', q: '', o: ['', '', '', ''], k: 0 } : { t: 'uraian', q: '', k: '' }); rSO(); }
function rSO() {
  $('#sc').textContent = SO.length ? '(' + SO.length + ')' : '';
  $('#sl').innerHTML = SO.length ? SO.map((q, i) => `<div class="q"><div class="row" style="margin:0"><b>${i + 1}. ${q.t === 'pg' ? 'Pilihan ganda' : 'Uraian'}</b><div style="flex:1"></div><button class="btn sm dg" onclick="SO.splice(${i},1);rSO()">✕</button></div><textarea rows="2" oninput="SO[${i}].q=this.value">${E(q.q)}</textarea>` + (q.t === 'pg' ? q.o.map((o, j) => `<div class="op"><input type="radio" name="k${i}" ${q.k === j ? 'checked' : ''} onchange="SO[${i}].k=${j}"><input value="${E(o)}" placeholder="Opsi ${'ABCD'[j]}" oninput="SO[${i}].o[${j}]=this.value"></div>`).join('') + '<small>Bulatan = kunci jawaban</small>' : `<small>Pedoman / kunci</small><textarea rows="2" oninput="SO[${i}].k=this.value">${E(q.k)}</textarea>`) + '</div>').join('') : '<div class="empty">Belum ada soal. Generate dengan AI atau tambah manual.</div>';
}
function genAI() { run(async () => { const r = await call('gen', { mapel: S.m.nama, kelas: S.m.kelas.split(',')[0], topik: FM.gt, pg: FM.gp, uraian: FM.gu }, 'AI sedang membuat soal…'); SO = SO.concat(r); rSO(); toast(r.length + ' soal ditambahkan. Periksa dan edit bila perlu.'); $('#sl').scrollIntoView({ behavior: 'smooth' }); }); }
function pubErr(m, el) { const e = document.getElementById('pe'); if (e) e.innerHTML = `<div class="note" style="background:var(--errbg);color:var(--err)">⚠ ${E(m)}</div>`; const t = el || e; if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (el && el.focus) el.focus(); toast(m, 1); }
async function savePost() {
  const t = NT, fl = FM.file, pe = document.getElementById('pe'); if (pe) pe.innerHTML = '';
  if (!String(FM.j || '').trim()) return pubErr('Judul wajib diisi. Kolom Judul ada di bagian paling atas halaman ini.', document.getElementById('pj'));
  if (NL.includes(t)) {
    if (t === 'kuis' && !SO.length) return pubErr('Kuis belum punya soal. Generate dengan AI atau tambah manual.');
    const bad = SO.findIndex(q => !q.q.trim() || (q.t === 'pg' && q.o.some(o => !o.trim()))); if (bad >= 0) return pubErr('Soal nomor ' + (bad + 1) + ' masih ada bagian yang kosong (pertanyaan atau opsi).');
  }
  if (!(FM.kc || []).length) return pubErr('Pilih minimal satu kelas tujuan postingan.');
  const vf = (t === 'materi' || t === 'lkpd') ? FM.video : null;
  if (fl && fl.size > 3e7) return pubErr('File terlalu besar. Untuk video gunakan kolom unggah video.');
  if (vf && fl) return pubErr('Pilih salah satu: file PDF/foto atau video.');
  if (vf && vf.size > 5e8) return pubErr('Video terlalu besar (maks 500 MB). Unggah ke YouTube/Drive lalu tempel tautannya.');
  if (vf && !/^video\//.test(vf.type || '') && !VEXT.test(vf.name)) return pubErr('File yang dipilih bukan video.');
  const b = document.getElementById('pb'); b.disabled = true;
  try {
    let vfile = null, file = null;
    if (fl) { busy('Menyiapkan file…'); try { file = await prep(fl); } finally { busy(0); } }
    if (vf) {
      const mime = vf.type || 'video/mp4', ini = await call('vidInit', { mapel: S.m.id, name: vf.name, mime, size: vf.size, origin: location.origin }, 'Menyiapkan unggahan…');
      busy('Mengunggah video… 0%'); try { await putFile(ini.url, vf, mime); } finally { busy(0); }
      await call('vidDone', { id: ini.id }, 'Menyelesaikan…'); vfile = { id: ini.id, name: ini.name };
    }
    await call('postAdd', { vfile, mapel: S.m.id, tipe: t, judul: FM.j.trim(), isi: FM.i, link: FM.l.trim(), mode: t === 'lkpd' ? FM.mo : '', kelas: FM.kc, soal: JSON.stringify(NL.includes(t) ? SO : []), file }, 'Menyimpan postingan…');
    toast('✔ Berhasil dipublikasikan'); MT = 'post'; vM();
  } catch (e) { b.disabled = false; pubErr(e.message || String(e)); }
}
function cetak(id, key) {
  const p = D.posts.find(x => x.id === id);
  let h = `<h2>${E(p.judul)}</h2><p>${E(S.m.nama)} — Kelas ${E(S.m.kelas)}</p>` + (key ? '<h3>KUNCI JAWABAN</h3>' : '<p>Nama: ______________ &nbsp; Kelas: ______ &nbsp; Nilai: ______</p>');
  p.soal.forEach((q, i) => { h += `<div class="pq"><b>${i + 1}.</b> ${E(q.q)}`; if (q.t === 'pg') h += q.o.map((o, j) => `<div>&nbsp;&nbsp;${'ABCD'[j]}. ${E(o)}${key && q.k === j ? ' ✔' : ''}</div>`).join(''); if (key && q.t !== 'pg') h += `<div><i>Pedoman: ${E(q.k)}</i></div>`; h += '</div>'; });
  $('#pr').innerHTML = h; window.print();
}

/* ---------- buku paket ---------- */
function vBuku() {
  $('#v').innerHTML = sk(4);
  run(async () => {
    const r = await call('buku', {});
    if (r.need) { $('#v').innerHTML = `<h2>Buku Paket</h2><div class="note">Folder buku paket belum diatur. ${S.me.role === 'admin' ? 'Isi tautan folder Google Drive di Admin → Pengaturan.' : 'Minta admin mengisinya di menu Admin → Pengaturan.'}</div>`; return; }
    D.b = r.list;
    $('#v').innerHTML = '<div class="row"><h2>Buku Paket</h2><div class="sp" style="flex:1"></div><button class="btn sm" onclick="refBuku()">↻ Muat ulang</button></div><input id="bq" placeholder="🔍 Cari buku…" oninput="fb()"><div id="bl"></div>'; fb();
  });
}
function fb() {
  const q = ($('#bq').value || '').toLowerCase();
  const h = D.b.map(g => { const a = g.a.filter(f => f.n.toLowerCase().includes(q)); return a.length ? `<h3>${E(g.f)}</h3><div class="grid">${a.map(f => `<a class="card cl mrow" style="text-decoration:none;color:inherit" href="${dl(E(f.id))}" target="_blank" rel="noopener"><div class="av" style="background:#2563eb">📖</div><div><b>${E(f.n)}</b></div></a>`).join('')}</div>` : ''; }).join('');
  $('#bl').innerHTML = h || '<div class="empty">Tidak ada buku.</div>';
}
function refBuku() { run(async () => { await call('bukuFresh', { fresh: 1 }, 'Memuat ulang…'); vBuku(); }); }

/* ---------- admin ---------- */
function vAdmin() {
  RT++; const T = [['kelas', 'Kelas'], ['siswa', 'Siswa'], ['user', 'Pengguna'], ['mapel', 'Mapel'], ['cfg', 'Pengaturan']];
  $('#v').innerHTML = `<h2>Admin</h2><div class="seg">${T.map(t => `<button class="${AT == t[0] ? 'on' : ''}" onclick="AT='${t[0]}';vAdmin()">${t[1]}</button>`).join('')}</div><div id="ac">${sk(2)}</div>`;
  ({ kelas: aKelas, siswa: aSiswa, user: aUser, mapel: aMapel, cfg: aCfg })[AT]();
}
function aKelas() {
  run(async () => {
    const k = await call('kelasInfo'); D.kl = k.map(x => x.nama);
    $('#ac').innerHTML = `<div class="card"><b>Tambah kelas</b><p class="mu" style="margin:2px 0 8px">Pisahkan dengan koma, mis. <i>7A, 7B, 8A</i></p><input id="kn" placeholder="Nama kelas"><button class="btn pri" onclick="addK()">Tambah</button></div><h3>Daftar kelas (${k.length})</h3>` + (k.length ? `<div class="chips">${k.map((x, i) => `<span class="kc">${E(x.nama)} <small>${x.n} siswa</small><button onclick="delK(${i})" title="Hapus">✕</button></span>`).join('')}</div>` : '<div class="empty">Belum ada kelas. Buat kelas dulu sebelum menambah siswa dan mapel.</div>');
  });
}
function addK() { run(async () => { const n = await call('kelasAdd', { names: $('#kn').value }, 'Menyimpan…'); bust('kl'); toast(n + ' kelas ditambahkan'); aKelas(); }); }
async function delK(i) { const n = D.kl[i]; if (await sure('Hapus kelas ' + n + '?', 'Hapus')) run(async () => { await call('kelasDel', { nama: n }, 'Menghapus…'); bust('kl'); aKelas(); }); }
function aSiswa() {
  run(async () => {
    const k = await loadK(); if (!k.length) { $('#ac').innerHTML = '<div class="note">Buat kelas dulu di tab Kelas.</div>'; return; }
    $('#ac').innerHTML = `<div class="card"><b>Impor siswa (Excel/CSV)</b><p class="mu" style="margin:2px 0 8px">Kolom: NISN, Nama, Kelas, Tanggal Lahir. Kelas harus sudah ada di tab Kelas. Format kolom NISN sebagai teks.</p><div class="row"><button class="btn sm" onclick="tpl()">⬇ Unduh templat</button></div><input id="xf" type="file" accept=".xlsx,.xls,.csv"><button class="btn pri" onclick="imp()">Unggah & simpan</button><div id="ir"></div></div>
<div class="card"><b>Tambah satu siswa</b><label class="f">NISN</label><input id="sn" inputmode="numeric"><label class="f">Nama</label><input id="sm"><label class="f">Kelas</label><select id="sk">${k.map(x => `<option>${E(x)}</option>`).join('')}</select><label class="f">Tanggal lahir</label><input id="sl2" type="date"><button class="btn pri" onclick="addS()">Simpan</button></div>`;
  });
}
function addS() { run(async () => { await call('userAdd', { role: 'siswa', nisn: $('#sn').value, nama: $('#sm').value, kelas: $('#sk').value, lahir: $('#sl2').value }, 'Menyimpan…'); toast('Siswa disimpan'); $('#sn').value = ''; $('#sm').value = ''; }); }
function aUser() {
  run(async () => {
    const k = await loadK();
    $('#ac').innerHTML = `<div class="row"><input id="uq" placeholder="🔍 Cari nama / NISN" oninput="fuDeb()" style="flex:1;margin:0"><select id="uk" onchange="fu()" style="width:auto;margin:0"><option value="">Semua</option><option value="__staf">Guru/Admin</option>${k.map(x => `<option>${E(x)}</option>`).join('')}</select><button class="btn pri" onclick="staffForm()">＋ Guru/Admin</button></div><small id="uc"></small><div id="ul" style="margin-top:8px"></div>`; fu();
  });
}
let _fu; function fuDeb() { clearTimeout(_fu); _fu = setTimeout(fu, 350); }
function fu() {
  run(async () => {
    const r = await call('users', { q: $('#uq').value, kelas: $('#uk').value });
    $('#uc').textContent = r.total + ' pengguna' + (r.total > r.list.length ? ' (menampilkan ' + r.list.length + ', persempit pencarian)' : '');
    $('#ul').innerHTML = r.list.map(x => `<div class="card mrow">${av(x.nama)}<div style="flex:1"><b>${E(x.nama)}</b><br><small>${E(x.role === 'siswa' ? 'Siswa · NISN ' + x.nisn + ' · ' + x.kelas : x.role + ' · ' + x.username)}</small></div><button class="btn sm dg" onclick="delU('${x.id}')">Hapus</button></div>`).join('') || '<div class="empty">Tidak ada.</div>';
  });
}
function staffForm() { modal(head('Tambah Guru / Admin') + `<label class="f">Peran</label><select id="gr"><option value="guru">Guru</option><option value="admin">Admin</option></select><label class="f">Username</label><input id="gu2" autocapitalize="none"><label class="f">Nama lengkap</label><input id="gm"><label class="f">Password (min. 6)</label><input id="gp2" type="password"><button class="btn pri blk" onclick="addG()">Simpan</button>`); }
function addG() { run(async () => { await call('userAdd', { role: $('#gr').value, username: $('#gu2').value, nama: $('#gm').value, pass: $('#gp2').value }, 'Menyimpan…'); bust('ml'); closeM(); toast('Akun disimpan'); aUser(); }); }
async function delU(id) { if (await sure('Hapus pengguna ini? Untuk siswa, nilai dan pengumpulannya ikut terhapus.', 'Hapus')) run(async () => { await call('userDel', { id }, 'Menghapus…'); fu(); }); }
function aMapel() {
  run(async () => {
    const l = await loadM();
    $('#ac').innerHTML = `<div class="row"><div style="flex:1"></div><button class="btn pri" onclick="mapelForm()">＋ Mapel</button></div>` + (l.length ? l.map(x => `<div class="card mrow">${av(x.nama)}<div style="flex:1"><b>${E(x.nama)}</b><br><small>Kelas ${E(x.kelas)} · ${E(x.gn)}</small></div><button class="btn sm dg" onclick="delM('${x.id}','${E(x.nama).replace(/'/g, '')}')">Hapus</button></div>`).join('') : '<div class="empty">Belum ada mapel.</div>');
  });
}
async function delM(id, n) { if (await sure('Hapus mapel "' + n + '" beserta SEMUA postingan, pengumpulan, nilai, tanya jawab, dan file Drive di dalamnya? Tindakan ini tidak bisa dibatalkan.', 'Hapus semua')) run(async () => { await call('mapelDel', { id }, 'Menghapus mapel…'); bust('ml'); toast('Mapel dihapus'); aMapel(); }); }
function aCfg() {
  run(async () => {
    const c = await call('cfgGet');
    $('#ac').innerHTML = `<div class="card"><b>Identitas sekolah</b><label class="f" style="margin-top:8px">Nama sekolah (tampil di bagian atas)</label><input id="cs" value="${E(c.sekolah)}"><button class="btn pri" onclick="saveCfg('sekolah')">Simpan</button></div>
<div class="card"><b>Folder Buku Paket (Google Drive)</b><p class="mu" style="margin:2px 0 8px">Tempel tautan folder. Bagikan folder sebagai "Siapa saja yang memiliki link: Pelihat" agar siswa bisa membuka bukunya.</p><input id="cb" type="url" placeholder="https://drive.google.com/drive/folders/…" value="${c.buku ? 'https://drive.google.com/drive/folders/' + E(c.buku) : ''}"><button class="btn pri" onclick="saveCfg('buku')">Simpan</button></div>
<div class="card"><b>API key Gemini bersama</b><p class="mu" style="margin:2px 0 8px">Dipakai semua guru yang belum mengisi key sendiri. ${c.hasGlobalKey ? '<span class="ok">Sudah tersimpan</span> (isi lagi untuk mengganti).' : 'Belum diisi.'}</p><input id="cg" type="password" autocomplete="off" placeholder="API key"><div class="row"><button class="btn pri" onclick="saveCfg('gkey')">Simpan</button>${c.hasGlobalKey ? '<button class="btn dg" onclick="saveCfg(\'gclear\')">Hapus key</button>' : ''}</div></div>
<div class="card"><b>Folder penyimpanan file (Google Drive)</b><p class="mu" style="margin:2px 0 8px">Secara bawaan aplikasi membuat folder otomatis di akun pemilik script. Untuk memakai folder sendiri, tempel tautan/ID folder di bawah. Folder harus dibagikan ke <b>${E(c.akun || 'akun pemilik script')}</b> dengan akses <b>Editor</b>. Kolom yang tidak diubah dibiarkan.</p>
<label class="f">📎 Lampiran materi</label><input id="fu1" value="${E(c.up)}"><label class="f">🎬 Video</label><input id="fu2" value="${E(c.vid)}"><label class="f">📝 Pengumpulan siswa</label><input id="fu3" value="${E(c.sub)}">
<button class="btn pri" onclick="saveFolders()">Simpan folder</button><p class="mu" style="margin:10px 0 4px"><small>File yang sudah terlanjur diunggah tetap bisa dibuka. Hanya unggahan berikutnya yang masuk ke folder baru.</small></p><a class="fl" href="${E(c.root)}" target="_blank" rel="noopener">📁 Folder utama</a><a class="fl" href="${E(c.up)}" target="_blank" rel="noopener">📎 Buka lampiran</a><a class="fl" href="${E(c.vid)}" target="_blank" rel="noopener">🎬 Buka video</a><a class="fl" href="${E(c.sub)}" target="_blank" rel="noopener">📝 Buka pengumpulan</a></div>`;
    D.cfg = c;
  });
}
function saveFolders() {
  run(async () => {
    const c = D.cfg, p = {}, v = [$('#fu1').value.trim(), $('#fu2').value.trim(), $('#fu3').value.trim()], id = [c.upId, c.vidId, c.subId];
    ['fup', 'fvid', 'fsub'].forEach((k, i) => { if (v[i] && v[i].indexOf(id[i]) < 0) p[k] = v[i]; });
    if (!Object.keys(p).length) return toast('Tidak ada folder yang diubah');
    await call('cfgSet', p, 'Memeriksa akses folder…'); toast('Folder disimpan'); aCfg();
  });
}
function saveCfg(k) {
  run(async () => {
    const p = {}; if (k === 'sekolah') p.sekolah = $('#cs').value; if (k === 'buku') p.buku = $('#cb').value; if (k === 'gkey') { p.gkey = $('#cg').value.trim(); if (!p.gkey) throw new Error('API key kosong'); } if (k === 'gclear') p.gclear = 1;
    await call('cfgSet', p, 'Menyimpan…'); if (k === 'sekolah') S.me = await call('me'); toast('Tersimpan'); k === 'sekolah' ? main() : aCfg();
  });
}
function tpl() { loadXLSX().then(() => { const ws = XLSX.utils.aoa_to_sheet([['NISN', 'Nama', 'Kelas', 'Tanggal Lahir'], ['0012345678', 'Contoh Siswa', (D.kl || ['7A'])[0], '2011-05-20']]), wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Siswa'); XLSX.writeFile(wb, 'templat_siswa.xlsx'); }).catch(e => toast(e.message, 1)); }
function imp() {
  const f = $('#xf').files[0]; if (!f) return toast('Pilih file dulu', 1);
  run(async () => {
    await loadXLSX(); const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true }), ws = wb.Sheets[wb.SheetNames[0]];
    const p = n => ('0' + n).slice(-2), ymd = c => { const d = new Date(c.getTime() + 432e5); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
    let rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).map(x => x.map(c => c instanceof Date ? ymd(c) : c));
    if (rows.length && !/^\d/.test(String(rows[0][0]).trim())) rows.shift(); rows = rows.filter(x => x.some(c => String(c).trim()));
    if (!rows.length) throw new Error('File kosong');
    const o = await call('userBulk', { rows }, 'Menyimpan ' + rows.length + ' siswa…');
    $('#ir').innerHTML = `<p class="ok"><b>${o.ok}</b> siswa tersimpan.</p>` + (o.err.length ? `<div class="note">${o.err.map(E).join('<br>')}</div>` : '');
  });
}

/* ---------- akun ---------- */
function vAkun() {
  const m = S.me, g = m.role !== 'siswa';
  $('#v').innerHTML = `<h2>Akun</h2><div class="card mrow">${av(m.nama)}<div><b>${E(m.nama)}</b><br><small>${m.role}${m.kelas ? ' · ' + E(m.kelas) : ''}</small></div></div>` + (g ? `<div class="card"><b>API key Google Gemini</b><p class="mu" style="margin:2px 0 8px">Buat gratis di aistudio.google.com/apikey. ${m.hasKey ? '<span class="ok">Sudah tersedia</span> (isi lagi untuk memakai key pribadi).' : 'Belum diisi.'}</p><input id="ak" type="password" autocomplete="off" placeholder="API key"><label class="f">Model</label><input id="am" value="${E(m.model)}"><button class="btn pri" onclick="saveK()">Simpan</button></div>
<div class="card"><b>Ganti password</b><input id="op" type="password" placeholder="Password lama" autocomplete="current-password" style="margin-top:8px"><input id="np" type="password" placeholder="Password baru (min. 6)" autocomplete="new-password"><button class="btn" onclick="chPw()">Ganti password</button></div>` : '') + '<button class="btn dg blk" onclick="out()">Keluar</button>';
}
function saveK() { run(async () => { await call('saveKey', { key: $('#ak').value.trim(), model: $('#am').value }, 'Menyimpan…'); S.me = await call('me'); toast('Tersimpan'); vAkun(); }); }
function chPw() { run(async () => { await call('pass', { old: $('#op').value, pass: $('#np').value }, 'Menyimpan…'); $('#op').value = ''; $('#np').value = ''; toast('Password diganti'); }); }
init();
