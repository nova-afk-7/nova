# Senada — Pemutar Musik Offline

Senada adalah aplikasi web yang dapat dipasang di ponsel. File musik, playlist, dan riwayat putar disimpan di penyimpanan lokal browser. Secara opsional, koleksi dapat disinkronkan ke folder data pribadi aplikasi di Google Drive agar bisa digunakan di perangkat lain dengan akun Google yang sama.

## Memulai

1. Publikasikan isi folder ini ke hosting statis yang menggunakan HTTPS.
2. Buka alamat aplikasi di ponsel selagi online, lalu tunggu sampai aplikasi selesai dimuat.
3. Pilih **Unggah musik** untuk menyimpan lagu ke perangkat.
4. Tambahkan aplikasi ke layar utama dari menu browser agar mudah dibuka seperti aplikasi biasa.
5. Setelah itu, lagu dan aplikasi tetap bisa dibuka tanpa koneksi internet.

## Menyiapkan sinkronisasi Google Drive

Sinkronisasi perlu internet. Setelah proses selesai, setiap perangkat menyimpan salinan lagunya sendiri dan dapat memutarnya offline. Senada tidak memakai server milik sendiri; Google Drive menyimpan satu cadangan pribadi aplikasi di folder `appDataFolder`, yang tidak muncul di daftar file Drive biasa.

1. Buat proyek di Google Cloud Console dan aktifkan **Google Drive API**.
2. Siapkan **OAuth consent screen** untuk aplikasi. Jika statusnya *Testing*, tambahkan akun Google yang akan digunakan sebagai test user.
3. Buat OAuth Client ID jenis **Web application**. Tambahkan `https://nova-afk-7.github.io` ke **Authorized JavaScript origins**. Masukkan origin saja, tanpa path `/Senada/`.
4. Salin Client ID ke `google-client-config.js`, mengganti string kosong:

   ```js
   window.SENADA_GOOGLE_CLIENT_ID = "CLIENT_ID_ANDA.apps.googleusercontent.com";
   ```

   Client ID ini adalah pengenal aplikasi publik, bukan client secret. Jangan menaruh client secret di aplikasi browser.
5. Publikasikan ulang folder ini ke hosting HTTPS. Di perangkat pertama, buka Senada saat online dan tekan **Hubungkan Gmail & sinkronkan**, pilih akun Gmail, lalu setujui akses Google Drive. Di perangkat lain, tekan tombol yang sama dan pilih Gmail yang sama. Setelah sinkronisasi berhasil, alamat Gmail yang terhubung akan ditampilkan di tombol dan petunjuknya.

Sinkronisasi menggabungkan lagu, playlist, dan riwayat di perangkat dengan cadangan Drive; penghapusan lagu/playlist juga diterapkan di perangkat lain setelah sinkronisasi. Senada memeriksa alamat Gmail agar perangkat tidak tersambung tanpa sengaja ke akun berbeda. Sinkronkan perangkat satu per satu saat online, bukan bersamaan, agar perubahan terbaru tidak saling menimpa. Jika cadangan berisi banyak atau berkas audio besar, proses unggah/unduh memerlukan waktu dan kuota Drive.

Saat lagu dipilih, Senada membuka tampilan pemutaran khusus dengan ilustrasi gelombang suara yang bergerak mengikuti audio. Buka menu **⋯** di kanan atas untuk memilih **Statistik audio** atau **Equalizer audio**. Equalizer menyediakan slider lima pita frekuensi dan preset Flat, Bass boost, Vokal, serta Treble. Efek Balance menggeser suara ke kiri/kanan; Bass menambah frekuensi rendah; Surround virtual menambah pantulan stereo untuk headphone dan bukan keluaran speaker multi-kanal. Semua pengaturan efek tersimpan di perangkat yang digunakan. Gunakan **Kembali ke koleksi** atau tombol kembali browser untuk kembali ke perpustakaan; pemutar mini tetap tersedia. Statistik audio menampilkan format, ukuran file, durasi, dan perkiraan bitrate rata-rata. Bitrate dihitung dari ukuran file dibagi durasi, sehingga dapat berbeda dari bitrate asli tiap bagian lagu—terutama untuk audio variable bitrate.

Di sebelah kiri kontrol volume, tombol ikon acak dapat membuka empat mode antrean: **Urutan** dari awal koleksi, **Acak** untuk pemilihan acak, **Pengulangan** untuk mengulang lagu yang sedang diputar, dan **Smart Shuffle** untuk memilih lagu acak sambil menghindari lagu yang baru diputar. Mode antrean tersimpan di perangkat.

Service worker membutuhkan HTTPS (atau `localhost`). Membuka `index.html` sebagai file biasa tidak mengaktifkan mode offline. Tanpa Client ID Google yang dikonfigurasi, fitur pemutar musik lokal tetap bisa digunakan, tetapi sinkronisasi Drive belum aktif.
