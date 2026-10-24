# Kelas Pintar v2

Ruang belajar sekolah (materi, tugas, kuis, LKPD, tanya jawab, nilai, buku paket, soal otomatis dengan Gemini).
Fitur dan alurnya sama dengan versi lama, tetapi arsitekturnya dipisah supaya bisa di-deploy lewat GitHub + Netlify.

```
Browser siswa/guru ──► Netlify (web/: HTML, CSS, JS statis)
        │
        └── fetch JSON ──► Google Apps Script (apps-script/Code.gs) ──► Google Sheet (database)
                                                                   └─► Google Drive (file & video)
```

## Isi repositori

| Path | Fungsi |
|---|---|
| `web/` | Frontend statis yang dihosting di Netlify |
| `web/js/config.js` | Alamat backend (diisi sekali, atau otomatis dari `KP_API_URL`) |
| `apps-script/Code.gs` | Backend API: login, data, upload Drive, Gemini |
| `apps-script/appsscript.json` | Manifest (zona waktu, izin, akses Web App) |
| `netlify.toml`, `build.sh` | Pengaturan deploy Netlify |

## Langkah 1 - Backend (Google Sheet + Apps Script)

1. Buat **Google Sheet baru** (pakai akun Google sekolah/guru yang akan menjadi pemilik data dan file).
2. Menu **Ekstensi > Apps Script**. Hapus isi `Code.gs` bawaan, tempel seluruh isi `apps-script/Code.gs`.
3. (Opsional) Di **Project Settings** centang *Show "appsscript.json" manifest file*, lalu tempel isi `apps-script/appsscript.json`.
4. Pilih fungsi **`setup`** di bar atas, klik **Run**, setujui izin akses (Sheet, Drive, koneksi eksternal).
   Setup membuat tab data, folder Drive `KelasPintar`, kunci rahasia, dan akun admin.
5. Buka **View > Logs** (Execution log). Catat baris `AKUN ADMIN username: admin password: ...`. Password dibuat acak; ganti setelah login pertama.
6. **Deploy > New deployment > Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Salin URL yang berakhiran `/exec`.

> Setiap kali `Code.gs` diubah, buat versi baru: **Deploy > Manage deployments > Edit (ikon pensil) > Version: New version > Deploy**. URL tidak berubah.

## Langkah 2 - GitHub

```bash
git init
git add .
git commit -m "Kelas Pintar v2"
git branch -M main
git remote add origin https://github.com/USERNAME/kelas-pintar.git
git push -u origin main
```

Repositori boleh private. Tidak ada rahasia di dalamnya (kunci rahasia dan API key tersimpan di Script Properties Apps Script).

## Langkah 3 - Netlify

1. Netlify > **Add new site > Import an existing project** > pilih repo GitHub tadi.
2. Pengaturan build terbaca otomatis dari `netlify.toml` (publish folder `web`).
3. **Site configuration > Environment variables**: tambah `KP_API_URL` = URL Web App `/exec` dari Langkah 1.
   (Alternatif: edit langsung `web/js/config.js`, lalu commit.)
4. **Deploy site**. Setiap `git push` berikutnya otomatis memperbarui situs.

## Langkah 4 - Pengaturan awal di aplikasi

Login sebagai admin, lalu:

1. **Admin > Pengaturan**: isi nama sekolah, tempel tautan folder Buku Paket (folder Drive dibagikan "Siapa saja yang memiliki link: Pelihat"), dan (opsional) API key Gemini bersama.
2. **Admin > Kelas**: buat kelas. **Siswa**: impor Excel/CSV. **Pengguna**: tambah guru. **Mapel**: buat mapel.
3. Guru mengisi API key Gemini sendiri di menu **Akun** (atau memakai key bersama dari admin).

## Pengelolaan Google Drive

| Folder (di bawah `KelasPintar/`) | Isi | Dibuat oleh |
|---|---|---|
| `Lampiran Materi` | PDF/foto/dokumen dari guru | upload dari browser (foto dikecilkan otomatis) |
| `Video` | video pembelajaran | browser mengunggah langsung ke Drive (maks 500 MB) |
| `Pengumpulan Siswa` | foto/berkas pekerjaan siswa | upload siswa pada tugas/LKPD |
| folder Buku Paket | buku PDF (folder milik Anda sendiri) | diatur admin lewat Pengaturan |

- ID folder tersimpan otomatis di Script Properties, tidak perlu mengedit kode.
- Menghapus postingan, mapel, atau siswa ikut memindahkan file miliknya ke tempat sampah Drive (tidak ada file yatim).
- File yang dibagikan memakai tautan "siapa saja yang memiliki link" (ID acak, tidak bisa ditebak). Folder `KelasPintar` sendiri tetap privat.
- Kuota gratis Drive 15 GB per akun. Pantau ukuran folder `Video`. Untuk video panjang, tempel tautan YouTube (tidak memakai kuota Drive).

## Migrasi dari versi lama

1. Buka Google Sheet versi lama, tempel `Code.gs` baru, jalankan `setup()`. Kolom baru ditambahkan tanpa menghapus data.
2. Password lama (SHA-256) tetap bisa dipakai dan otomatis ditingkatkan ke format baru saat login pertama.
3. API key Gemini di sheet dipindahkan ke Script Properties dan kolomnya dikosongkan.
4. Postingan dengan file lama tetap terbuka (ID file tidak berubah); file lama tidak ikut dihapus otomatis.
5. Isi ulang folder buku paket di **Admin > Pengaturan** (ID folder tidak lagi ditulis di kode).

## Yang diperbaiki dibanding versi lama

- **Hosting**: frontend terpisah (Netlify/GitHub), tidak lagi bergantung pada `HtmlService`.
- **Sesi**: token bertanda tangan (HMAC) berlaku 24 jam, tidak hilang saat cache Google dibersihkan.
- **Keamanan login**: password berformat salt + pepper server; admin awal berpassword acak; pembatasan percobaan login (6 kali gagal = tunggu 10 menit); ganti password wajib memasukkan password lama.
- **Rahasia**: API key Gemini tidak lagi tersimpan di Sheet (yang bisa dibaca siapa pun yang punya akses Sheet).
- **Kecepatan**: tabel kecil (Users, Mapel, Kelas) di-cache, penambahan data per baris (tanpa membaca ulang semua), hapus baris per blok, rekap nilai memakai indeks, daftar kelas/mapel di-cache di browser, library Excel dimuat hanya saat dibutuhkan.
- **Drive**: folder terstruktur otomatis, ID folder tidak ditulis di kode, ada pembatasan jenis file, file yatim dibersihkan, video hanya diterima jika berada di folder aplikasi.
- **Fitur tambahan kecil**: ubah judul/isi postingan, lampiran foto/berkas pada tugas dan LKPD siswa, unduh rekap nilai CSV, pencarian pengguna di sisi server.

## Batas yang perlu diketahui

- Google Sheet cocok untuk satu sekolah (ratusan siswa). Jika puluhan siswa mengirim jawaban di detik yang sama, sebagian menunggu antrean beberapa detik. Jika sekolah tumbuh jauh lebih besar, pindahkan database ke Supabase/Firebase (struktur API sudah dipisah sehingga hanya `Code.gs` yang perlu diganti).
- Jangan bagikan Google Sheet database ke siapa pun selain pengelola; isinya data siswa.
- Respons pertama setelah lama tidak dipakai bisa 2-4 detik (server Apps Script "bangun"). Setelah itu cepat.
- Fungsi darurat di editor Apps Script: `resetAdminPassword()` (lupa password admin) dan `cabutSemuaSesi()` (paksa semua pengguna login ulang).
