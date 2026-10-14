/** Server-side access hooks and structured audit logging for the clinical MVP. */

function getCurrentUser(token) {
  return publicUser_(requireSession_(token));
}

function checkAccess_(token) {
  let user;
  try {
    user = requireSession_(token);
  } catch (error) {
    // Authentication failures are safe for the client and allow the UI to return to login.
    throw clientSafeError_(error && error.message ? error.message : 'Sesi tidak valid. Silakan masuk kembali.');
  }
  return {
    user: user,
    scope: {
      puskesmas: user.puskesmas || null,
      kecamatan: user.kecamatan || null,
      desa: user.desa || null,
      id_user: user.id_user || null
    }
  };
}

function clientSafeError_(message) {
  const error = new Error(message);
  error.clientSafe = true;
  return error;
}

function runClinicalOperation_(operation, callback) {
  try {
    return callback();
  } catch (error) {
    if (error && error.clientSafe === true) throw error;
    console.error(JSON.stringify({
      severity: 'ERROR',
      component: 'clinical_mvp',
      operation: operation,
      message: error && error.message ? error.message : String(error)
    }));
    throw new Error('Gagal mengambil data klinis. Silakan coba kembali.');
  }
}

function logPatientAccess_(user, action, subjectType, subjectKey, metadata) {
  const safeMetadata = metadata || {};
  console.info(JSON.stringify({
    severity: 'INFO',
    component: 'clinical_access',
    actor: user.email,
    role: user.role,
    action: action,
    subject_type: subjectType || null,
    subject_key_hash: subjectKey ? hashText_(String(subjectKey)).slice(0, 24) : null,
    result_count: safeMetadata.resultCount == null ? null : safeMetadata.resultCount,
    search_type: safeMetadata.searchType || null,
    timestamp: new Date().toISOString()
  }));
}

function validateClinicalKey_(value, label) {
  const key = String(value || '').trim();
  if (!key || key.length > 200) throw clientSafeError_((label || 'Kunci data') + ' tidak valid.');
  return key;
}
