-- Membuat tabel pengguna untuk Dashboard Maternal.
-- Project: spheres-lombok-barat
-- Dataset: continuum_of_care_matneo

CREATE TABLE IF NOT EXISTS `spheres-lombok-barat.continuum_of_care_matneo.app_users` (
  email STRING,
  nama STRING,
  password_hash STRING,
  must_change_password BOOLEAN,
  reset_token STRING,
  reset_token_expires TIMESTAMP,
  desa STRING,
  kecamatan STRING,
  puskesmas STRING,
  id_user INTEGER,
  role STRING,
  is_active BOOLEAN,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
