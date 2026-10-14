/** Penyimpanan dan administrasi pengguna di BigQuery. */

function initUsersTable_() {
  const sql = [
    'CREATE TABLE IF NOT EXISTS ' + getUsersTablePath_() + ' (',
    '  email STRING,',
    '  nama STRING,',
    '  password_hash STRING,',
    '  must_change_password BOOLEAN,',
    '  reset_token STRING,',
    '  reset_token_expires TIMESTAMP,',
    '  desa STRING,',
    '  kecamatan STRING,',
    '  puskesmas STRING,',
    '  id_user INTEGER,',
    '  role STRING,',
    '  is_active BOOLEAN,',
    '  created_at TIMESTAMP,',
    '  updated_at TIMESTAMP',
    ')'
  ].join('\n');
  runQuery_(sql);
}

function boolFromBq_(value) {
  return value === true || value === 'true' || value === 'TRUE' || value === 1 || value === '1';
}

function mapUserRow_(row, includeSecrets) {
  if (!row || !row.f) return null;
  const user = {
    email: row.f[0].v,
    nama: row.f[1] ? row.f[1].v : '',
    role: row.f[2].v,
    is_active: boolFromBq_(row.f[3].v),
    must_change_password: boolFromBq_(row.f[4].v),
    created_at: row.f[5] ? row.f[5].v : null,
    updated_at: row.f[6] ? row.f[6].v : null,
    desa: row.f[7] ? row.f[7].v : null,
    kecamatan: row.f[8] ? row.f[8].v : null,
    puskesmas: row.f[9] ? row.f[9].v : null,
    id_user: row.f[10] && row.f[10].v != null ? Number(row.f[10].v) : null
  };
  if (includeSecrets) {
    user.password_hash = row.f[11] ? row.f[11].v : '';
  }
  return user;
}

function getUserRecordByEmail_(email, includeSecrets) {
  const secretFields = includeSecrets ? ', password_hash' : '';
  const sql = [
    'SELECT email, nama, role, is_active, must_change_password,',
    '  FORMAT_TIMESTAMP("%Y-%m-%d %H:%M", created_at, @time_zone),',
    '  FORMAT_TIMESTAMP("%Y-%m-%d %H:%M", updated_at, @time_zone),',
    '  desa, kecamatan, puskesmas, id_user',
    secretFields,
    'FROM ' + getUsersTablePath_(),
    'WHERE LOWER(email) = LOWER(@email)',
    'LIMIT 1'
  ].join('\n');
  const result = runQuery_(sql, [
    toBQParam_('time_zone', 'STRING', CONFIG.TIME_ZONE),
    toBQParam_('email', 'STRING', normalizeEmail_(email))
  ]);
  return result.rows && result.rows.length ? mapUserRow_(result.rows[0], includeSecrets) : null;
}

function listUsers(token) {
  requireAdminSession_(token);
  const sql = [
    'SELECT email, nama, role, is_active, must_change_password,',
    '  FORMAT_TIMESTAMP("%Y-%m-%d %H:%M", created_at, @time_zone),',
    '  FORMAT_TIMESTAMP("%Y-%m-%d %H:%M", updated_at, @time_zone),',
    '  desa, kecamatan, puskesmas, id_user',
    'FROM ' + getUsersTablePath_(),
    'ORDER BY nama, email'
  ].join('\n');
  const result = runQuery_(sql, [toBQParam_('time_zone', 'STRING', CONFIG.TIME_ZONE)]);
  return (result.rows || []).map(function(row) { return mapUserRow_(row, false); });
}

function validateUserInput_(data, isNew) {
  if (!data) throw new Error('Data pengguna tidak ditemukan.');
  if (isNew && !validateEmail_(data.email)) throw new Error('Format email tidak valid.');
  const role = String(data.role || '').toLowerCase();
  if ([ROLES.ADMIN, ROLES.USER].indexOf(role) === -1) throw new Error('Peran tidak valid.');
  if (!String(data.nama || '').trim()) throw new Error('Nama wajib diisi.');
}

function createUser(token, data) {
  requireAdminSession_(token);
  validateUserInput_(data, true);
  validatePassword_(data.temporaryPassword);
  const email = normalizeEmail_(data.email);
  if (getUserRecordByEmail_(email, false)) throw new Error('Email sudah terdaftar.');

  const sql = [
    'INSERT INTO ' + getUsersTablePath_(),
    '(email, nama, password_hash, must_change_password, reset_token, reset_token_expires,',
    ' desa, kecamatan, puskesmas, id_user, role, is_active, created_at, updated_at)',
    'VALUES (@email, @nama, @password_hash, TRUE, NULL, NULL, @desa, @kecamatan, @puskesmas, @id_user,',
    ' @role, @is_active, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())'
  ].join('\n');
  runQuery_(sql, [
    toBQParam_('email', 'STRING', email),
    toBQParam_('nama', 'STRING', String(data.nama).trim()),
    toBQParam_('role', 'STRING', String(data.role).toLowerCase()),
    toBQParam_('is_active', 'BOOL', data.isActive !== false),
    toBQParam_('desa', 'STRING', data.desa || null),
    toBQParam_('kecamatan', 'STRING', data.kecamatan || null),
    toBQParam_('puskesmas', 'STRING', data.puskesmas || null),
    toBQParam_('id_user', 'INT64', data.id_user == null || data.id_user === '' ? null : data.id_user),
    toBQParam_('password_hash', 'STRING', hashPassword_(data.temporaryPassword, email))
  ]);
  return { success: true };
}

function updateUser(token, email, data) {
  const admin = requireAdminSession_(token);
  validateUserInput_(data, false);
  const targetEmail = normalizeEmail_(email);
  if (targetEmail === normalizeEmail_(admin.email) && (data.isActive === false || data.role !== ROLES.ADMIN)) {
    throw new Error('Admin tidak dapat menonaktifkan atau menurunkan peran akunnya sendiri.');
  }
  if (!getUserRecordByEmail_(targetEmail, false)) throw new Error('Pengguna tidak ditemukan.');
  runQuery_([
    'UPDATE ' + getUsersTablePath_(),
    'SET nama = @nama, role = @role, is_active = @is_active,',
    '  desa = @desa, kecamatan = @kecamatan, puskesmas = @puskesmas, id_user = @id_user,',
    '  updated_at = CURRENT_TIMESTAMP()',
    'WHERE LOWER(email) = LOWER(@email)'
  ].join('\n'), [
    toBQParam_('email', 'STRING', targetEmail),
    toBQParam_('nama', 'STRING', String(data.nama).trim()),
    toBQParam_('role', 'STRING', String(data.role).toLowerCase()),
    toBQParam_('is_active', 'BOOL', data.isActive !== false),
    toBQParam_('desa', 'STRING', data.desa || null),
    toBQParam_('kecamatan', 'STRING', data.kecamatan || null),
    toBQParam_('puskesmas', 'STRING', data.puskesmas || null),
    toBQParam_('id_user', 'INT64', data.id_user == null || data.id_user === '' ? null : data.id_user)
  ]);
  return { success: true };
}

function deleteUser(token, email) {
  const admin = requireAdminSession_(token);
  const targetEmail = normalizeEmail_(email);
  if (targetEmail === normalizeEmail_(admin.email)) throw new Error('Admin tidak dapat menghapus akunnya sendiri.');
  runQuery_('DELETE FROM ' + getUsersTablePath_() + ' WHERE LOWER(email) = LOWER(@email)', [
    toBQParam_('email', 'STRING', targetEmail)
  ]);
  return { success: true };
}

function resetUserPassword(token, email, temporaryPassword) {
  requireAdminSession_(token);
  validatePassword_(temporaryPassword);
  const targetEmail = normalizeEmail_(email);
  if (!getUserRecordByEmail_(targetEmail, false)) throw new Error('Pengguna tidak ditemukan.');
  setUserPassword_(targetEmail, temporaryPassword, true);
  return { success: true };
}

function setUserPassword_(email, password, mustChange) {
  const normalizedEmail = normalizeEmail_(email);
  runQuery_([
    'UPDATE ' + getUsersTablePath_(),
    'SET password_hash = @password_hash, must_change_password = @must_change_password,',
    '  reset_token = NULL, reset_token_expires = NULL, updated_at = CURRENT_TIMESTAMP()',
    'WHERE LOWER(email) = LOWER(@email)'
  ].join('\n'), [
    toBQParam_('email', 'STRING', normalizedEmail),
    toBQParam_('password_hash', 'STRING', hashPassword_(password, normalizedEmail)),
    toBQParam_('must_change_password', 'BOOL', mustChange === true)
  ]);
}

function insertBootstrapAdmin_(email, password) {
  if (getUserRecordByEmail_(email, false)) throw new Error('Admin awal sudah terdaftar.');
  validatePassword_(password);
  const normalizedEmail = normalizeEmail_(email);
  runQuery_([
    'INSERT INTO ' + getUsersTablePath_(),
    '(email, nama, password_hash, must_change_password, reset_token, reset_token_expires,',
    ' desa, kecamatan, puskesmas, id_user, role, is_active, created_at, updated_at)',
    'VALUES (@email, @nama, @password_hash, TRUE, NULL, NULL, NULL, NULL, NULL, NULL,',
    ' @role, TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())'
  ].join('\n'), [
    toBQParam_('email', 'STRING', normalizedEmail),
    toBQParam_('nama', 'STRING', 'Administrator'),
    toBQParam_('role', 'STRING', ROLES.ADMIN),
    toBQParam_('password_hash', 'STRING', hashPassword_(password, normalizedEmail))
  ]);
}
