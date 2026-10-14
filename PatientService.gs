/** Patient search over the validated app read model only. */

function patientSelectSql_() {
  return [
    'SELECT patient_key, nik, nama_pasien, birth_date, phone_number,',
    '  latest_or_representative_facility, latest_or_representative_desa,',
    '  pregnancy_count, latest_pregnancy_key, latest_pregnancy_status,',
    '  latest_pregnancy_hpht, latest_pregnancy_hpl, latest_pregnancy_last_anc_date,',
    '  latest_pregnancy_outcome_type, latest_pregnancy_outcome_date,',
    '  patient_resolution_confidence, demographic_conflict_flag',
    'FROM ' + getReadModelPath_('PATIENT')
  ].join('\n');
}

function patientFallbackSortSql_() {
  return [
    'ORDER BY COALESCE(',
    '  latest_pregnancy_outcome_date, latest_pregnancy_last_anc_date,',
    '  latest_pregnancy_hpht, latest_pregnancy_hpl',
    ') DESC NULLS LAST, nama_pasien'
  ].join('\n');
}

function isMissingPatientSearchHelper_(error, helperNames) {
  const message = String(error && error.message ? error.message : error || '');
  return /Unrecognized name/i.test(message) && helperNames.some(function(name) {
    return message.toLowerCase().indexOf(String(name).toLowerCase()) !== -1;
  });
}

function searchPatientByNik_(digits) {
  const params = [toBQParam_('nik', 'STRING', digits)];
  try {
    return queryObjects_([
      patientSelectSql_(),
      'WHERE search_nik = @nik',
      'LIMIT ' + CONFIG.PATIENT_SEARCH_EXACT_LIMIT
    ].join('\n'), params);
  } catch (error) {
    if (!isMissingPatientSearchHelper_(error, ['search_nik'])) throw error;
    console.warn('Patient search fallback: search_nik helper is unavailable.');
    return queryObjects_([
      patientSelectSql_(),
      "WHERE REGEXP_REPLACE(CAST(nik AS STRING), r'[^0-9]', '') = @nik",
      'LIMIT ' + CONFIG.PATIENT_SEARCH_EXACT_LIMIT
    ].join('\n'), params);
  }
}

function searchPatientByName_(input) {
  const params = [toBQParam_('search_name', 'STRING', input)];
  try {
    return queryObjects_([
      patientSelectSql_(),
      'WHERE CONTAINS_SUBSTR(search_name, @search_name)',
      'ORDER BY latest_pregnancy_sort_date DESC NULLS LAST, nama_pasien',
      'LIMIT ' + CONFIG.PATIENT_SEARCH_NAME_LIMIT
    ].join('\n'), params);
  } catch (error) {
    if (!isMissingPatientSearchHelper_(error, ['search_name', 'latest_pregnancy_sort_date'])) throw error;
    console.warn('Patient search fallback: name search or sort helper is unavailable.');
    return queryObjects_([
      patientSelectSql_(),
      'WHERE CONTAINS_SUBSTR(normalized_name, @search_name)',
      patientFallbackSortSql_(),
      'LIMIT ' + CONFIG.PATIENT_SEARCH_NAME_LIMIT
    ].join('\n'), params);
  }
}

function searchPatients(token, query) {
  return runClinicalOperation_('searchPatients', function() {
    const access = checkAccess_(token);
    const input = String(query || '').trim();
    if (input.length < CONFIG.PATIENT_SEARCH_MIN_LENGTH) {
      throw clientSafeError_('Masukkan minimal ' + CONFIG.PATIENT_SEARCH_MIN_LENGTH + ' karakter.');
    }
    if (input.length > CONFIG.PATIENT_SEARCH_MAX_LENGTH) {
      throw clientSafeError_('Kata pencarian terlalu panjang.');
    }

    const digits = input.replace(/\D/g, '');
    const numericLike = digits && digits.length === input.replace(/[\s+()-]/g, '').length;
    let rows = [];
    let searchType = 'NAME';

    if (numericLike) {
      rows = searchPatientByNik_(digits);
      searchType = 'NIK';

      if (!rows.length) {
        rows = queryObjects_([
          patientSelectSql_(),
          'WHERE phone_digits = @phone_digits',
          'LIMIT ' + CONFIG.PATIENT_SEARCH_EXACT_LIMIT
        ].join('\n'), [toBQParam_('phone_digits', 'STRING', digits)]);
        searchType = 'PHONE';
      }
    }

    if (!rows.length && !numericLike) {
      rows = searchPatientByName_(input);
      searchType = 'NAME';
    }

    const results = rows.map(sanitizePatientForClient_);
    logPatientAccess_(access.user, 'SEARCH_PATIENT', 'SEARCH', null, {
      resultCount: results.length,
      searchType: searchType
    });
    return results;
  });
}

function getPatient(token, patientKey) {
  return runClinicalOperation_('getPatient', function() {
    const access = checkAccess_(token);
    const key = validateClinicalKey_(patientKey, 'Patient key');
    const rows = queryObjects_([
      patientSelectSql_(),
      'WHERE patient_key = @patient_key',
      'LIMIT 1'
    ].join('\n'), [toBQParam_('patient_key', 'STRING', key)]);
    const patient = rows.length ? sanitizePatientForClient_(rows[0]) : null;
    logPatientAccess_(access.user, 'OPEN_PATIENT', 'PATIENT', key, { resultCount: patient ? 1 : 0 });
    return patient;
  });
}

function sanitizePatientForClient_(row) {
  return {
    patient_key: row.patient_key,
    nama_pasien: row.nama_pasien || 'Nama tidak tersedia',
    nik_masked: maskIdentifier_(row.nik, 4, 4),
    birth_date: row.birth_date || null,
    phone_masked: maskIdentifier_(row.phone_number, 3, 3),
    latest_or_representative_facility: row.latest_or_representative_facility || null,
    latest_or_representative_desa: row.latest_or_representative_desa || null,
    pregnancy_count: row.pregnancy_count || 0,
    latest_pregnancy_key: row.latest_pregnancy_key || null,
    latest_pregnancy_status: row.latest_pregnancy_status || null,
    latest_pregnancy_hpht: row.latest_pregnancy_hpht || null,
    latest_pregnancy_hpl: row.latest_pregnancy_hpl || null,
    latest_pregnancy_last_anc_date: row.latest_pregnancy_last_anc_date || null,
    latest_pregnancy_outcome_type: row.latest_pregnancy_outcome_type || null,
    latest_pregnancy_outcome_date: row.latest_pregnancy_outcome_date || null,
    patient_resolution_confidence: row.patient_resolution_confidence || null,
    demographic_conflict_flag: row.demographic_conflict_flag === true
  };
}

function maskIdentifier_(value, visibleStart, visibleEnd) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= visibleStart + visibleEnd) return text.replace(/.(?=.{2})/g, '*');
  return text.slice(0, visibleStart) + '*'.repeat(text.length - visibleStart - visibleEnd) + text.slice(-visibleEnd);
}
