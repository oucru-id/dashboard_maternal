# Dashboard Maternal - MATNEO Clinical MVP

Google Apps Script web app untuk menelusuri riwayat klinis maternal dengan alur:

```text
Patient -> Pregnancy -> Clinical Event
```

Template login, penggantian password, dan administrasi pengguna tetap dipertahankan. Aplikasi memiliki tiga alur klinis: pencarian pasien beserta timeline, monitoring operasional **Kehamilan Risiko Tinggi** dari Kabupaten sampai BNBA dan detail pregnancy, serta **Analitik Risiko Kehamilan** untuk pola populasi dan drill-down kembali ke BNBA.

## Sumber data yang diizinkan

Aplikasi hanya membaca read model tervalidasi berikut:

- `spheres-lombok-barat.continuum_of_care_matneo.t_matneo_patient_search_v1`
- `spheres-lombok-barat.continuum_of_care_matneo.t_matneo_pregnancy_clinical_summary_v1`
- `spheres-lombok-barat.continuum_of_care_matneo.t_matneo_clinical_timeline_v3`
- `spheres-lombok-barat.continuum_of_care_matneo.v_pregnancy_high_risk_v3`
- `spheres-lombok-barat.continuum_of_care_matneo.v_anc_high_risk_evidence_v2`

Tabel pengguna adalah `spheres-lombok-barat.continuum_of_care_matneo.app_users`. Seluruh query BigQuery berjalan di server Apps Script dan memakai named parameters. Browser tidak menerima kredensial BigQuery.

## Struktur file

- `Code.gs` - entry point, konfigurasi publik, dan bootstrap aplikasi.
- `Config.gs` - konfigurasi dataset, read model, dan batas pencarian.
- `BigQueryService.gs` - eksekusi query, parameter, pagination, dan konversi hasil.
- `Auth.gs` - autentikasi, password hashing, rate limit, dan sesi.
- `UserService.gs` - CRUD pengguna serta field cakupan fasilitas.
- `AuditService.gs` - access hook, error boundary, dan audit akses klinis.
- `PatientService.gs` - pencarian pasien serta masking NIK/telepon.
- `PregnancyService.gs` - daftar episode kehamilan per pasien.
- `TimelineService.gs` - timeline klinis dan payload detail on demand.
- `HighRiskService.gs` - app-base query, status monitoring, agregasi wilayah, BNBA berhalaman, detail risiko, dan evidence.
- `AnalyticsService.gs` - query berparameter untuk overview, tren evidence, distribusi faktor/diagnosis/alert, cakupan penilaian, preeklampsia, dan variasi wilayah.
- `PageMain.html` dan `Scripts.html` - state dan alur UI klinis.
- `PageHighRisk.html`, `ScriptsHighRisk.html`, dan `StylesHighRisk.html` - page monitoring risiko tinggi.
- `PageAnalytics.html`, `ScriptsAnalytics.html`, dan `StylesAnalytics.html` - page analitik risiko populasi dan navigasi ke monitoring operasional.
- `PageAdmin.html` - administrasi pengguna.
- `Styles.html` - design system dan layout responsif.
- `SQL_CreateTables.sql` - DDL alternatif untuk `app_users`.

## Setup awal

1. Buat atau gunakan project Apps Script yang terhubung ke project Google Cloud dengan akses BigQuery yang sesuai.
2. Aktifkan advanced service **BigQuery API** pada Apps Script dan BigQuery API pada Google Cloud project.
3. Pastikan file lokal sudah disalin/push ke project Apps Script.
4. Di **Project Settings > Script Properties**, buat:
   - `BOOTSTRAP_ADMIN_EMAIL`
   - `BOOTSTRAP_ADMIN_PASSWORD` (minimal 10 karakter, mengandung huruf dan angka)
5. Jalankan `setupApplication()` dari editor sebagai pemilik project dan setujui permission yang diminta.

`setupApplication()` membuat `AUTH_PEPPER`, memastikan tabel pengguna tersedia, membuat admin awal, lalu menghapus bootstrap password dari Script Properties. Bila admin tersebut sudah ada dan bootstrap password diisi ulang, fungsi ini mereset password sementaranya.

## Deployment

Deploy sebagai **Web app**:

- Execute as: **Me**
- Who has access: cakupan akun organisasi yang memang perlu memakai aplikasi

Jangan membuka akses anonim. Setelah source berubah, buat deployment version baru; URL `/exec` tidak otomatis memakai file lokal atau perubahan yang belum dideploy.

## Perilaku klinis penting

- Prioritas pencarian: exact NIK, exact normalized phone, lalu name contains.
- NIK dan telepon dimasking oleh server sebelum hasil dikirim ke browser.
- `NO_CANONICAL_OUTCOME` ditampilkan sebagai belum ada luaran kanonik, bukan sedang hamil.
- Satu pasien dapat memiliki lebih dari satu episode kehamilan.
- Timeline memakai event app-facing yang sudah dikurasi; frontend tidak melakukan deduplikasi ANC lagi.
- Profil pasien tetap terlihat saat satu episode kehamilan dan timeline dibuka.
- Ringkasan kehamilan menampilkan usia kehamilan dari ANC terakhir yang memiliki nilai terstruktur. GPA hanya ditampilkan bila read model menyediakan gravida, para, dan abortus.
- Ringkasan pelayanan ANC/12T memakai 12 komponen operasional: BB/TB, tekanan darah, LILA, tinggi fundus, presentasi janin/DJJ, imunisasi Td, tablet tambah darah minimal 90 tablet, laboratorium, tata laksana, konseling, USG minimal 2 kali, serta skrining jiwa/jadwal ulang. Setiap komponen dipetakan ke K1-K6 tanpa membuat ulang keputusan klinis.
- Timeline v3 menyediakan evidence terstruktur untuk imunisasi Td, TTD/MMS, laboratorium (Hb, HIV, sifilis, hepatitis B, golongan darah, rhesus, dan protein urine), tata laksana anemia/preeklamsia/KEK, konseling, USG, serta skrining kesehatan jiwa. Nilai supported yang kosong ditampilkan `Belum tercatat`; `Tidak diperiksa`/`Tidak dilakukan` hanya dipakai untuk status eksplisit. Presentasi janin dan jadwal kunjungan ulang tetap `Data belum tersedia` karena belum didukung.
- Konflik tidak menghapus event. Matriks memakai flag konflik per komponen; `conflict_flag` tetap menjadi peringatan event. UI tidak memilih salah satu nilai secara diam-diam, dan competing values baru dimuat dari `event_payload_json` saat pengguna membuka detail.
- PNC ditampilkan sebagai satu summary dengan flag PNC 1/2/3; aplikasi tidak membuat tanggal PNC individual.
- `event_payload_json` baru diambil ketika pengguna membuka detail event.
- Newborn/neonatal belum menjadi entitas atau halaman dalam MVP ini.
- Kehamilan aktif berarti belum ada luaran delivery/abortion dan usia kehamilan saat ini 0–293 hari, dihitung dengan zona waktu `Asia/Makassar`. Mulai 294 hari (42+0 minggu) masuk status tindak lanjut **≥42 minggu, belum ada luaran**.
- Status risiko, faktor persisten/dinamis, urgent, alert klinis, dan konflik dibaca dari view high-risk; frontend tidak menghitung ulang aturan klinis.
- Alert klinis ditampilkan terpisah dan tidak masuk denominator core high-risk.
- Seluruh kartu, ringkasan faktor, diagnosis, follow-up, tabel wilayah, dan BNBA memakai scope status kehamilan yang sama dengan filter terpilih.
- Daftar BNBA memakai query backend berparameter, pagination server, dan NIK tersamarkan. `patient_key` dan `pregnancy_key` dipertahankan, sedangkan lokasi yang hilang atau konflik tetap ditampilkan.

## Kontrak high-risk V3 production

- `v_pregnancy_high_risk_v3` adalah sumber production canonical satu baris per `pregnancy_key`; frontend tidak mengagregasi ANC untuk menentukan risiko. `v_pregnancy_high_risk_current` tetap dibiarkan utuh sebagai rollback/reference.
- **Berdasarkan Pemeriksaan Terbaru** dan **Pernah Terdeteksi** ditampilkan terpisah.
- `SUSPECT_PREECLAMPSIA` ditampilkan sebagai **Skrining Mengarah ke Preeklampsia**, bukan diagnosis.
- `current_suspect_preeclampsia_reassessment_needed_flag` ditampilkan sebagai **Perlu Penilaian Ulang Preeklampsia** dan tetap terpisah dari status risiko.
- Protein urine mempertahankan status canonical `POSITIVE`, `NEGATIVE`, `NOT_TESTED`, `NOT_RECORDED`, `UNKNOWN`, dan konflik. Data hilang tidak dilabeli negatif.
- Ringkasan faktor hipertensif menampilkan label paling spesifik yang tersedia. Evidence dan diagnosis yang lebih rinci tetap tersedia pada detail pregnancy.
- Diagnosis dan kondisi obstetri ditampilkan pada modul tersendiri; skrining preeklampsia tidak dilabeli sebagai diagnosis.
- Faktor dinamis menampilkan jumlah pernah, terkini, dan sudah dapat dinilai agar evidence yang hilang tidak dianggap normal.
- Tabel lokasi menampilkan N dan persentase terhadap jumlah kehamilan dalam scope, serta diurutkan berdasarkan kebutuhan tindakan.
- BNBA dan detail menampilkan alasan risiko, tanggal evidence relevan, ketersediaan kontak, dan provenance sumber bila tersedia.
- `UTERINE_SCAR_REPORTED` ditampilkan sebagai **Bekas luka uterus**, bukan riwayat seksio sesarea.
- Faktor V3 **BMI awal <18,5**, **Paritas tinggi (≥4)**, **Jarak kehamilan <2 tahun**, **Plasenta previa**, **Presentasi sungsang**, dan **Malpresentasi lain** difilter melalui flag boolean production yang sesuai. Dropdown tidak dibangun hanya dari `current_risk_factors`.
- **Presentasi sungsang** dan **Malpresentasi lain** adalah evidence historis/ever; keberadaannya tidak diartikan sebagai presentasi janin terkini.
- Freshness dashboard ditampilkan dalam WITA bersama tanggal evidence klinis terbaru di scope terpilih.

## Kontrak Analitik Risiko Kehamilan

- Filter periode memilih pregnancy dengan minimal satu evidence ANC pada rentang tanggal tersebut. Metrik berlabel **terkini** tetap membaca current state dari `v_pregnancy_high_risk_v3`.
- Tren berlabel **Deteksi Risiko** memakai `visit_date` dari `v_anc_high_risk_evidence_v2`; halaman tidak menyebutnya prevalensi historis.
- Hitungan dari evidence-level selalu memakai distinct `pregnancy_key`. Faktor yang dapat tumpang tindih ditampilkan sebagai bar/line/heatmap, bukan pie chart.
- Persentase faktor memakai seluruh pregnancy dalam scope; risiko dinamis menampilkan denominator pregnancy yang dapat dinilai. Denominator nol ditampilkan sebagai **Belum dapat dihitung**.
- Lokasi diberi label **Lokasi ANC terbaru**. Memilih satu Puskesmas mengubah perbandingan wilayah menjadi Desa.
- Nama Puskesmas dinormalisasi sebelum agregasi dan filtering. Prefix `PKM`/`Puskesmas`/`UPT(D)`/`BLUD`, spasi, dan variasi ejaan resmi seperti `Gunung Sari`/`Gunungsari` serta `Labu Api`/`Labuapi` tidak membentuk grup terpisah.
- Alur skrining preeklampsia memisahkan assessed, proteinuria positif, penilaian BP+protein pada hari klinis yang sama, screening evidence, dan diagnosis dilaporkan.
- Backlog operasional sengaja mengabaikan filter status kehamilan/status risiko/faktor/diagnosis/alert, tetapi tetap mengikuti periode dan lokasi; pengecualian denominator ini ditulis pada halaman.
- Klik chart membuka BNBA operasional dengan periode, status, lokasi, faktor/diagnosis, atau alert yang relevan tetap dibawa sebagai filter server-side.
- Halaman tidak membuat threshold klinis baru dan tidak membuat object BigQuery permanen.

## Security dan authorization

- Password disimpan sebagai HMAC-SHA256 dengan email ternormalisasi dan `AUTH_PEPPER` rahasia.
- Token sesi acak disimpan di `CacheService`, maksimum 6 jam dan dapat berakhir lebih cepat.
- Semua endpoint klinis memvalidasi sesi di server.
- Admin dapat menyimpan puskesmas, kecamatan, desa, dan ID user sumber. Saat ini field tersebut merupakan hook otorisasi; filtering fasilitas sengaja belum diaktifkan tanpa aturan akses yang disetujui.
- Audit log mencatat actor, action, tipe subject, hash subject key, dan jumlah hasil; kata pencarian dan patient key mentah tidak ditulis ke log.
- Error BigQuery mentah dicatat di server, sedangkan browser menerima pesan klinis generik.

## Acceptance check setelah deploy

Uji dengan akun dan data uji yang sah:

1. Login admin, login pengguna aktif, pengguna nonaktif, dan akun yang tidak terdaftar.
2. Pencarian exact NIK, exact telepon, nama parsial, hasil kosong, dan input invalid.
3. Pasien dengan satu serta beberapa kehamilan.
4. Episode dengan persalinan, abortus, dan tanpa luaran kanonik.
5. ANC dengan `conflict_flag`, lalu buka detail data untuk memastikan payload dimuat on demand.
6. Pastikan profil pasien tetap terlihat pada detail kehamilan, usia kehamilan memakai ANC terakhir yang memiliki nilai, dan matriks ANC membedakan `Belum tercatat`, status eksplisit tidak dilakukan/diperiksa, dua field unsupported, serta konflik per komponen.
7. Episode dengan linked PNC dan pastikan hanya summary PNC 1/2/3 yang tampil.
8. Periksa urutan timeline, undated event di akhir, masking identifier, layout mobile, loading, empty, dan error states.
9. Periksa **Executions / Cloud Logging** untuk audit akses dan error server.
10. Buka **Kehamilan risiko tinggi** dan rekonsiliasi total Kabupaten, Puskesmas, Desa, serta BNBA pada filter yang sama.
11. Periksa status aktif, ≥42 minggu tanpa luaran, dating unknown, urgent, konflik, detail evidence, dan timeline memakai `pregnancy_key` yang sama.
12. Buka **Analitik risiko kehamilan**, uji periode/custom date, seluruh filter, tooltip, toggle jumlah/persentase, drill-down Puskesmas ke Desa, dan klik chart ke BNBA.
13. Rekonsiliasi tren sebagai distinct pregnancy per `visit_date`, bukan prevalensi historis; periksa denominator factor/coverage dan state `Belum dapat dihitung` saat denominator nol.
14. Pada scope semua kehamilan, rekonsiliasi V3: total 33.413; `HIGH_RISK` 11.158; `URGENT` 87; `CONFLICTING_EVIDENCE` 99; `NOT_ASSESSABLE` 68; `NO_HIGH_RISK_DETECTED` 22.001.
15. Rekonsiliasi faktor baru: BMI awal <18,5 = 1.279; plasenta previa = 21; presentasi sungsang = 29; malpresentasi lain = 13; paritas tinggi = 71; jarak kehamilan <2 tahun = 384. Perbedaan harus dijelaskan oleh filter aplikasi yang aktif.

Pemeriksaan lokal memastikan struktur, sintaks, dan rendering dengan mock data. Hasil tersebut belum membuktikan permission BigQuery, deployment version, atau isi read model pada environment live.
