/** Pregnancy episodes over the validated pregnancy summary read model only. */

function getPregnancies(token, patientKey) {
  return runClinicalOperation_('getPregnancies', function() {
    const access = checkAccess_(token);
    const key = validateClinicalKey_(patientKey, 'Patient key');
    const optionalFields = getOptionalPregnancyFields_();
    const sql = [
      'SELECT pregnancy_key, patient_key, pregnancy_key_origin, pregnancy_resolution_status,',
      '  canonical_hpht, canonical_hpl, first_anc_date, last_anc_date,',
      '  anc_record_count, anc_visit_date_count, source_count, source_systems,',
      '  canonical_outcome_type, canonical_outcome_date, outcome_resolution_status,',
      '  outcome_clinical_use_tier, outcome_clinical_ready_flag, delivered_flag, abortion_flag,',
      '  pnc_1, pnc_2, pnc_3, latest_pnc_date, has_canonical_outcome,',
      '  has_linked_pnc, pnc_summary_available' +
        (optionalFields.length ? ',\n  ' + optionalFields.join(', ') : ''),
      'FROM ' + getReadModelPath_('PREGNANCY'),
      'WHERE patient_key = @patient_key',
      'ORDER BY COALESCE(canonical_outcome_date, last_anc_date, first_anc_date, canonical_hpht, canonical_hpl)',
      '  DESC NULLS LAST'
    ].join('\n');
    const rows = queryObjects_(sql, [toBQParam_('patient_key', 'STRING', key)]);
    logPatientAccess_(access.user, 'LIST_PREGNANCIES', 'PATIENT', key, { resultCount: rows.length });
    return rows;
  });
}

/**
 * GPA fields are optional because they are not part of the validated v1 contract.
 * Only allowlisted columns are added, and metadata failure must never block the
 * base pregnancy list.
 */
function getOptionalPregnancyFields_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'pregnancy_optional_fields_v1';
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      // Refresh a malformed cache value.
    }
  }

  const allowed = {
    gpa: true,
    gravida: true,
    gravidity: true,
    gravida_count: true,
    para: true,
    parity: true,
    para_count: true,
    abortus: true,
    abortus_count: true,
    abortion_count: true,
    abortions: true
  };
  try {
    const informationSchema = '`' + CONFIG.PROJECT_ID + '.' + CONFIG.DATASET_ID + '.INFORMATION_SCHEMA.COLUMNS`';
    const sql = [
      'SELECT column_name',
      'FROM ' + informationSchema,
      'WHERE table_name = @table_name',
      "  AND LOWER(column_name) IN ('gpa', 'gravida', 'gravidity', 'gravida_count',",
      "    'para', 'parity', 'para_count', 'abortus', 'abortus_count',",
      "    'abortion_count', 'abortions')",
      'ORDER BY ordinal_position'
    ].join('\n');
    const rows = queryObjects_(sql, [
      toBQParam_('table_name', 'STRING', CONFIG.READ_MODELS.PREGNANCY)
    ]);
    const fields = rows.map(function(row) {
      return String(row.column_name || '').toLowerCase();
    }).filter(function(field) {
      return allowed[field] === true && /^[a-z][a-z0-9_]*$/.test(field);
    });
    cache.put(cacheKey, JSON.stringify(fields), 21600);
    return fields;
  } catch (error) {
    console.warn(JSON.stringify({
      component: 'pregnancy_optional_fields',
      message: error && error.message ? error.message : String(error)
    }));
    cache.put(cacheKey, '[]', 600);
    return [];
  }
}
