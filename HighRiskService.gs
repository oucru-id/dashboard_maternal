/**
 * MATNEO high-risk monitoring over curated BigQuery read models.
 * Clinical classification stays upstream; this service only filters, aggregates,
 * paginates, and applies the approved active-pregnancy presentation rule.
 */

const HIGH_RISK_MONITORING_STATUSES_ = Object.freeze([
  'ALL', 'ACTIVE_PREGNANCY', 'OVER_42W_NO_OUTCOME',
  'NO_OUTCOME_DATING_UNKNOWN', 'DELIVERED', 'ABORTION', 'OUTCOME_RECORDED'
]);

const HIGH_RISK_ASSESSMENT_STATUSES_ = Object.freeze([
  'ALL', 'URGENT', 'HIGH_RISK', 'CONFLICTING_EVIDENCE',
  'NOT_ASSESSABLE', 'NO_HIGH_RISK_DETECTED'
]);

const HIGH_RISK_FACTOR_FIELDS_ = Object.freeze({
  AGE_LT20: 'risk_age_lt20 IS TRUE',
  AGE_GT35: 'risk_age_gt35 IS TRUE',
  SHORT_STATURE: 'risk_short_stature IS TRUE',
  KEK: 'current_kek IS TRUE',
  ANEMIA: 'current_anemia IS TRUE',
  HYPERTENSION: 'current_hypertension IS TRUE',
  SUSPECT_PREECLAMPSIA: 'current_suspect_preeclampsia IS TRUE',
  HIV: 'risk_hiv IS TRUE',
  SYPHILIS: 'risk_syphilis IS TRUE',
  HEPATITIS_B: 'risk_hepatitis_b IS TRUE',
  UNDERWEIGHT_EARLY_BMI: 'risk_underweight_early_bmi IS TRUE',
  HIGH_PARITY: 'risk_high_parity IS TRUE',
  SHORT_BIRTH_INTERVAL: 'risk_short_birth_interval IS TRUE',
  PLACENTA_PREVIA_REPORTED: 'risk_placenta_previa_reported IS TRUE',
  BREECH_REPORTED: 'risk_breech_reported IS TRUE',
  OTHER_MALPRESENTATION_REPORTED: 'risk_other_malpresentation_reported IS TRUE',
  GESTATIONAL_HYPERTENSION_REPORTED: "diagnosis_hypertensive_risk_code = 'GESTATIONAL_HYPERTENSION_REPORTED'",
  PREECLAMPSIA_REPORTED: "diagnosis_hypertensive_risk_code = 'PREECLAMPSIA_REPORTED'",
  SEVERE_PREECLAMPSIA_REPORTED: "diagnosis_hypertensive_risk_code = 'SEVERE_PREECLAMPSIA_REPORTED'",
  ECLAMPSIA_REPORTED: "diagnosis_hypertensive_risk_code = 'ECLAMPSIA_REPORTED'",
  DIABETES_IN_PREGNANCY_REPORTED: "'DIABETES_IN_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))",
  MULTIPLE_PREGNANCY_REPORTED: "'MULTIPLE_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))",
  UTERINE_SCAR_REPORTED: "'UTERINE_SCAR_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))",
  MALPRESENTATION_REPORTED: "'MALPRESENTATION_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))"
});

const HIGH_RISK_FOLLOW_UPS_ = Object.freeze([
  'ALL', 'PREECLAMPSIA_REASSESSMENT'
]);

const HIGH_RISK_ALERT_TYPES_ = Object.freeze([
  'ABNORMAL_FHR', 'FHR_NOT_DETECTED',
  'FUNDAL_HEIGHT_MISMATCH', 'ABNORMAL_USG_SUSPECTED'
]);

// Operational follow-up starts at 42+0 weeks (294 days) when no outcome is recorded.
const HIGH_RISK_OVERDUE_GA_DAYS_ = 294;

/** Canonical display names for Lombok Barat facilities used as Puskesmas groups. */
const CANONICAL_PUSKESMAS_NAMES_ = Object.freeze({
  banyumulek: 'Puskesmas Banyumulek',
  dasantapen: 'Puskesmas Dasan Tapen',
  eyatmayang: 'Puskesmas Eyat Mayang',
  gerung: 'Puskesmas Gerung',
  gunungsari: 'Puskesmas Gunungsari',
  jembatankembar: 'Puskesmas Jembatan Kembar',
  kediri: 'Puskesmas Kediri',
  kuripan: 'Puskesmas Kuripan',
  labuapi: 'Puskesmas Labuapi',
  lingsar: 'Puskesmas Lingsar',
  meninting: 'Puskesmas Meninting',
  narmada: 'Puskesmas Narmada',
  pelangan: 'Puskesmas Pelangan',
  penimbung: 'Puskesmas Penimbung',
  perampuan: 'Puskesmas Perampuan',
  sedau: 'Puskesmas Sedau',
  sekotong: 'Puskesmas Sekotong',
  sesela: 'Puskesmas Sesela',
  sigerongan: 'Puskesmas Sigerongan',
  suranadi: 'Puskesmas Suranadi',
  patutpatuhpatju: 'RSUD Patut Patuh Patju'
});

function canonicalPuskesmasKey_(value) {
  const compact = String(value || '').trim().toLocaleLowerCase('id-ID')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
  return compact.replace(/^(?:(?:uptd?|blud|puskesmas|pkm|rawatinap|pusatkesehatanmasyarakat|rsud))+/, '');
}

function canonicalPuskesmasName_(value) {
  const original = String(value || '').trim();
  if (!original) return '';
  const key = canonicalPuskesmasKey_(original);
  return CANONICAL_PUSKESMAS_NAMES_[key] || original;
}

function canonicalPuskesmasSql_(expression) {
  const normalized = [
    'REGEXP_REPLACE(',
    '  REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(TRIM(CAST(' + expression + " AS STRING)), NFKD), r'[^a-z0-9]+', ''),",
    "  r'^(?:(?:uptd?|blud|puskesmas|pkm|rawatinap|pusatkesehatanmasyarakat|rsud))+', ''",
    ')'
  ].join('\n');
  const cases = Object.keys(CANONICAL_PUSKESMAS_NAMES_).map(function(key) {
    const name = CANONICAL_PUSKESMAS_NAMES_[key].replace(/'/g, "''");
    return "      WHEN '" + key + "' THEN '" + name + "'";
  });
  return ['CASE ' + normalized].concat(cases).concat([
    '      ELSE TRIM(CAST(' + expression + ' AS STRING))',
    '    END'
  ]).join('\n');
}

function highRiskAppBaseSql_() {
  return [
    'WITH latest_location_date AS (',
    '  SELECT pregnancy_key, MAX(visit_date) AS latest_location_date',
    '  FROM ' + getReadModelPath_('HIGH_RISK_EVIDENCE'),
    '  WHERE pregnancy_key IS NOT NULL AND visit_date IS NOT NULL',
    "    AND care_setting = 'PRIMARY_CARE'",
    "    AND (NULLIF(TRIM(facility_name), '') IS NOT NULL",
    "      OR NULLIF(TRIM(anc_location), '') IS NOT NULL",
    "      OR NULLIF(TRIM(desa), '') IS NOT NULL)",
    '  GROUP BY pregnancy_key',
    '), location_rollup AS (',
    '  SELECT e.pregnancy_key, d.latest_location_date,',
    "    ARRAY_AGG(DISTINCT NULLIF(TRIM(e.facility_name), '') IGNORE NULLS",
    "      ORDER BY NULLIF(TRIM(e.facility_name), '')) AS facility_values,",
    "    ARRAY_AGG(DISTINCT NULLIF(TRIM(e.anc_location), '') IGNORE NULLS",
    "      ORDER BY NULLIF(TRIM(e.anc_location), '')) AS anc_location_values,",
    "    ARRAY_AGG(DISTINCT NULLIF(TRIM(e.desa), '') IGNORE NULLS",
    "      ORDER BY NULLIF(TRIM(e.desa), '')) AS desa_values",
    '  FROM ' + getReadModelPath_('HIGH_RISK_EVIDENCE') + ' e',
    '  JOIN latest_location_date d ON e.pregnancy_key = d.pregnancy_key',
    '    AND e.visit_date = d.latest_location_date',
    "  WHERE e.care_setting = 'PRIMARY_CARE'",
    '  GROUP BY e.pregnancy_key, d.latest_location_date',
    '), location_resolved AS (',
    '  SELECT *,',
    '    ARRAY_LENGTH(facility_values) > 1 AS facility_conflict_flag,',
    '    ARRAY_LENGTH(anc_location_values) > 1 AS anc_location_conflict_flag,',
    '    ARRAY_LENGTH(desa_values) > 1 AS desa_conflict_flag,',
    '    IF(ARRAY_LENGTH(facility_values) = 1, facility_values[SAFE_OFFSET(0)], NULL) AS pregnancy_facility,',
    '    IF(ARRAY_LENGTH(desa_values) = 1, desa_values[SAFE_OFFSET(0)], NULL) AS pregnancy_desa',
    '  FROM location_rollup',
    '), app_base AS (',
    '  SELECT r.*,',
    '    p.nik AS patient_nik, p.nama_pasien AS patient_name,',
    '    p.birth_date AS patient_birth_date, p.phone_number AS patient_phone,',
    '    l.latest_location_date, l.facility_values, l.anc_location_values, l.desa_values,',
    '    IFNULL(l.facility_conflict_flag, FALSE) AS facility_conflict_flag,',
    '    IFNULL(l.anc_location_conflict_flag, FALSE) AS anc_location_conflict_flag,',
    '    IFNULL(l.desa_conflict_flag, FALSE) AS desa_conflict_flag,',
    '    CASE WHEN IFNULL(l.facility_conflict_flag, FALSE) THEN NULL',
    '      ELSE COALESCE(l.pregnancy_facility, p.latest_or_representative_facility) END AS puskesmas_display,',
    '    CASE WHEN IFNULL(l.desa_conflict_flag, FALSE) THEN NULL',
    '      ELSE COALESCE(l.pregnancy_desa, p.latest_or_representative_desa) END AS desa_display,',
    '    CASE WHEN r.canonical_hpht IS NOT NULL THEN',
    "      DATE_DIFF(CURRENT_DATE('Asia/Makassar'), r.canonical_hpht, DAY)",
    '      WHEN r.canonical_hpl IS NOT NULL THEN 280 +',
    "      DATE_DIFF(CURRENT_DATE('Asia/Makassar'), r.canonical_hpl, DAY)",
    '      ELSE NULL END AS current_ga_days,',
    '    CASE WHEN p.birth_date IS NOT NULL',
    '      AND COALESCE(r.canonical_hpht, r.first_anc_date, DATE_SUB(r.canonical_hpl, INTERVAL 280 DAY)) IS NOT NULL THEN',
    '      DATE_DIFF(COALESCE(r.canonical_hpht, r.first_anc_date, DATE_SUB(r.canonical_hpl, INTERVAL 280 DAY)), p.birth_date, YEAR)',
    "      - IF(FORMAT_DATE('%m%d', COALESCE(r.canonical_hpht, r.first_anc_date, DATE_SUB(r.canonical_hpl, INTERVAL 280 DAY)))",
    "        < FORMAT_DATE('%m%d', p.birth_date), 1, 0) ELSE NULL END AS maternal_age_years",
    '  FROM ' + getReadModelPath_('HIGH_RISK') + ' r',
    '  LEFT JOIN ' + getReadModelPath_('PATIENT') + ' p USING (patient_key)',
    '  LEFT JOIN location_resolved l USING (pregnancy_key)',
    '), app_base_final AS (',
    '  SELECT *, FLOOR(current_ga_days / 7) AS current_ga_weeks,',
    "    CASE WHEN canonical_outcome_type = 'DELIVERY' THEN 'DELIVERED'",
    "      WHEN canonical_outcome_type = 'ABORTION' THEN 'ABORTION'",
    "      WHEN canonical_outcome_date IS NOT NULL THEN 'OUTCOME_RECORDED'",
    "      WHEN current_ga_days BETWEEN 0 AND " + (HIGH_RISK_OVERDUE_GA_DAYS_ - 1) + " THEN 'ACTIVE_PREGNANCY'",
    "      WHEN current_ga_days >= " + HIGH_RISK_OVERDUE_GA_DAYS_ + " THEN 'OVER_42W_NO_OUTCOME'",
    "      ELSE 'NO_OUTCOME_DATING_UNKNOWN' END AS pregnancy_monitoring_status,",
    "    CASE current_risk_assessment_status WHEN 'URGENT' THEN 1",
    "      WHEN 'HIGH_RISK' THEN 2 WHEN 'CONFLICTING_EVIDENCE' THEN 3",
    "      WHEN 'NOT_ASSESSABLE' THEN 4 WHEN 'NO_HIGH_RISK_DETECTED' THEN 5 ELSE 9 END AS risk_priority_order,",
    "    CASE WHEN IFNULL(facility_conflict_flag, FALSE) THEN 'LOKASI PERLU VERIFIKASI'",
    "      WHEN NULLIF(TRIM(puskesmas_display), '') IS NULL THEN 'BELUM TERPETAKAN'",
    '      ELSE ' + canonicalPuskesmasSql_('puskesmas_display') + ' END AS puskesmas_group,',
    "    CASE WHEN IFNULL(desa_conflict_flag, FALSE) THEN 'LOKASI PERLU VERIFIKASI'",
    "      WHEN NULLIF(TRIM(desa_display), '') IS NULL THEN 'BELUM TERPETAKAN'",
    '      ELSE desa_display END AS desa_group',
    '  FROM app_base',
    ')'
  ].join('\n');
}

function normalizeHighRiskFilters_(filters) {
  const input = filters || {};
  const monitoringStatus = String(input.monitoringStatus || 'ACTIVE_PREGNANCY').toUpperCase();
  const riskStatus = String(input.riskStatus || 'ALL').toUpperCase();
  const riskFactor = String(input.riskFactor || 'ALL').toUpperCase();
  const clinicalAlert = String(input.clinicalAlert || 'ALL').toUpperCase();
  const followUp = String(input.followUp || 'ALL').toUpperCase();
  const evidencePeriod = String(input.evidencePeriod || 'ALL').toUpperCase();
  if (HIGH_RISK_MONITORING_STATUSES_.indexOf(monitoringStatus) === -1) {
    throw clientSafeError_('Status kehamilan tidak valid.');
  }
  if (HIGH_RISK_ASSESSMENT_STATUSES_.indexOf(riskStatus) === -1) {
    throw clientSafeError_('Status risiko tidak valid.');
  }
  if (riskFactor !== 'ALL' && !HIGH_RISK_FACTOR_FIELDS_[riskFactor]) {
    throw clientSafeError_('Faktor risiko tidak valid.');
  }
  if (clinicalAlert !== 'ALL' && clinicalAlert !== 'ANY' && HIGH_RISK_ALERT_TYPES_.indexOf(clinicalAlert) === -1) {
    throw clientSafeError_('Alert klinis tidak valid.');
  }
  if (HIGH_RISK_FOLLOW_UPS_.indexOf(followUp) === -1) {
    throw clientSafeError_('Filter tindak lanjut tidak valid.');
  }
  if (['ALL', '30D', '3M', '6M', '12M', 'CUSTOM'].indexOf(evidencePeriod) === -1) {
    throw clientSafeError_('Periode evidence tidak valid.');
  }
  const periodStart = normalizeHighRiskDate_(input.periodStart, 'Tanggal mulai');
  const periodEnd = normalizeHighRiskDate_(input.periodEnd, 'Tanggal akhir');
  if (evidencePeriod === 'CUSTOM' && (!periodStart || !periodEnd)) {
    throw clientSafeError_('Tanggal mulai dan akhir wajib diisi untuk periode custom.');
  }
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw clientSafeError_('Tanggal mulai tidak boleh setelah tanggal akhir.');
  }
  return {
    monitoringStatus: monitoringStatus,
    riskStatus: riskStatus,
    riskFactor: riskFactor,
    clinicalAlert: clinicalAlert,
    followUp: followUp,
    evidencePeriod: evidencePeriod,
    periodStart: periodStart,
    periodEnd: periodEnd,
    puskesmas: normalizePuskesmasFilter_(input.puskesmas),
    desa: normalizeOptionalHighRiskFilter_(input.desa)
  };
}

function normalizeHighRiskDate_(value, label) {
  const output = String(value || '').trim();
  if (!output) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(output) || isNaN(new Date(output + 'T00:00:00Z').getTime())) {
    throw clientSafeError_(label + ' tidak valid.');
  }
  return output;
}

function highRiskEvidencePeriodWhere_(filters, params, dateExpression, prefix) {
  const period = filters.evidencePeriod || 'ALL';
  const dateField = dateExpression || 'visit_date';
  const parameterPrefix = prefix || 'hr_period';
  if (period === 'ALL') return 'TRUE';
  if (period === '30D') return dateField + " >= DATE_SUB(CURRENT_DATE('Asia/Makassar'), INTERVAL 29 DAY)";
  if (period === '3M') return dateField + " >= DATE_SUB(CURRENT_DATE('Asia/Makassar'), INTERVAL 3 MONTH)";
  if (period === '6M') return dateField + " >= DATE_SUB(CURRENT_DATE('Asia/Makassar'), INTERVAL 6 MONTH)";
  if (period === '12M') return dateField + " >= DATE_SUB(CURRENT_DATE('Asia/Makassar'), INTERVAL 12 MONTH)";
  params.push(toBQParam_(parameterPrefix + '_start', 'DATE', filters.periodStart));
  params.push(toBQParam_(parameterPrefix + '_end', 'DATE', filters.periodEnd));
  return dateField + ' BETWEEN @' + parameterPrefix + '_start AND @' + parameterPrefix + '_end';
}

function normalizeOptionalHighRiskFilter_(value) {
  const output = String(value || '').trim();
  if (output.length > 200) throw clientSafeError_('Filter lokasi terlalu panjang.');
  return output || null;
}

function normalizePuskesmasFilter_(value) {
  const output = normalizeOptionalHighRiskFilter_(value);
  return output ? canonicalPuskesmasName_(output) : null;
}

function highRiskScopeWhere_(filters, params, includeMonitoring) {
  const where = ['1 = 1'];
  if (includeMonitoring && filters.monitoringStatus !== 'ALL') {
    where.push('pregnancy_monitoring_status = @monitoring_status');
    params.push(toBQParam_('monitoring_status', 'STRING', filters.monitoringStatus));
  }
  if (filters.riskStatus !== 'ALL') {
    where.push('current_risk_assessment_status = @risk_status');
    params.push(toBQParam_('risk_status', 'STRING', filters.riskStatus));
  }
  if (filters.puskesmas) {
    where.push('puskesmas_group = @puskesmas');
    params.push(toBQParam_('puskesmas', 'STRING', filters.puskesmas));
  }
  if (filters.desa) {
    where.push('desa_group = @desa');
    params.push(toBQParam_('desa', 'STRING', filters.desa));
  }
  if (filters.riskFactor !== 'ALL') {
    where.push('(' + HIGH_RISK_FACTOR_FIELDS_[filters.riskFactor] + ')');
  }
  if (filters.clinicalAlert === 'ANY') {
    where.push('current_clinical_alert IS TRUE');
  } else if (filters.clinicalAlert !== 'ALL') {
    where.push('@clinical_alert IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))');
    params.push(toBQParam_('clinical_alert', 'STRING', filters.clinicalAlert));
  }
  if (filters.followUp === 'PREECLAMPSIA_REASSESSMENT') {
    where.push('current_suspect_preeclampsia_reassessment_needed_flag IS TRUE');
  }
  if (filters.evidencePeriod && filters.evidencePeriod !== 'ALL') {
    const periodWhere = highRiskEvidencePeriodWhere_(filters, params, 'evidence_period.visit_date', 'hr_scope_period');
    where.push('pregnancy_key IN (SELECT DISTINCT evidence_period.pregnancy_key FROM ' +
      getReadModelPath_('HIGH_RISK_EVIDENCE') + ' evidence_period WHERE evidence_period.pregnancy_key IS NOT NULL' +
      ' AND evidence_period.visit_date IS NOT NULL AND ' + periodWhere + ')');
  }
  return where.join('\n    AND ');
}

function highRiskMetricColumns_(monitorPredicate) {
  const p = '(' + monitorPredicate + ')';
  return [
    'COUNTIF(' + p + ') AS selected_total',
    "COUNTIF(" + p + " AND current_risk_assessment_status = 'URGENT') AS urgent",
    "COUNTIF(" + p + " AND current_risk_assessment_status = 'HIGH_RISK') AS high_risk",
    "COUNTIF(" + p + " AND current_risk_assessment_status = 'CONFLICTING_EVIDENCE') AS conflicting",
    "COUNTIF(" + p + " AND current_risk_assessment_status = 'NOT_ASSESSABLE') AS not_assessable",
    "COUNTIF(" + p + " AND current_risk_assessment_status = 'NO_HIGH_RISK_DETECTED') AS no_high_risk",
    'COUNTIF(' + p + ' AND current_clinical_alert IS TRUE) AS clinical_alerts',
    'COUNTIF(' + p + ' AND risk_age_lt20 IS TRUE) AS risk_age_lt20',
    'COUNTIF(' + p + ' AND risk_age_gt35 IS TRUE) AS risk_age_gt35',
    'COUNTIF(' + p + ' AND risk_short_stature IS TRUE) AS risk_short_stature',
    'COUNTIF(' + p + ' AND risk_hiv IS TRUE) AS risk_hiv',
    'COUNTIF(' + p + ' AND risk_syphilis IS TRUE) AS risk_syphilis',
    'COUNTIF(' + p + ' AND risk_hepatitis_b IS TRUE) AS risk_hepatitis_b',
    'COUNTIF(' + p + ' AND risk_underweight_early_bmi IS TRUE) AS risk_underweight_early_bmi',
    'COUNTIF(' + p + ' AND risk_high_parity IS TRUE) AS risk_high_parity',
    'COUNTIF(' + p + ' AND risk_short_birth_interval IS TRUE) AS risk_short_birth_interval',
    'COUNTIF(' + p + ' AND risk_placenta_previa_reported IS TRUE) AS risk_placenta_previa_reported',
    'COUNTIF(' + p + ' AND risk_breech_reported IS TRUE) AS risk_breech_reported',
    'COUNTIF(' + p + ' AND risk_other_malpresentation_reported IS TRUE) AS risk_other_malpresentation_reported',
    'COUNTIF(' + p + ' AND ever_anemia IS TRUE) AS ever_anemia',
    'COUNTIF(' + p + ' AND current_anemia IS TRUE) AS current_anemia',
    'COUNTIF(' + p + ' AND current_anemia IS NOT NULL) AS anemia_assessed',
    'COUNTIF(' + p + ' AND ever_hypertension IS TRUE) AS ever_hypertension',
    'COUNTIF(' + p + ' AND current_hypertension IS TRUE) AS current_hypertension',
    'COUNTIF(' + p + ' AND current_hypertension IS NOT NULL) AS hypertension_assessed',
    'COUNTIF(' + p + ' AND ever_kek IS TRUE) AS ever_kek',
    'COUNTIF(' + p + ' AND current_kek IS TRUE) AS current_kek',
    'COUNTIF(' + p + ' AND current_kek IS NOT NULL) AS kek_assessed',
    'COUNTIF(' + p + ' AND ever_suspect_preeclampsia IS TRUE) AS ever_suspect_preeclampsia',
    'COUNTIF(' + p + ' AND current_suspect_preeclampsia IS TRUE) AS current_suspect_preeclampsia',
    'COUNTIF(' + p + ' AND current_suspect_preeclampsia IS NOT NULL) AS suspect_preeclampsia_assessed',
    'COUNTIF(' + p + ' AND current_suspect_preeclampsia_reassessment_needed_flag IS TRUE) AS preeclampsia_reassessment_needed',
    "COUNTIF(" + p + " AND diagnosis_hypertensive_risk_code = 'GESTATIONAL_HYPERTENSION_REPORTED') AS diagnosis_gestational_hypertension",
    "COUNTIF(" + p + " AND diagnosis_hypertensive_risk_code = 'PREECLAMPSIA_REPORTED') AS diagnosis_preeclampsia",
    "COUNTIF(" + p + " AND diagnosis_hypertensive_risk_code = 'SEVERE_PREECLAMPSIA_REPORTED') AS diagnosis_severe_preeclampsia",
    "COUNTIF(" + p + " AND diagnosis_hypertensive_risk_code = 'ECLAMPSIA_REPORTED') AS diagnosis_eclampsia",
    "COUNTIF(" + p + " AND 'DIABETES_IN_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS diagnosis_diabetes_in_pregnancy",
    "COUNTIF(" + p + " AND 'MULTIPLE_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS condition_multiple_pregnancy",
    "COUNTIF(" + p + " AND 'UTERINE_SCAR_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS condition_uterine_scar",
    "COUNTIF(" + p + " AND 'MALPRESENTATION_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS history_malpresentation",
    "COUNTIF(" + p + " AND 'ABNORMAL_FHR' IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))) AS alert_abnormal_fhr",
    "COUNTIF(" + p + " AND 'FHR_NOT_DETECTED' IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))) AS alert_fhr_not_detected",
    "COUNTIF(" + p + " AND 'FUNDAL_HEIGHT_MISMATCH' IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))) AS alert_fundal_mismatch",
    "COUNTIF(" + p + " AND 'ABNORMAL_USG_SUSPECTED' IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))) AS alert_usg_abnormal",
    "COUNTIF(" + p + " AND pregnancy_monitoring_status = 'OVER_42W_NO_OUTCOME') AS over_42w_no_outcome",
    "COUNTIF(" + p + " AND pregnancy_monitoring_status = 'NO_OUTCOME_DATING_UNKNOWN') AS dating_unknown",
    "COUNTIF(" + p + " AND pregnancy_monitoring_status = 'DELIVERED') AS delivered",
    "COUNTIF(" + p + " AND pregnancy_monitoring_status = 'ABORTION') AS abortion",
    'MAX(IF(' + p + ', last_anc_date, NULL)) AS latest_clinical_record_date'
  ].join(',\n    ');
}

function getHighRiskDashboard(token, rawFilters) {
  return runClinicalOperation_('getHighRiskDashboard', function() {
    const access = checkAccess_(token);
    const filters = normalizeHighRiskFilters_(rawFilters);
    const params = [];
    const scopeWhere = highRiskScopeWhere_(filters, params, false);
    let monitorPredicate = 'TRUE';
    if (filters.monitoringStatus !== 'ALL') {
      monitorPredicate = 'pregnancy_monitoring_status = @monitoring_status';
      params.push(toBQParam_('monitoring_status', 'STRING', filters.monitoringStatus));
    }
    const metrics = highRiskMetricColumns_(monitorPredicate);
    const sql = [
      highRiskAppBaseSql_() + ',',
      'scoped AS (SELECT * FROM app_base_final WHERE ' + scopeWhere + ')',
      "SELECT 'TOTAL' AS row_type, CAST(NULL AS STRING) AS puskesmas,",
      '  CAST(NULL AS STRING) AS desa, ' + metrics,
      'FROM scoped',
      'UNION ALL',
      "SELECT 'LOCATION' AS row_type, puskesmas_group AS puskesmas, desa_group AS desa,",
      '  ' + metrics,
      'FROM scoped',
      'GROUP BY puskesmas, desa',
      'ORDER BY row_type DESC, urgent DESC, high_risk DESC, selected_total DESC, puskesmas, desa'
    ].join('\n');
    const rows = queryObjects_(sql, params);
    const total = rows.filter(function(row) { return row.row_type === 'TOTAL'; })[0] || emptyHighRiskMetrics_();
    const locations = rows.filter(function(row) { return row.row_type === 'LOCATION'; });
    logPatientAccess_(access.user, 'OPEN_HIGH_RISK_DASHBOARD', 'HIGH_RISK', null, {
      resultCount: total.selected_total || 0
    });
    return {
      filters: filters,
      summary: total,
      locations: locations,
      generatedAt: new Date().toISOString()
    };
  });
}

function emptyHighRiskMetrics_() {
  return {
    selected_total: 0, urgent: 0, high_risk: 0, conflicting: 0,
    not_assessable: 0, no_high_risk: 0, clinical_alerts: 0,
    ever_suspect_preeclampsia: 0, current_suspect_preeclampsia: 0,
    preeclampsia_reassessment_needed: 0,
    anemia_assessed: 0, hypertension_assessed: 0, kek_assessed: 0,
    suspect_preeclampsia_assessed: 0,
    diagnosis_gestational_hypertension: 0, diagnosis_preeclampsia: 0,
    diagnosis_severe_preeclampsia: 0, diagnosis_eclampsia: 0,
    diagnosis_diabetes_in_pregnancy: 0, condition_multiple_pregnancy: 0,
    condition_uterine_scar: 0, history_malpresentation: 0,
    risk_underweight_early_bmi: 0, risk_high_parity: 0,
    risk_short_birth_interval: 0, risk_placenta_previa_reported: 0,
    risk_breech_reported: 0, risk_other_malpresentation_reported: 0,
    over_42w_no_outcome: 0, dating_unknown: 0, delivered: 0, abortion: 0
  };
}

function getHighRiskLocationOptions(token) {
  return runClinicalOperation_('getHighRiskLocationOptions', function() {
    const access = checkAccess_(token);
    const sql = [
      highRiskAppBaseSql_(),
      'SELECT puskesmas_group AS puskesmas, desa_group AS desa, COUNT(*) AS pregnancy_count',
      'FROM app_base_final',
      'GROUP BY puskesmas, desa',
      'ORDER BY puskesmas, desa'
    ].join('\n');
    const rows = queryObjects_(sql, []);
    logPatientAccess_(access.user, 'LIST_HIGH_RISK_LOCATIONS', 'HIGH_RISK', null, {
      resultCount: rows.length
    });
    return rows;
  });
}

function highRiskSortSql_(sort) {
  const key = String(sort || 'RISK_PRIORITY').toUpperCase();
  const values = {
    RISK_PRIORITY: 'risk_priority_order, canonical_hpl ASC NULLS LAST, last_anc_date DESC NULLS LAST, patient_name',
    HPL_NEAREST: 'canonical_hpl ASC NULLS LAST, risk_priority_order, patient_name',
    ANC_LATEST: 'last_anc_date DESC NULLS LAST, risk_priority_order, patient_name',
    NAME_ASC: 'patient_name, risk_priority_order, canonical_hpl ASC NULLS LAST'
  };
  if (!values[key]) throw clientSafeError_('Urutan daftar tidak valid.');
  return { key: key, sql: values[key] };
}

function getHighRiskPregnancies(token, rawFilters, page, pageSize, sort) {
  return runClinicalOperation_('getHighRiskPregnancies', function() {
    const access = checkAccess_(token);
    const filters = normalizeHighRiskFilters_(rawFilters);
    const pageNumber = Math.max(1, Number(page) || 1);
    const requestedSize = Number(pageSize) || CONFIG.HIGH_RISK_PAGE_SIZE;
    const size = Math.min(CONFIG.HIGH_RISK_MAX_PAGE_SIZE, Math.max(1, requestedSize));
    const offset = (pageNumber - 1) * size;
    const order = highRiskSortSql_(sort);
    const params = [];
    const where = highRiskScopeWhere_(filters, params, true);
    params.push(toBQParam_('page_size', 'INT64', size));
    params.push(toBQParam_('page_offset', 'INT64', offset));
    const sql = [
      highRiskAppBaseSql_(),
      'SELECT pregnancy_key, patient_key, patient_name AS nama_pasien,',
      '  CASE WHEN patient_nik IS NULL THEN NULL WHEN LENGTH(CAST(patient_nik AS STRING)) >= 8',
      "    THEN CONCAT(SUBSTR(CAST(patient_nik AS STRING), 1, 4), '********', SUBSTR(CAST(patient_nik AS STRING), -4))",
      "    ELSE CONCAT(REPEAT('*', GREATEST(LENGTH(CAST(patient_nik AS STRING)) - 2, 0)),",
      '      RIGHT(CAST(patient_nik AS STRING), 2)) END AS nik_masked,',
      '  patient_birth_date AS birth_date, maternal_age_years, canonical_hpht, canonical_hpl, current_ga_weeks,',
      '  first_anc_date, last_anc_date, pregnancy_monitoring_status,',
      '  puskesmas_group, desa_group, facility_conflict_flag, desa_conflict_flag,',
      '  current_risk_assessment_status, current_risk_factor_count, current_risk_factors,',
      '  current_risk_factors_text, ever_risk_factor_count, ever_risk_factors, ever_risk_factors_text,',
      '  risk_underweight_early_bmi, risk_high_parity, risk_short_birth_interval,',
      '  risk_placenta_previa_reported, risk_breech_reported, risk_other_malpresentation_reported,',
      '  current_urgent, current_clinical_alert, current_clinical_alerts_text,',
      '  diagnosis_hypertensive_risk_code, ever_suspect_preeclampsia, current_suspect_preeclampsia,',
      '  current_suspect_preeclampsia_reassessment_needed_flag,',
      '  latest_hb_date, latest_bp_date, latest_lila_date,',
      '  (SELECT MAX(evidence_date) FROM UNNEST([latest_hb_date, latest_bp_date, latest_lila_date]) evidence_date) AS latest_relevant_risk_evidence_date,',
      '  patient_phone IS NOT NULL AND NULLIF(TRIM(CAST(patient_phone AS STRING)), \'\') IS NOT NULL AS has_phone_contact,',
      '  current_risk_conflict_flag, risk_priority_order,',
      '  COUNT(*) OVER() AS total_rows',
      'FROM app_base_final',
      'WHERE ' + where,
      'ORDER BY ' + order.sql,
      'LIMIT @page_size OFFSET @page_offset'
    ].join('\n');
    const rows = queryObjects_(sql, params);
    const totalRows = rows.length ? Number(rows[0].total_rows || 0) : 0;
    rows.forEach(function(row) { delete row.total_rows; });
    logPatientAccess_(access.user, 'LIST_HIGH_RISK_PREGNANCIES', 'HIGH_RISK', null, {
      resultCount: rows.length
    });
    return {
      rows: rows, totalRows: totalRows, page: pageNumber, pageSize: size,
      totalPages: totalRows ? Math.ceil(totalRows / size) : 0, sort: order.key
    };
  });
}

function getHighRiskPregnancyDetail(token, pregnancyKey) {
  return runClinicalOperation_('getHighRiskPregnancyDetail', function() {
    const access = checkAccess_(token);
    const key = validateClinicalKey_(pregnancyKey, 'Pregnancy key');
    const rows = queryObjects_([
      highRiskAppBaseSql_(),
      'SELECT * FROM app_base_final WHERE pregnancy_key = @pregnancy_key LIMIT 1'
    ].join('\n'), [toBQParam_('pregnancy_key', 'STRING', key)]);
    const row = rows.length ? rows[0] : null;
    if (row) {
      row.nik_masked = maskIdentifier_(row.patient_nik || row.nik, 4, 4);
      row.phone_masked = maskIdentifier_(row.patient_phone || row.phone_number, 3, 3);
      delete row.patient_nik;
      delete row.patient_phone;
      delete row.nik;
      delete row.phone_number;
    }
    logPatientAccess_(access.user, 'OPEN_HIGH_RISK_PREGNANCY', 'PREGNANCY', key, {
      resultCount: row ? 1 : 0
    });
    return row;
  });
}

function getHighRiskEvidence(token, pregnancyKey) {
  return runClinicalOperation_('getHighRiskEvidence', function() {
    const access = checkAccess_(token);
    const key = validateClinicalKey_(pregnancyKey, 'Pregnancy key');
    const sql = [
      'SELECT anc_record_id, patient_key, pregnancy_key, visit_date, source_datetime,',
      '  source_system, source_file, facility_name, anc_location, desa,',
      '  risk_anemia, hemoglobin_value, hb_category_raw, hb_category_norm, anemia_severity,',
      '  risk_hypertension, systolic_bp, diastolic_bp, bp_category_raw, bp_category_norm,',
      '  protein_urine_raw, protein_urine_category_norm, protein_urine_measurement_type,',
      '  protein_urine_assessed_flag,',
      '  proteinuria_positive_flag, protein_urine_conflict_flag,',
      '  risk_kek, arm_circumference_value, risk_factors_text, diagnoses',
      'FROM ' + getReadModelPath_('HIGH_RISK_EVIDENCE'),
      'WHERE pregnancy_key = @pregnancy_key',
      'ORDER BY visit_date DESC, source_system, anc_record_id'
    ].join('\n');
    const rows = queryObjects_(sql, [toBQParam_('pregnancy_key', 'STRING', key)]);
    logPatientAccess_(access.user, 'OPEN_HIGH_RISK_EVIDENCE', 'PREGNANCY', key, {
      resultCount: rows.length
    });
    return rows;
  });
}
