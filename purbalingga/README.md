# Dokumentasi Ringkas — Maternal ANC 12T Pipeline

**BigQuery project:** `stellar-orb-451904-d9`  
**Dataset input:** `dashboard`  
**Dataset output:** `maternal_12t`  
**Arsitektur:** 1 BigQuery Scheduled Query, 3 tabel permanen, 3 view (dibuat sekali).

## Tujuan
Mengintegrasikan kohort ibu hamil dan data kunjungan ANC menjadi episode kehamilan yang konsisten, hasil pemeriksaan 12T terstandardisasi, ringkasan dokumentasi per episode, dan matriks pemeriksaan K1–K6 untuk Looker Studio.

## Sumber data
| Input | Isi |
|---|---|
| `dashboard.kohort_bumil_anc_inc` | Identitas, kehamilan/HPHT-HPL, status persalinan, luaran, risiko |
| `dashboard.temp_kunjungan_ibu_hamil_new_table` | Record kunjungan ANC, K1–K6, nilai pemeriksaan klinis/laboratorium |

## Alur pemrosesan (satu scheduled script)
1. **Ambil data terkini** dari kedua tabel sumber dan buat temporary staging.
2. **Bentuk episode ibu hamil:** normalisasi NIK 16 digit, kunci episode NIK–HPHT; data tak lengkap tetap provisional.
3. **Linkage ANC:** cari kandidat NIK dan HPHT ±14 hari; auto-link hanya pasangan tunggal yang aman dengan HPHT identik/selisih ≤7 hari serta lolos pemeriksaan kronologi. Kandidat lain ditandai untuk review.
4. **Standarisasi 12T:** parsing angka, pengelompokan kategori sumber, flag hasil tidak dilakukan, artefak dan konflik representasi (Hb/USG).
5. **Agregasi per episode:** ringkasan ANC, kehamilan dan dokumentasi 11 komponen (T9 belum tervalidasi).
6. **Matriks 12T:** 12 komponen per kunjungan tertaut → ringkasan per K → pivot K1–K6, riwayat tanggal/sumber dipertahankan.
7. **QA dinamis:** verifikasi episode unik, pelestarian record sumber, kunjungan tertaut ke master, konsistensi jumlah ANC, 12 baris komponen per episode, dan konsistensi matriks.
8. **Publikasi** tiga tabel permanen setelah QA lolos.

## Output permanen (di-refresh harian)
| Objek | Granularitas / kegunaan |
|---|---|
| `maternal_12t.t_visit_clinical` | 1 baris per record kunjungan ANC; hasil klinis ternormalisasi, linkage dan flag |
| `maternal_12t.t_episode_summary` | 1 baris per episode kehamilan; data ibu, luaran, ringkasan ANC dan indeks dokumentasi 11 komponen |
| `maternal_12t.t_matrix_wide` | 12 baris per episode; `history_k1`–`history_k6`, `status_k1`–`status_k6`, jumlah record tiap K |

## View untuk Looker Studio (dibuat sekali, tidak dijadwalkan)
| View | Kegunaan |
|---|---|
| `maternal_12t.v_episode_overview` | Profil ibu dan ringkasan per episode, termasuk usia ibu saat HPHT bila tersedia |
| `maternal_12t.v_dashboard_detail` | Matriks 12T dengan kolom K1–K6 per episode |
| `maternal_12t.v_unclassified_k` | Record ANC tertaut tetapi tidak memiliki kode K1–K6 |

**Kunci integrasi:** `episode_key`. Gunakan `COUNT(DISTINCT episode_key)` untuk metrik jumlah episode pada view detail yang berulang 12 baris per episode.

## Implementasi
1. Jalankan `maternal_12t_daily_refresh_fixed.sql` secara manual; lihat keluaran QA serta bandingkan dengan baseline pipeline lama.
2. Jalankan `maternal_12t_setup_views_once.sql` sebagai **BigQuery job yang terpisah** setelah ketiga tabel ada. Jangan gabungkan dengan skrip yang mendefinisikan temporary UDF; BigQuery melarang view bergantung pada temporary UDF.
3. Setelah validasi berhasil, jadwalkan **hanya** `maternal_12t_daily_refresh_fixed.sql` setiap hari setelah tabel input selesai diperbarui. Gunakan lokasi BigQuery yang sama dengan tabel input.
4. Arahkan Looker Studio ke `v_episode_overview` dan `v_dashboard_detail`. Batasi akses NIK, nomor telepon, dan data klinis.

## Catatan dan keterbatasan
- Jumlah *record* ANC bukan jumlah encounter klinis unik; data lintas sumber masih dapat menggambarkan kunjungan yang sama.
- Indeks dokumentasi 11 komponen bukan skor kepatuhan klinis 12T. T9 tetap `SOURCE_UNVERIFIED`; T5 dan T12 belum mewakili semua subkomponen standar.
- Kasus linkage ambigu, HPHT tidak sesuai, konflik luaran, dan nilai Hb/USG yang berbeda perlu proses review.
- QA **FINAL PASS** sebelumnya berlaku untuk pipeline lama di dataset `dashboard`, bukan bukti bahwa versi gabungan baru telah lolos validasi klinis atau menghasilkan angka yang identik. SQL versi baru harus diuji dan divalidasi sebelum dipakai produksi.
- Scheduled script memakai temporary table (hilang setelah job selesai). Dataset `dashboard` hanya menjadi sumber; seluruh output baru disimpan di `maternal_12t`.

**File operasional:** `maternal_12t_daily_refresh_fixed.sql` (dijadwalkan) dan `maternal_12t_setup_views_once.sql` (setup sekali).