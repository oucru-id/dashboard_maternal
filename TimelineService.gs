/** Chronological clinical events over the validated timeline read model only. */

function getTimeline(token, pregnancyKey) {
  return runClinicalOperation_('getTimeline', function() {
    const access = checkAccess_(token);
    const key = validateClinicalKey_(pregnancyKey, 'Pregnancy key');
    const sql = [
      'SELECT timeline_event_id, patient_key, pregnancy_key, event_date, event_type, event_subtype,',
      '  event_label, event_sort_order, facility, desa, gestational_age_weeks,',
      '  systolic_bp, diastolic_bp, body_weight_kg, body_height_cm, lila_cm, hemoglobin_g_dl,',
      '  fundal_height, fhr_category,',
      '  tt_immunization, tt_status_norm, tt_order,',
      '  iron_supplementation, ttd_obtained, mms_obtained,',
      '  counselling, counselling_status_norm,',
      '  ultrasound_obstetric, ultrasound_obstetric_norm,',
      '  mental_health_screening, mental_health_screening_status_norm,',
      '  lab_hiv, lab_hiv_norm, lab_hep_b, lab_hep_b_norm, lab_syphilis, lab_syphilis_norm,',
      '  lab_blood_group, lab_rhesus, lab_12t,',
      '  protein_urine_raw, protein_urine_category_norm, protein_urine_assessed_flag,',
      '  proteinuria_positive_flag, treatment_anemia, treatment_preeclampsia, treatment_kek,',
      '  diagnoses, medications, procedures,',
      '  delivery_mode, delivery_place, newborn_birth_weight_g, pnc_1, pnc_2, pnc_3,',
      '  source_systems, source_record_count, event_status, event_confidence, clinical_use_tier,',
      '  conflict_flag, tt_conflict_flag, ttd_conflict_flag, mms_conflict_flag,',
      '  ttd_negative_invalid_flag, mms_negative_invalid_flag, usg_conflict_flag,',
      '  counselling_conflict_flag, mental_health_conflict_flag, lab_hiv_conflict_flag,',
      '  lab_hep_b_conflict_flag, lab_syphilis_conflict_flag, lab_blood_group_conflict_flag,',
      '  lab_rhesus_conflict_flag, protein_urine_conflict_flag',
      'FROM ' + getReadModelPath_('TIMELINE'),
      'WHERE pregnancy_key = @pregnancy_key',
      'ORDER BY event_date IS NULL, event_date, event_sort_order, timeline_event_id'
    ].join('\n');
    const rows = queryObjects_(sql, [toBQParam_('pregnancy_key', 'STRING', key)]);
    logPatientAccess_(access.user, 'OPEN_TIMELINE', 'PREGNANCY', key, { resultCount: rows.length });
    return rows;
  });
}

function getEventPayload(token, pregnancyKey, timelineEventId) {
  return runClinicalOperation_('getEventPayload', function() {
    const access = checkAccess_(token);
    const pregnancy = validateClinicalKey_(pregnancyKey, 'Pregnancy key');
    const eventId = validateClinicalKey_(timelineEventId, 'Timeline event ID');
    const sql = [
      'SELECT event_payload_json',
      'FROM ' + getReadModelPath_('TIMELINE'),
      'WHERE pregnancy_key = @pregnancy_key AND timeline_event_id = @timeline_event_id',
      'LIMIT 1'
    ].join('\n');
    const rows = queryObjects_(sql, [
      toBQParam_('pregnancy_key', 'STRING', pregnancy),
      toBQParam_('timeline_event_id', 'STRING', eventId)
    ]);
    logPatientAccess_(access.user, 'OPEN_EVENT_PAYLOAD', 'CLINICAL_EVENT', eventId, {
      resultCount: rows.length
    });
    return rows.length ? rows[0].event_payload_json : null;
  });
}
