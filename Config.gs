/** Konfigurasi dasar Dashboard Maternal. */
const CONFIG = Object.freeze({
  APP_TITLE: 'Dashboard Maternal',
  APP_SUBTITLE: 'Riwayat klinis maternal',
  APP_VERSION: '2026.10.05-overdue-detail-resilience',
  PROJECT_ID: 'spheres-lombok-barat',
  DATASET_ID: 'continuum_of_care_matneo',
  TABLE_USERS: 'app_users',
  READ_MODELS: Object.freeze({
    PATIENT: 't_matneo_patient_search_v1',
    PREGNANCY: 't_matneo_pregnancy_clinical_summary_v1',
    TIMELINE: 't_matneo_clinical_timeline_v3',
    HIGH_RISK: 'v_pregnancy_high_risk_v3',
    HIGH_RISK_EVIDENCE: 'v_anc_high_risk_evidence_v2'
  }),
  PATIENT_SEARCH_NAME_LIMIT: 50,
  PATIENT_SEARCH_EXACT_LIMIT: 20,
  PATIENT_SEARCH_MIN_LENGTH: 2,
  PATIENT_SEARCH_MAX_LENGTH: 100,
  HIGH_RISK_PAGE_SIZE: 25,
  HIGH_RISK_MAX_PAGE_SIZE: 100,
  BQ_LOCATION: '',
  TIME_ZONE: 'Asia/Makassar',
  SESSION_TIMEOUT_SECONDS: 21600,
  PASSWORD_MIN_LENGTH: 10,
  MAX_LOGIN_ATTEMPTS: 5,
  LOGIN_LOCK_SECONDS: 900
});

const ROLES = Object.freeze({
  ADMIN: 'admin',
  USER: 'user'
});

function getUsersTablePath_() {
  return '`' + CONFIG.PROJECT_ID + '.' + CONFIG.DATASET_ID + '.' + CONFIG.TABLE_USERS + '`';
}

function getReadModelPath_(modelName) {
  const tableId = CONFIG.READ_MODELS[modelName];
  if (!tableId) throw new Error('Read model tidak dikenal: ' + modelName);
  return '`' + CONFIG.PROJECT_ID + '.' + CONFIG.DATASET_ID + '.' + tableId + '`';
}

function getScriptPropertyRequired_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value || !String(value).trim()) {
    throw new Error('Script Property ' + name + ' belum diatur.');
  }
  return String(value).trim();
}
