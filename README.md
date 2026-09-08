# Kinan Works

MVP telemetry dashboard untuk perangkat IoT. Runtime aplikasi dan package manager menggunakan Bun; web memakai Svelte + TypeScript + Vite, API memakai Express + TypeScript, Bun SQLite, dan Firebase Admin SDK.

## Batas keamanan dan kontrak data

- Firebase Web config (`VITE_*`) bersifat publik dan hanya dipakai browser untuk Firebase Auth/RTDB realtime listener.
- Service-account JSON dan `ENCRYPTION_KEY_BASE64` hanya dipakai API. Jangan masukkan ke git, image, frontend, atau log. Mount service account read-only melalui `./config/firebase-service-account.json`.
- SQLite di `SQLITE_PATH` adalah sumber kebenaran metadata perangkat, parameter, owner, versi kredensial, dan secret terenkripsi. Mutasi metadata hanya dilakukan API. Telemetry dan Firebase Auth tetap di Firebase.
- `devices/{deviceId}`, `backend/deviceAccess/{deviceId}`, dan `backend/deviceSecrets/{deviceId}` tetap diproyeksikan ke RTDB karena Rules yang sedang terpasang membutuhkannya. API menulis proyeksi sebelum commit SQLite; bila proyeksi gagal, mutasi lokal di-rollback dan request gagal. RTDB bukan sumber pemulihan otomatis setelah migrasi.
- `telemetry/{deviceId}/latest` berisi paket terbaru; `history/{sampleId}` hanya ditulis saat simulator mengirim `history: true`.
- Paket sensor wajib memuat tepat seluruh parameter terdaftar. Reading sehat: `{status:"ok",value:number}`. Sensor gagal: `{status:"error",error:string}`; tidak disubstitusi dengan nol atau nilai lama.
- Database Rules memeriksa isolasi owner/device, parameter tidak dikenal, bentuk reading, device aktif, dan credential version; history bersifat append-only dan paket tidak boleh dihapus. Penggantian latest membutuhkan timestamp meningkat dan `writeId` baru. Rules menilai hasil data, bukan jenis HTTP request: update multipath yang menghasilkan paket valid tetap dapat diterima. Kelengkapan tepat seluruh parameter dinamis divalidasi API, bukan dijamin oleh Rules untuk writer langsung; firmware wajib mengirim paket lengkap.
- Firebase ID token yang sudah terbit tidak dapat dipaksa berubah hanya dengan menaikkan versi di RTDB. Endpoint telemetry memeriksa versi setiap request, Rules mencocokkan claim dengan backend access, dan rotasi/nonaktif mencabut refresh token. Token ID lama bisa tetap ada sampai kedaluwarsa; verifikasi cloud penuh memerlukan emulator/project.

## Prasyarat

- Bun 1.3.14+ untuk menjalankan perintah tanpa Docker, atau Docker dengan Compose.
- Firebase project dengan Email/Password Auth dan Realtime Database.
- Satu akun pengguna Email/Password yang dibuat manual di Firebase Console (`Authentication` → `Users` → `Add user`). Aplikasi tidak menyediakan pendaftaran publik.
- Firebase service account JSON lokal (tidak disimpan di repository).
- Firebase Web config dari Firebase Console.

## Setup lokal dengan Docker

```sh
# hanya jika .env belum ada; jangan timpa konfigurasi lokal
cp -n .env.example .env
mkdir -p config
# simpan service-account JSON sebagai config/firebase-service-account.json
# buat key 32 byte, contoh: bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
# isi .env dengan config Firebase, SQLITE_PATH=/data/kinan.sqlite, dan key lama tersebut
# untuk instalasi yang sudah memiliki metadata RTDB, migrasikan sebelum API dialihkan:
SQLITE_PATH=./data/kinan.sqlite FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json bun run migrate:sqlite
SQLITE_PATH=./data/kinan.sqlite FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json bun run verify:sqlite
docker compose up -d --wait
```

Buka `http://localhost:5173`. API health check: `http://localhost:3000/health`.
Port hanya dibind ke localhost. Compose memakai image resmi Bun yang dipin ke `oven/bun:1.3.14-alpine`, menginstal lockfile ke volume Docker sebelum service dimulai, dan memakai volume source untuk hot reload tanpa Node/npm. Direktori `./config` dimount read-only ke API; service account harus bernama tepat `firebase-service-account.json`. Direktori host `./data` dimount ke `/data` hanya pada API agar database hasil migrasi adalah database runtime yang sama dan tetap ada saat container diganti.

Tanpa konfigurasi Firebase lengkap atau tanpa file service account, mode aman tetap menjalankan web dan health API untuk pemeriksaan lokal: `/health` merespons `200` dengan `{"ok":true,"configured":false}`, sedangkan route API lain merespons `503` dan halaman login menampilkan petunjuk setup dengan kontrol login nonaktif. Setelah konfigurasi dilengkapi, restart dengan `docker compose up -d --wait`.

Perintah operasional:

```sh
docker compose ps
docker compose logs -f api web
docker compose down               # pertahankan volume dependensi
docker compose down --volumes     # hapus volume dependensi; install bersih pada start berikutnya
```

## Setup tanpa Docker

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run dev
```

Gunakan `.env` di root. Bun otomatis membaca `.env`. Untuk mode terkonfigurasi tanpa Docker, ubah `FIREBASE_SERVICE_ACCOUNT_PATH` dan `SQLITE_PATH` ke path lokal yang benar. API menolak startup bila marker migrasi belum ada; ini mencegah database kosong diam-diam. Konfigurasi lengkap tetapi invalid tetap gagal tertutup; konfigurasi yang belum lengkap hanya membuka health/status lokal dan menolak route API lain.

## Migrasi metadata RTDB ke SQLite

Perintah `migrate:sqlite` hanya membaca RTDB dan tidak menghapus atau mengubah cloud. Jika file SQLite sudah ada, perintah membuat backup sibling `kinan.sqlite.backup-<timestamp>` sebelum transaksi. Import mewajibkan set ID `devices`, `backend/deviceAccess`, dan `backend/deviceSecrets` sama, memvalidasi owner/status/version, serta menolak konflik atau dataset lokal campuran tanpa overwrite diam-diam. Menjalankan ulang data yang identik bersifat idempoten. Database cloud kosong ditolak kecuali operator secara eksplisit memberi `--allow-empty`.

```sh
SQLITE_PATH=./data/kinan.sqlite FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json bun run migrate:sqlite
SQLITE_PATH=./data/kinan.sqlite FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json bun run verify:sqlite
```

Jangan mengganti `ENCRYPTION_KEY_BASE64`: ciphertext dipindahkan apa adanya dan tetap membutuhkan key lama. Output hanya berisi count, path database/backup, dan tidak mencetak secret. Setelah verifikasi berhasil, restart API. Selama Rules deployed masih membaca proyeksi RTDB, penghapusan metadata cloud atau perubahan Rules berada di luar migrasi ini.

## Penggunaan

1. Aktifkan Email/Password di Firebase Auth dan buat akun pengguna melalui Firebase Console.
2. Login melalui web memakai akun tersebut.
3. Buat perangkat. ID dihasilkan permanen; label, satuan, dan points 0–10 dapat diedit melalui API. Secret ditampilkan sekali saat create dan dapat direveal ulang melalui endpoint owner dengan `Cache-Control: no-store`.
4. Simulator melakukan device-login ke API, menukar custom token ke Firebase ID/refresh token, lalu menulis langsung ke RTDB: latest setiap 10 detik dan history setiap 60 detik. Satu PATCH atomik memuat latest dan history bila waktunya tiba. Paket berisi `timestamp`, `writeId`, dan `values`; jam perangkat harus akurat (maksimal lima menit di depan server). Set `SIMULATOR_PARAMETER_IDS` sesuai ID permanen yang tampil pada perangkat.

Contoh simulator:

```sh
SIMULATOR_FIREBASE_API_KEY=... \
SIMULATOR_DATABASE_URL=https://YOUR_DATABASE_URL \
SIMULATOR_PARAMETER_IDS=parameter_1,parameter_2 \
SIMULATOR_DEVICE_ID=... \
SIMULATOR_DEVICE_SECRET=... \
SIMULATOR_API_URL=http://localhost:3000 \
bun run --cwd simulator start
```

## Retensi telemetry

Default retensi development adalah 30 hari. Perintah default hanya dry-run dan tidak menghapus cloud data.

```sh
bun run prune:dry
bun run prune:apply # eksplisit menghapus sample lama dari RTDB
bun scripts/prune.ts --device=DEVICE_ID # scope perangkat
```

Tidak ada scheduler atau deployment cloud dalam MVP ini.

## CI dan image produksi

Workflow `.github/workflows/ci.yml` menjalankan install lockfile, typecheck, build, unit test, dan Firebase Rules test dengan Node.js + Java untuk emulator. Pull request hanya membangun image tanpa push. Push ke `main` atau tag `v*` memublikasikan image berikut ke GHCR memakai `GITHUB_TOKEN` bawaan dengan izin `packages:write`:

- `ghcr.io/rchmdndy/kinan_works-api:sha-<commit>`
- `ghcr.io/rchmdndy/kinan_works-web:sha-<commit>`
- Push `main` juga memperbarui tag `latest`; push tag seperti `v1.0.0` juga membuat tag image `v1.0.0`.

Image API adalah bundle Bun production dan membaca seluruh konfigurasi/server credential saat runtime; mount service account read-only, mount `/data` yang persisten, dan jangan memasukkan `.env` atau credential ke image. Image web adalah static nginx pada port `8080`. Karena frontend Vite saat ini membaca konfigurasi saat build, atur **GitHub Actions Variables** berikut (bukan Secrets karena nilainya publik): `VITE_API_URL`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, dan `VITE_FIREBASE_APP_ID`. Nilai kosong tetap menghasilkan halaman aman "belum terkonfigurasi". Mengubah nilai web memerlukan rebuild image; runtime web config sengaja tidak ditambahkan agar kode aplikasi tidak berubah.

Build lokal tanpa mengirim image atau menulis cloud:

```sh
docker build -f api/Dockerfile -t kinan-works-api:local .
docker build -f web/Dockerfile -t kinan-works-web:local \
  --build-arg VITE_API_URL=http://localhost:3000 \
  --build-arg VITE_FIREBASE_API_KEY=replace \
  --build-arg VITE_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT.firebaseapp.com \
  --build-arg VITE_FIREBASE_DATABASE_URL=https://YOUR_PROJECT-default-rtdb.firebaseio.com \
  --build-arg VITE_FIREBASE_PROJECT_ID=YOUR_PROJECT \
  --build-arg VITE_FIREBASE_STORAGE_BUCKET=YOUR_PROJECT.firebasestorage.app \
  --build-arg VITE_FIREBASE_MESSAGING_SENDER_ID=replace \
  --build-arg VITE_FIREBASE_APP_ID=replace .
```

## Tes dan verifikasi

```sh
bun run typecheck
bun run build
# Termasuk Rules emulator; memerlukan Java dan Firebase CLI dependency lokal.
bun run test
# Jalankan hanya Rules pada project demo lokal:
bun run test:rules

# smoke test Compose tanpa kredensial/cloud write
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/api/devices
curl -I http://127.0.0.1:5173/
```

Verifikasi lokal terakhir (7 September 2026): typecheck lulus (termasuk `svelte-check` 0 error/0 warning), build API/web/simulator lulus, 7 unit test API/ekspor/simulator lulus (25 assertion), dan 1 suite Rules pada RTDB emulator nyata lulus. Tes tidak menganggap emulator yang tidak tersedia sebagai sukses. Build web menghasilkan warning chunk sekitar 783 kB (gzip sekitar 258 kB), bukan kegagalan build. Browser hanya diverifikasi pada halaman **belum terkonfigurasi**: heading tampil, petunjuk setup dan akun Firebase Console tampil, serta input email/password dan tombol login nonaktif. Dashboard terautentikasi belum diklaim terverifikasi.

Smoke test Compose mode belum terkonfigurasi menghasilkan web `200`, health API `200` dengan `configured:false`, dan route API `503`. Uji Firebase Rules harus dijalankan menggunakan Emulator Suite; hasil test yang melewati pengujian karena emulator tidak tersedia bukan validasi Rules. Rules tidak dideploy otomatis oleh project ini. Tanpa Firebase config/service account, verifikasi cloud, login Auth nyata, realtime RTDB, dan simulator end-to-end tetap terblokir.

## Ekspor

Dashboard mengambil maksimal 500 sample per request dan menolak ekspor ketika batas tercapai agar data tidak terpotong diam-diam. Rentang menggunakan zona waktu browser, start inklusif dan end eksklusif. Workbook memiliki sheet `Data` (nilai numerik) dan `Informasi` (label, satuan, points, serta catatan bahwa perubahan satuan tidak mengonversi histori).
