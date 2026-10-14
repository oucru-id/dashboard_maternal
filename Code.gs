/** Entry point dan bootstrap aplikasi. */

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle(CONFIG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getPublicConfig() {
  return {
    appTitle: CONFIG.APP_TITLE,
    appSubtitle: CONFIG.APP_SUBTITLE,
    appVersion: CONFIG.APP_VERSION,
    usersTable: CONFIG.PROJECT_ID + '.' + CONFIG.DATASET_ID + '.' + CONFIG.TABLE_USERS,
    passwordMinLength: CONFIG.PASSWORD_MIN_LENGTH
  };
}

/**
 * Jalankan satu kali dari editor Apps Script oleh pemilik project.
 * Sebelum menjalankan, buat Script Properties:
 * BOOTSTRAP_ADMIN_EMAIL dan BOOTSTRAP_ADMIN_PASSWORD.
 */
function setupApplication() {
  const activeEmail = normalizeEmail_(Session.getActiveUser().getEmail());
  const ownerEmail = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (!activeEmail || !ownerEmail || activeEmail !== ownerEmail) {
    throw new Error('setupApplication hanya boleh dijalankan pemilik project dari editor Apps Script.');
  }

  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('AUTH_PEPPER')) {
    properties.setProperty(
      'AUTH_PEPPER',
      Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '')
    );
  }

  const adminEmail = normalizeEmail_(getScriptPropertyRequired_('BOOTSTRAP_ADMIN_EMAIL'));
  if (!validateEmail_(adminEmail)) throw new Error('BOOTSTRAP_ADMIN_EMAIL tidak valid.');
  const bootstrapPassword = properties.getProperty('BOOTSTRAP_ADMIN_PASSWORD');

  initUsersTable_();
  const existingAdmin = getUserRecordByEmail_(adminEmail, false);
  if (existingAdmin && existingAdmin.role === ROLES.ADMIN && existingAdmin.is_active === true) {
    if (bootstrapPassword) {
      validatePassword_(bootstrapPassword);
      setUserPassword_(adminEmail, bootstrapPassword, true);
      properties.deleteProperty('BOOTSTRAP_ADMIN_PASSWORD');
      return {
        success: true,
        message: 'Penyiapan diperbarui. Kata sandi sementara admin ' + adminEmail + ' telah disetel ulang.'
      };
    }
    properties.deleteProperty('BOOTSTRAP_ADMIN_PASSWORD');
    return { success: true, message: 'Setup sudah tersedia untuk admin ' + adminEmail + '.' };
  }
  if (existingAdmin) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL sudah terdaftar tetapi bukan admin aktif.');
  }

  const adminPassword = getScriptPropertyRequired_('BOOTSTRAP_ADMIN_PASSWORD');
  insertBootstrapAdmin_(adminEmail, adminPassword);
  properties.deleteProperty('BOOTSTRAP_ADMIN_PASSWORD');

  return {
    success: true,
    message: 'Penyiapan selesai. Masuk sebagai ' + adminEmail + ' dan segera ganti kata sandi sementara.'
  };
}
