# Budget Keluarga

Aplikasi web (PWA) untuk mencatat pemasukan dan pengeluaran dari HP, langsung ke Google Sheets.

- `index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `sw.js`, `icons/` — tampilan aplikasi (di-host di GitHub Pages).
- `apps-script/Code.gs` — backend, ditempel ke Apps Script milik spreadsheet. File ini tidak dipakai GitHub Pages.

Repo ini tidak berisi data, URL spreadsheet, maupun PIN. URL disimpan di HP; PIN disimpan (ter-hash) di Apps Script.

## Struktur spreadsheet

| Sheet | Kolom |
|---|---|
| Pemasukan | ID, Tanggal, Kategori, Nominal, Rekening, Catatan, Dicatat |
| Pengeluaran | ID, Tanggal, Pos, Kategori, Nominal, Rekening, Catatan, Dicatat |
| Budget | Pos, Kategori, Alert, Rekening Default, Default, lalu kolom bulan `yyyy-MM` (pengecualian untuk bulan itu) |
| Pengaturan | Tanggal mulai siklus, Batas peringatan (%), Email alert, daftar Kategori Pemasukan, daftar Rekening |

Kolom dicari berdasarkan nama header, jadi urutannya boleh diubah dan kolom baru boleh ditambah. Nama header jangan diganti.

## Setup

### A. Backend (sekali, di laptop, ±5 menit)
1. Buka spreadsheet **Budget Keluarga - Transaksi** di Google Sheets.
2. Menu **Ekstensi > Apps Script**. Hapus isi bawaan, tempel seluruh isi `apps-script/Code.gs`, lalu klik ikon simpan.
3. Kembali ke spreadsheet dan muat ulang halaman. Muncul menu **Budget App**.
4. **Budget App > Atur / Ganti PIN**. Pertama kali Google meminta izin: pilih akun Anda > *Advanced / Lanjutan* > *Go to … (unsafe)* > *Allow*. Ini wajar untuk skrip buatan sendiri. Jalankan menu itu sekali lagi dan masukkan PIN 6 angka.
5. Di editor Apps Script: **Deploy > New deployment** > ikon roda gigi > **Web app**.
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
6. Klik **Deploy**, lalu salin **Web app URL** (berakhiran `/exec`).

> "Anyone" berarti alamatnya bisa dihubungi tanpa login Google, tetapi setiap permintaan tetap ditolak tanpa PIN, dan 5 kali salah PIN mengunci aplikasi 15 menit.

### B. Hosting (sekali)
1. Di GitHub: repo ini > **Settings > Pages** > *Source*: **Deploy from a branch** > branch `main`, folder `/ (root)` > **Save**.
2. Tunggu 1–2 menit. Alamat aplikasi: `https://<username>.github.io/<nama-repo>/`.

### C. Di iPhone
1. Buka alamat aplikasi di **Safari** (harus Safari).
2. Tombol **Bagikan** > **Tambah ke Layar Utama** > **Tambah**.
3. Buka dari ikon di layar utama, tempel Web app URL dari langkah A6, lalu masukkan PIN.

## Mengubah sesuatu

| Ingin | Caranya |
|---|---|
| Ganti angka budget | Sheet Budget, kolom `Default` atau kolom bulan |
| Budget khusus satu bulan | Tambah kolom berjudul `yyyy-MM` (misalnya `2027-04`), isi hanya baris yang berbeda |
| Tambah kategori pengeluaran | Tambah baris di sheet Budget |
| Tambah kategori pemasukan / rekening | Sheet Pengaturan, kolom D / F |
| Matikan alert sebuah kategori | Sheet Budget, kolom `Alert` = Tidak |
| Ganti PIN / buka kunci | Menu Budget App di spreadsheet |
| Mengubah `Code.gs` | Setelah menyimpan: **Deploy > Manage deployments > Edit > Version: New version > Deploy** (URL tetap) |

## Catatan perilaku

- Siklus budget mengikuti tanggal gajian (default 25). Siklus 25 Okt – 24 Nov disebut "Nov 2026", sama seperti rencana budget.
- Peringatan muncul saat pemakaian mencapai batas (default 80%) dan saat melewati 100%: di dashboard, sebagai notifikasi saat menyimpan, dan lewat email.
- Aplikasi terkunci setiap dibuka dan setelah ditinggal lebih dari 30 detik. Data tidak disimpan di HP.
