/**
 * Population-level pregnancy risk analytics over canonical MATNEO views.
 * Current-state metrics come from the pregnancy-grain view. Time-series and
 * coverage metrics use canonical ANC evidence fields and count pregnancies.
 */

const RISK_ANALYTICS_PERIODS_ = Object.freeze(['30D', '3M', '6M', '12M', 'CUSTOM', 'ALL']);
const RISK_ANALYTICS_FACTORS_ = Object.freeze([
  'ALL', 'AGE_LT20', 'AGE_GT35', 'SHORT_STATURE', 'KEK', 'ANEMIA',
  'HYPERTENSION', 'SUSPECT_PREECLAMPSIA', 'HIV', 'SYPHILIS', 'HEPATITIS_B',
  'UNDERWEIGHT_EARLY_BMI', 'HIGH_PARITY', 'SHORT_BIRTH_INTERVAL',
  'PLACENTA_PREVIA_REPORTED', 'BREECH_REPORTED', 'OTHER_MALPRESENTATION_REPORTED'
]);
const RISK_ANALYTICS_DIAGNOSES_ = Object.freeze({
  ALL: 'TRUE',
  GESTATIONAL_HYPERTENSION_REPORTED: "diagnosis_hypertensive_risk_code = 'GESTATIONAL_HYPERTENSION_REPORTED'",
  PREECLAMPSIA_REPORTED: "diagnosis_hypertensive_risk_code = 'PREECLAMPSIA_REPORTED'",
  SEVERE_PREECLAMPSIA_REPORTED: "diagnosis_hypertensive_risk_code = 'SEVERE_PREECLAMPSIA_REPORTED'",
  ECLAMPSIA_REPORTED: "diagnosis_hypertensive_risk_code = 'ECLAMPSIA_REPORTED'",
  DIABETES_IN_PREGNANCY_REPORTED: "'DIABETES_IN_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))",
  MULTIPLE_PREGNANCY_REPORTED: "'MULTIPLE_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))",
  UTERINE_SCAR_REPORTED: "'UTERINE_SCAR_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))",
  MALPRESENTATION_REPORTED: "'MALPRESENTATION_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))"
});

function normalizeRiskAnalyticsFilters_(rawFilters) {
  const input = rawFilters || {};
  const period = String(input.period || '6M').toUpperCase();
  const monitoringStatus = String(input.monitoringStatus || 'ACTIVE_PREGNANCY').toUpperCase();
  const riskStatus = String(input.riskStatus || 'ALL').toUpperCase();
  const riskFactor = String(input.riskFactor || 'ALL').toUpperCase();
  const diagnosis = String(input.diagnosis || 'ALL').toUpperCase();
  const clinicalAlert = String(input.clinicalAlert || 'ALL').toUpperCase();
  if (RISK_ANALYTICS_PERIODS_.indexOf(period) === -1) throw clientSafeError_('Periode analitik tidak valid.');
  if (HIGH_RISK_MONITORING_STATUSES_.indexOf(monitoringStatus) === -1) throw clientSafeError_('Status kehamilan tidak valid.');
  if (HIGH_RISK_ASSESSMENT_STATUSES_.indexOf(riskStatus) === -1) throw clientSafeError_('Status risiko tidak valid.');
  if (RISK_ANALYTICS_FACTORS_.indexOf(riskFactor) === -1) throw clientSafeError_('Faktor risiko tidak valid.');
  if (!RISK_ANALYTICS_DIAGNOSES_[diagnosis]) throw clientSafeError_('Diagnosis atau kondisi tidak valid.');
  if (clinicalAlert !== 'ALL' && HIGH_RISK_ALERT_TYPES_.indexOf(clinicalAlert) === -1) {
    throw clientSafeError_('Alert klinis tidak valid.');
  }
  const periodStart = normalizeHighRiskDate_(input.periodStart, 'Tanggal mulai');
  const periodEnd = normalizeHighRiskDate_(input.periodEnd, 'Tanggal akhir');
  if (period === 'CUSTOM' && (!periodStart || !periodEnd)) {
    throw clientSafeError_('Tanggal mulai dan akhir wajib diisi untuk periode custom.');
  }
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw clientSafeError_('Tanggal mulai tidak boleh setelah tanggal akhir.');
  }
  return {
    period: period,
    periodStart: periodStart,
    periodEnd: periodEnd,
    monitoringStatus: monitoringStatus,
    riskStatus: riskStatus,
    puskesmas: normalizePuskesmasFilter_(input.puskesmas),
    desa: normalizeOptionalHighRiskFilter_(input.desa),
    riskFactor: riskFactor,
    diagnosis: diagnosis,
    clinicalAlert: clinicalAlert
  };
}

function riskAnalyticsPeriodWhere_(filters, params, dateExpression, prefix) {
  const periodFilters = {
    evidencePeriod: filters.period,
    periodStart: filters.periodStart,
    periodEnd: filters.periodEnd
  };
  return highRiskEvidencePeriodWhere_(periodFilters, params, dateExpression, prefix);
}

function riskAnalyticsBaseSql_(filters, params) {
  const base = highRiskAppBaseSql_();
  if (filters.period === 'ALL') {
    return base + ',\nanalytics_base AS (SELECT * FROM app_base_final)';
  }
  const periodWhere = riskAnalyticsPeriodWhere_(filters, params, 'period_evidence.visit_date', 'analytics_base_period');
  return base + [
    ',\nanalytics_period_pregnancies AS (',
    '  SELECT DISTINCT period_evidence.pregnancy_key',
    '  FROM ' + getReadModelPath_('HIGH_RISK_EVIDENCE') + ' period_evidence',
    '  WHERE period_evidence.pregnancy_key IS NOT NULL',
    '    AND period_evidence.visit_date IS NOT NULL',
    '    AND ' + periodWhere,
    '), analytics_base AS (',
    '  SELECT app_base_final.*',
    '  FROM app_base_final',
    '  JOIN analytics_period_pregnancies USING (pregnancy_key)',
    ')'
  ].join('\n');
}

function riskAnalyticsScopeWhere_(filters, params) {
  const where = ['1 = 1'];
  if (filters.monitoringStatus !== 'ALL') {
    where.push('pregnancy_monitoring_status = @analytics_monitoring_status');
    params.push(toBQParam_('analytics_monitoring_status', 'STRING', filters.monitoringStatus));
  }
  if (filters.riskStatus !== 'ALL') {
    where.push('current_risk_assessment_status = @analytics_risk_status');
    params.push(toBQParam_('analytics_risk_status', 'STRING', filters.riskStatus));
  }
  if (filters.puskesmas) {
    where.push('puskesmas_group = @analytics_puskesmas');
    params.push(toBQParam_('analytics_puskesmas', 'STRING', filters.puskesmas));
  }
  if (filters.desa) {
    where.push('desa_group = @analytics_desa');
    params.push(toBQParam_('analytics_desa', 'STRING', filters.desa));
  }
  if (filters.riskFactor !== 'ALL') where.push('(' + HIGH_RISK_FACTOR_FIELDS_[filters.riskFactor] + ')');
  if (filters.diagnosis !== 'ALL') where.push('(' + RISK_ANALYTICS_DIAGNOSES_[filters.diagnosis] + ')');
  if (filters.clinicalAlert !== 'ALL') {
    where.push('@analytics_alert IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))');
    params.push(toBQParam_('analytics_alert', 'STRING', filters.clinicalAlert));
  }
  return where.join('\n    AND ');
}

function riskAnalyticsBacklogWhere_(filters, params) {
  const where = ['1 = 1'];
  if (filters.puskesmas) {
    where.push('puskesmas_group = @analytics_backlog_puskesmas');
    params.push(toBQParam_('analytics_backlog_puskesmas', 'STRING', filters.puskesmas));
  }
  if (filters.desa) {
    where.push('desa_group = @analytics_backlog_desa');
    params.push(toBQParam_('analytics_backlog_desa', 'STRING', filters.desa));
  }
  return where.join('\n    AND ');
}

function riskAnalyticsScopedSql_(filters, params) {
  return riskAnalyticsBaseSql_(filters, params) + ',\nscoped AS (\n  SELECT * FROM analytics_base WHERE ' +
    riskAnalyticsScopeWhere_(filters, params) + '\n)';
}

function getRiskAnalyticsOverview(token, rawFilters) {
  return runClinicalOperation_('getRiskAnalyticsOverview', function() {
    const access = checkAccess_(token);
    const filters = normalizeRiskAnalyticsFilters_(rawFilters);
    const params = [];
    const scopedSql = riskAnalyticsScopedSql_(filters, params);
    const evidencePeriod = riskAnalyticsPeriodWhere_(filters, params, 'e.visit_date', 'analytics_overview_period');
    const sql = [
      scopedSql + ',',
      'backlog_scope AS (',
      '  SELECT * FROM analytics_base WHERE ' + riskAnalyticsBacklogWhere_(filters, params),
      '),',
      'evidence_scope AS (',
      '  SELECT e.* FROM ' + getReadModelPath_('HIGH_RISK_EVIDENCE') + ' e',
      '  JOIN (SELECT pregnancy_key FROM scoped) s USING (pregnancy_key)',
      '  WHERE e.visit_date IS NOT NULL AND ' + evidencePeriod,
      '), evidence_by_pregnancy AS (',
      '  SELECT pregnancy_key,',
      '    LOGICAL_OR(risk_anemia IS NOT NULL) AS hb_assessed,',
      '    LOGICAL_OR(risk_hypertension IS NOT NULL) AS bp_assessed,',
      '    LOGICAL_OR(risk_kek IS NOT NULL) AS lila_assessed,',
      '    LOGICAL_OR(protein_urine_assessed_flag IS TRUE) AS protein_urine_assessed',
      '  FROM evidence_scope GROUP BY pregnancy_key',
      '), evidence_by_day AS (',
      '  SELECT pregnancy_key, visit_date,',
      '    LOGICAL_OR(risk_hypertension IS NOT NULL) AS bp_assessed,',
      '    LOGICAL_OR(protein_urine_assessed_flag IS TRUE) AS protein_assessed',
      '  FROM evidence_scope GROUP BY pregnancy_key, visit_date',
      '), summary AS (',
      '  SELECT COUNT(*) AS selected_total,',
      "    COUNTIF(current_risk_assessment_status IN ('URGENT', 'HIGH_RISK')) AS high_risk_or_urgent,",
      "    COUNTIF(current_risk_assessment_status = 'HIGH_RISK') AS high_risk,",
      "    COUNTIF(current_risk_assessment_status = 'URGENT') AS urgent,",
      "    COUNTIF(current_risk_assessment_status = 'NOT_ASSESSABLE') AS not_assessable,",
      '    COUNTIF(current_suspect_preeclampsia IS TRUE) AS current_suspect_preeclampsia,',
      '    COUNTIF(current_clinical_alert IS TRUE) AS clinical_alerts,',
      '    COUNTIF(risk_age_gt35 IS TRUE) AS risk_age_gt35,',
      '    COUNTIF(risk_age_lt20 IS TRUE) AS risk_age_lt20,',
      '    COUNTIF(risk_short_stature IS TRUE) AS risk_short_stature,',
      '    COUNTIF(current_anemia IS TRUE) AS current_anemia,',
      '    COUNTIF(current_hypertension IS TRUE) AS current_hypertension,',
      '    COUNTIF(current_kek IS TRUE) AS current_kek,',
      '    COUNTIF(risk_hiv IS TRUE) AS risk_hiv,',
      '    COUNTIF(risk_syphilis IS TRUE) AS risk_syphilis,',
      '    COUNTIF(risk_hepatitis_b IS TRUE) AS risk_hepatitis_b,',
      '    COUNTIF(risk_underweight_early_bmi IS TRUE) AS risk_underweight_early_bmi,',
      '    COUNTIF(risk_high_parity IS TRUE) AS risk_high_parity,',
      '    COUNTIF(risk_short_birth_interval IS TRUE) AS risk_short_birth_interval,',
      '    COUNTIF(risk_placenta_previa_reported IS TRUE) AS risk_placenta_previa_reported,',
      '    COUNTIF(risk_breech_reported IS TRUE) AS risk_breech_reported,',
      '    COUNTIF(risk_other_malpresentation_reported IS TRUE) AS risk_other_malpresentation_reported,',
      '    COUNTIF(ever_anemia IS TRUE) AS ever_anemia,',
      '    COUNTIF(current_anemia IS NOT NULL) AS anemia_assessed,',
      '    COUNTIF(ever_hypertension IS TRUE) AS ever_hypertension,',
      '    COUNTIF(current_hypertension IS NOT NULL) AS hypertension_assessed,',
      '    COUNTIF(ever_kek IS TRUE) AS ever_kek,',
      '    COUNTIF(current_kek IS NOT NULL) AS kek_assessed,',
      '    COUNTIF(ever_suspect_preeclampsia IS TRUE) AS ever_suspect_preeclampsia,',
      '    COUNTIF(current_suspect_preeclampsia IS NOT NULL) AS suspect_preeclampsia_assessed,',
      "    COUNTIF(diagnosis_hypertensive_risk_code = 'GESTATIONAL_HYPERTENSION_REPORTED') AS diagnosis_gestational_hypertension,",
      "    COUNTIF(diagnosis_hypertensive_risk_code = 'PREECLAMPSIA_REPORTED') AS diagnosis_preeclampsia,",
      "    COUNTIF(diagnosis_hypertensive_risk_code = 'SEVERE_PREECLAMPSIA_REPORTED') AS diagnosis_severe_preeclampsia,",
      "    COUNTIF(diagnosis_hypertensive_risk_code = 'ECLAMPSIA_REPORTED') AS diagnosis_eclampsia,",
      "    COUNTIF('DIABETES_IN_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS diagnosis_diabetes_in_pregnancy,",
      "    COUNTIF('MULTIPLE_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS condition_multiple_pregnancy,",
      "    COUNTIF('UTERINE_SCAR_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS condition_uterine_scar,",
      "    COUNTIF('MALPRESENTATION_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS history_malpresentation,",
      "    COUNTIF('ABNORMAL_FHR' IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))) AS alert_abnormal_fhr,",
      "    COUNTIF('FHR_NOT_DETECTED' IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))) AS alert_fhr_not_detected,",
      "    COUNTIF('FUNDAL_HEIGHT_MISMATCH' IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))) AS alert_fundal_mismatch,",
      "    COUNTIF('ABNORMAL_USG_SUSPECTED' IN UNNEST(IFNULL(current_clinical_alerts, CAST([] AS ARRAY<STRING>)))) AS alert_usg_abnormal,",
      "    COUNTIF(diagnosis_hypertensive_risk_code IN ('PREECLAMPSIA_REPORTED', 'SEVERE_PREECLAMPSIA_REPORTED')) AS pe_reported_diagnosis,",
      '    MAX(last_anc_date) AS latest_clinical_record_date',
      '  FROM scoped',
      ')',
      'SELECT summary.*,',
      '  (SELECT COUNTIF(hb_assessed) FROM evidence_by_pregnancy) AS coverage_hb,',
      '  (SELECT COUNTIF(bp_assessed) FROM evidence_by_pregnancy) AS coverage_bp,',
      '  (SELECT COUNTIF(lila_assessed) FROM evidence_by_pregnancy) AS coverage_lila,',
      '  (SELECT COUNTIF(protein_urine_assessed) FROM evidence_by_pregnancy) AS coverage_protein_urine,',
      '  (SELECT COUNT(DISTINCT IF(bp_assessed AND protein_assessed, pregnancy_key, NULL)) FROM evidence_by_day) AS pe_bp_protein_same_day,',
      '  (SELECT COUNT(DISTINCT IF(protein_urine_assessed_flag IS TRUE, pregnancy_key, NULL)) FROM evidence_scope) AS pe_protein_assessed,',
      '  (SELECT COUNT(DISTINCT IF(proteinuria_positive_flag IS TRUE, pregnancy_key, NULL)) FROM evidence_scope) AS pe_protein_positive,',
      "  (SELECT COUNTIF(pregnancy_monitoring_status = 'OVER_42W_NO_OUTCOME') FROM backlog_scope) AS over_42w_no_outcome,",
      "  (SELECT COUNTIF(pregnancy_monitoring_status = 'NO_OUTCOME_DATING_UNKNOWN') FROM backlog_scope) AS dating_unknown,",
      '  (SELECT COUNTIF(current_suspect_preeclampsia_reassessment_needed_flag IS TRUE) FROM backlog_scope) AS preeclampsia_reassessment_needed',
      'FROM summary'
    ].join('\n');
    const rows = queryObjects_(sql, params);
    const summary = rows.length ? rows[0] : {};
    logPatientAccess_(access.user, 'OPEN_RISK_ANALYTICS_OVERVIEW', 'HIGH_RISK_ANALYTICS', null, {
      resultCount: summary.selected_total || 0
    });
    return { filters: filters, summary: summary, generatedAt: new Date().toISOString() };
  });
}

function getRiskAnalyticsTrend(token, rawFilters) {
  return runClinicalOperation_('getRiskAnalyticsTrend', function() {
    const access = checkAccess_(token);
    const filters = normalizeRiskAnalyticsFilters_(rawFilters);
    const params = [];
    const scopedSql = riskAnalyticsScopedSql_(filters, params);
    const periodWhere = riskAnalyticsPeriodWhere_(filters, params, 'e.visit_date', 'analytics_trend_period');
    const sql = [
      scopedSql + ',',
      'evidence_by_day AS (',
      '  SELECT e.pregnancy_key, e.visit_date,',
      "    LOGICAL_OR(NULLIF(TRIM(e.risk_factors_text), '') IS NOT NULL) AS risk_detected,",
      '    LOGICAL_OR(e.risk_anemia IS TRUE) AS anemia,',
      '    LOGICAL_OR(e.risk_hypertension IS TRUE) AS hypertension,',
      '    LOGICAL_OR(e.risk_kek IS TRUE) AS kek,',
      '    LOGICAL_OR(e.proteinuria_positive_flag IS TRUE) AS proteinuria_positive',
      '  FROM ' + getReadModelPath_('HIGH_RISK_EVIDENCE') + ' e',
      '  JOIN (SELECT pregnancy_key FROM scoped) s USING (pregnancy_key)',
      '  WHERE e.visit_date IS NOT NULL AND ' + periodWhere,
      '  GROUP BY e.pregnancy_key, e.visit_date',
      '), monthly AS (',
      '  SELECT DATE_TRUNC(visit_date, MONTH) AS month,',
      '    COUNT(DISTINCT IF(risk_detected, pregnancy_key, NULL)) AS risk_detected,',
      '    COUNT(DISTINCT IF(anemia, pregnancy_key, NULL)) AS anemia,',
      '    COUNT(DISTINCT IF(hypertension, pregnancy_key, NULL)) AS hypertension,',
      '    COUNT(DISTINCT IF(kek, pregnancy_key, NULL)) AS kek,',
      '    COUNT(DISTINCT IF(hypertension AND proteinuria_positive, pregnancy_key, NULL)) AS suspect_preeclampsia',
      '  FROM evidence_by_day GROUP BY month',
      ') SELECT * FROM monthly ORDER BY month'
    ].join('\n');
    const rows = queryObjects_(sql, params);
    logPatientAccess_(access.user, 'OPEN_RISK_ANALYTICS_TREND', 'HIGH_RISK_ANALYTICS', null, {
      resultCount: rows.length
    });
    return { filters: filters, rows: rows, dateBasis: 'Tanggal kunjungan ANC / clinical evidence date' };
  });
}

function getRiskAnalyticsRegional(token, rawFilters) {
  return runClinicalOperation_('getRiskAnalyticsRegional', function() {
    const access = checkAccess_(token);
    const filters = normalizeRiskAnalyticsFilters_(rawFilters);
    const params = [];
    const scopedSql = riskAnalyticsScopedSql_(filters, params);
    const comparisonField = filters.puskesmas ? 'desa_group' : 'puskesmas_group';
    const metricColumns = [
      'COUNT(*) AS denominator',
      "COUNTIF(current_risk_assessment_status = 'HIGH_RISK') AS high_risk",
      'COUNTIF(current_anemia IS TRUE) AS anemia',
      'COUNTIF(current_hypertension IS TRUE) AS hypertension',
      'COUNTIF(current_kek IS TRUE) AS kek',
      'COUNTIF(risk_age_gt35 IS TRUE) AS age_gt35',
      'COUNTIF(risk_age_lt20 IS TRUE) AS age_lt20',
      'COUNTIF(current_suspect_preeclampsia IS TRUE) AS suspect_preeclampsia',
      "COUNTIF('DIABETES_IN_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS diabetes",
      "COUNTIF('MULTIPLE_PREGNANCY_REPORTED' IN UNNEST(IFNULL(ever_risk_factors, CAST([] AS ARRAY<STRING>)))) AS multiple_pregnancy"
    ].join(',\n    ');
    const sql = [
      scopedSql,
      "SELECT 'COMPARISON' AS row_type, " + comparisonField + ' AS region, ' + metricColumns,
      'FROM scoped GROUP BY region',
      'UNION ALL',
      "SELECT 'HEATMAP' AS row_type, puskesmas_group AS region, " + metricColumns,
      'FROM scoped GROUP BY region',
      'ORDER BY row_type, high_risk DESC, denominator DESC, region'
    ].join('\n');
    const rows = queryObjects_(sql, params);
    const comparison = rows.filter(function(row) { return row.row_type === 'COMPARISON'; });
    const heatmap = rows.filter(function(row) { return row.row_type === 'HEATMAP'; });
    logPatientAccess_(access.user, 'OPEN_RISK_ANALYTICS_REGIONAL', 'HIGH_RISK_ANALYTICS', null, {
      resultCount: comparison.length
    });
    return {
      filters: filters,
      comparisonLevel: filters.puskesmas ? 'DESA' : 'PUSKESMAS',
      comparison: comparison,
      heatmap: heatmap,
      attribution: 'Lokasi ANC terbaru'
    };
  });
}
