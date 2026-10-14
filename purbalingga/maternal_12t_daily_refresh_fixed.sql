-- Maternal ANC 12T | single daily BigQuery multi-statement scheduled query
-- SOURCE: stellar-orb-451904-d9.dashboard
-- TARGET: stellar-orb-451904-d9.maternal_12t
-- IMPORTANT: run/schedule in EXACTLY the same BigQuery LOCATION as source dataset dashboard.
-- Creates maternal_12t dataset if missing, in the location of this BigQuery job.
-- Produces 3 persistent tables. Dashboard views are created once in a separate query job. TEMP tables disappear.
-- This is a new consolidated pipeline. Validate counts and clinical semantics before production.
-- IMPORTANT: do not concatenate this script with the separate CREATE VIEW script in the same query job.

CREATE SCHEMA IF NOT EXISTS `stellar-orb-451904-d9.maternal_12t`
OPTIONS(description='Maternal ANC 12T integration and dashboard');

CREATE TEMP FUNCTION number_with_unit(raw STRING, units STRING) AS (
  SAFE_CAST(REPLACE(REGEXP_EXTRACT(
    UPPER(TRIM(raw)), CONCAT(r'^(\d{1,3}(?:[.,]\d+)?)\s*(?:', units, r')?\s*$')
  ), ',', '.') AS FLOAT64)
);

CREATE TEMP FUNCTION lab_status(raw STRING) AS (
  CASE
    WHEN raw IS NULL OR UPPER(TRIM(raw)) IN ('', '-') THEN 'NOT_RECORDED'
    WHEN REGEXP_CONTAINS(UPPER(TRIM(raw)), r'TIDAK[\s_]*DIPERIKSA|BELUM[\s_]*DIPERIKSA')
      THEN 'NOT_EXAMINED'
    WHEN REGEXP_CONTAINS(UPPER(TRIM(raw)), r'NON[\s_-]*REAKTIF|NEGATIF|NEGATIVE|(^|[^A-Z])NR([^A-Z]|$)')
      THEN 'NON_REACTIVE'
    WHEN UPPER(TRIM(raw)) = 'R' OR REGEXP_CONTAINS(UPPER(TRIM(raw)), r'POSITIF|POSITIVE|REAKTIF|REACTIVE')
      THEN 'REACTIVE'
    ELSE 'UNMAPPED'
  END
);

-- 1. Read both source tables exactly once per scheduled execution.
CREATE TEMP TABLE src_cohort AS
SELECT c.*, TO_HEX(SHA256(TO_JSON_STRING(c))) AS source_payload_hash,
  REGEXP_REPLACE(COALESCE(TRIM(c.nik), ''), r'[^0-9]', '') AS nik_digits
FROM `stellar-orb-451904-d9.dashboard.kohort_bumil_anc_inc` c;

CREATE TEMP TABLE src_anc AS
SELECT a.*, TO_HEX(SHA256(TO_JSON_STRING(a))) AS source_payload_hash,
  REGEXP_REPLACE(COALESCE(TRIM(a.NIK), ''), r'[^0-9]', '') AS nik_digits
FROM `stellar-orb-451904-d9.dashboard.temp_kunjungan_ibu_hamil_new_table` a;

-- 2. Build episode keys consistently. Provisional records stay separate.
CREATE TEMP TABLE cohort_numbered AS
SELECT c.*,
  ROW_NUMBER() OVER (PARTITION BY source_payload_hash ORDER BY source_payload_hash) AS copy_number
FROM src_cohort c;

CREATE TEMP TABLE cohort_keyed AS
SELECT c.*,
  IF(REGEXP_CONTAINS(nik_digits, r'^[0-9]{16}$'), nik_digits, NULL) AS nik_clean,
  CASE
    WHEN NOT REGEXP_CONTAINS(nik_digits, r'^[0-9]{16}$') THEN 'UNRESOLVED_INVALID_NIK'
    WHEN hpht IS NULL THEN 'UNRESOLVED_MISSING_HPHT'
    ELSE 'RESOLVED_NIK_HPHT'
  END AS episode_resolution_status,
  IF(
    REGEXP_CONTAINS(nik_digits, r'^[0-9]{16}$') AND hpht IS NOT NULL,
    TO_HEX(SHA256(CONCAT(nik_digits, '|', FORMAT_DATE('%F', hpht)))),
    TO_HEX(SHA256(CONCAT('PROVISIONAL|', source_payload_hash, '|', CAST(copy_number AS STRING))))
  ) AS episode_key
FROM cohort_numbered c;

CREATE TEMP TABLE episode_quality AS
SELECT episode_key, COUNT(*) AS cohort_source_rows,
  COUNT(DISTINCT COALESCE(CAST(birth_outcome_date AS STRING), '__NULL__')) AS outcome_date_variants,
  COUNT(DISTINCT COALESCE(NULLIF(UPPER(TRIM(outcome_status)), ''), '__NULL__')) AS outcome_status_variants,
  COUNT(DISTINCT COALESCE(CAST(hpl AS STRING), '__NULL__')) AS hpl_variants
FROM cohort_keyed GROUP BY episode_key;

CREATE TEMP TABLE episode_keys AS
SELECT nik_clean, hpht AS cohort_hpht, episode_key,
  MIN(DATE(birth_outcome_date)) AS earliest_outcome_date,
  COUNT(DISTINCT COALESCE(CAST(birth_outcome_date AS STRING),'__NULL__')) > 1
    OR COUNT(DISTINCT COALESCE(NULLIF(UPPER(TRIM(outcome_status)),''),'__NULL__')) > 1
    AS has_outcome_conflict
FROM cohort_keyed
WHERE episode_resolution_status = 'RESOLVED_NIK_HPHT'
GROUP BY nik_clean, cohort_hpht, episode_key;

CREATE TEMP TABLE episode_base AS
SELECT c.* EXCEPT(copy_number, nik_digits, source_payload_hash),
  c.source_payload_hash AS representative_source_hash,
  q.cohort_source_rows, q.outcome_date_variants, q.outcome_status_variants, q.hpl_variants,
  (q.outcome_date_variants > 1 OR q.outcome_status_variants > 1) AS has_outcome_evidence_conflict
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY episode_key
    ORDER BY IF(birth_outcome_date IS NOT NULL, 0, 1),
             upload_time DESC NULLS LAST, source_payload_hash, copy_number
  ) AS representative_rank
  FROM cohort_keyed
) c
JOIN episode_quality q USING (episode_key)
WHERE c.representative_rank = 1;

-- 3. Compute one candidate per ANC source record, review ambiguous/unsafe links.
CREATE TEMP TABLE anc_numbered AS
SELECT a.*,
  ROW_NUMBER() OVER (PARTITION BY source_payload_hash ORDER BY source_payload_hash) AS copy_number
FROM src_anc a;

CREATE TEMP TABLE anc_prepared AS
SELECT a.*,
  CONCAT(source_payload_hash, ':', CAST(copy_number AS STRING)) AS visit_record_key,
  IF(REGEXP_CONTAINS(nik_digits, r'^[0-9]{16}$'), nik_digits, NULL) AS nik_clean,
  COALESCE(last_menstrual_period, filled_last_menstrual_period) AS anc_hpht,
  (last_menstrual_period IS NULL AND filled_last_menstrual_period IS NOT NULL) AS filled_hpht
FROM anc_numbered a;

CREATE TEMP TABLE anc_candidates AS
SELECT a.*, k.episode_key AS candidate_episode_key, k.cohort_hpht,
  k.earliest_outcome_date, k.has_outcome_conflict,
  ABS(DATE_DIFF(a.anc_hpht, k.cohort_hpht, DAY)) AS hpht_gap_days,
  COUNT(k.episode_key) OVER (PARTITION BY a.visit_record_key) AS candidate_count,
  ROW_NUMBER() OVER (
    PARTITION BY a.visit_record_key
    ORDER BY ABS(DATE_DIFF(a.anc_hpht, k.cohort_hpht, DAY)) NULLS LAST, k.cohort_hpht
  ) AS candidate_rank
FROM anc_prepared a
LEFT JOIN episode_keys k
  ON a.nik_clean = k.nik_clean
 AND a.anc_hpht IS NOT NULL
 AND k.cohort_hpht BETWEEN DATE_SUB(a.anc_hpht, INTERVAL 14 DAY)
                       AND DATE_ADD(a.anc_hpht, INTERVAL 14 DAY);

CREATE TEMP TABLE anc_linked AS
WITH classified AS (
  SELECT c.* EXCEPT(candidate_rank),
    CASE
      WHEN nik_clean IS NULL THEN 'INVALID_NIK'
      WHEN anc_hpht IS NULL THEN 'MISSING_ANC_HPHT'
      WHEN candidate_count = 0 THEN 'NO_HPHT_CANDIDATE_14D'
      WHEN candidate_count > 1 THEN 'AMBIGUOUS_NEARBY_EPISODE'
      WHEN visit_date < cohort_hpht THEN 'VISIT_BEFORE_HPHT'
      WHEN DATE_DIFF(visit_date, cohort_hpht, DAY) > 315 THEN 'VISIT_OVER_45W'
      WHEN has_outcome_conflict THEN 'REVIEW_OUTCOME_CONFLICT'
      WHEN earliest_outcome_date IS NOT NULL AND visit_date > earliest_outcome_date
        THEN 'VISIT_AFTER_OUTCOME'
      WHEN filled_hpht THEN 'REVIEW_FILLED_HPHT'
      WHEN hpht_gap_days = 0 THEN 'AUTO_EXACT_RAW_HPHT'
      WHEN hpht_gap_days <= 7 THEN 'AUTO_7D_RAW_HPHT'
      ELSE 'REVIEW_8_14D'
    END AS linkage_status
  FROM anc_candidates c WHERE candidate_rank = 1
)
SELECT *, linkage_status IN ('AUTO_EXACT_RAW_HPHT', 'AUTO_7D_RAW_HPHT') AS is_auto_linked,
  IF(linkage_status IN ('AUTO_EXACT_RAW_HPHT', 'AUTO_7D_RAW_HPHT'), candidate_episode_key, NULL)
    AS linked_episode_key
FROM classified;

-- 4. Consolidate clinical parsing in ONE transformation (replaces clinical v1 + v2).
CREATE TEMP TABLE visit_parsed AS
SELECT a.*,
  IF(UPPER(TRIM(kunjungan_k)) IN ('K1','K2','K3','K4','K5','K6'), UPPER(TRIM(kunjungan_k)), NULL)
    AS k_visit_standard,
  IF(number_with_unit(body_weight, 'KG|KGS') BETWEEN 20 AND 250,
     number_with_unit(body_weight, 'KG|KGS'), NULL) AS weight_kg,
  IF(number_with_unit(body_height, 'CM') BETWEEN 100 AND 220,
     number_with_unit(body_height, 'CM'), NULL) AS height_cm,
  IF(COALESCE(number_with_unit(systolic_bp, 'MMHG|MM|HG'),
     SAFE_CAST(REGEXP_EXTRACT(TRIM(systolic_bp), r'^(\d{2,3})\s*/\s*\d{2,3}$') AS FLOAT64))
     BETWEEN 60 AND 260,
     COALESCE(number_with_unit(systolic_bp, 'MMHG|MM|HG'),
     SAFE_CAST(REGEXP_EXTRACT(TRIM(systolic_bp), r'^(\d{2,3})\s*/\s*\d{2,3}$') AS FLOAT64)), NULL)
     AS sbp_mmhg,
  IF(COALESCE(number_with_unit(diastolic_bp, 'MMHG|MM|HG'),
     SAFE_CAST(REGEXP_EXTRACT(TRIM(systolic_bp), r'^\d{2,3}\s*/\s*(\d{2,3})$') AS FLOAT64))
     BETWEEN 30 AND 160,
     COALESCE(number_with_unit(diastolic_bp, 'MMHG|MM|HG'),
     SAFE_CAST(REGEXP_EXTRACT(TRIM(systolic_bp), r'^\d{2,3}\s*/\s*(\d{2,3})$') AS FLOAT64)), NULL)
     AS dbp_mmhg,
  IF(COALESCE(arm_circumference_value, number_with_unit(arm_circumference, 'CM')) BETWEEN 10 AND 60,
     COALESCE(arm_circumference_value, number_with_unit(arm_circumference, 'CM')), NULL) AS lila_cm,
  IF(number_with_unit(tinggi_fundus, 'CM') BETWEEN 0 AND 60,
     number_with_unit(tinggi_fundus, 'CM'), NULL) AS tfu_cm,
  IF(number_with_unit(djj, 'BPM|X/MENIT') BETWEEN 60 AND 240,
     number_with_unit(djj, 'BPM|X/MENIT'), NULL) AS djj_bpm,
  IF(number_with_unit(hemoglobin, 'G/DL|GR/DL') BETWEEN 2 AND 25,
     number_with_unit(hemoglobin, 'G/DL|GR/DL'), NULL) AS hb_anc_g_dl,
  IF(number_with_unit(lab_hb, 'G/DL|GR/DL') BETWEEN 2 AND 25,
     number_with_unit(lab_hb, 'G/DL|GR/DL'), NULL) AS hb_lab_g_dl,
  SAFE_CAST(REGEXP_EXTRACT(TRIM(ttd), r'^(\d{1,3})$') AS INT64) AS ttd_count,
  SAFE_CAST(REGEXP_EXTRACT(UPPER(TRIM(vaksin_tt)), r'^TT[\s_]*([0-5])$') AS INT64) AS td_level,
  lab_status(lab_hiv) AS hiv_status,
  lab_status(lab_hep_b) AS hepb_status,
  lab_status(lab_sifilis) AS sifilis_status,
  REGEXP_CONTAINS(UPPER(COALESCE(body_weight,'')), r'\bDAYS?\b') AS weight_duration_artifact,
  REGEXP_CONTAINS(UPPER(COALESCE(body_height,'')), r'\bDAYS?\b') AS height_duration_artifact,
  COALESCE(TRIM(hemoglobin),'') != COALESCE(TRIM(lab_hb),'') AS hb_representation_diff,
  COALESCE(TRIM(usg),'') != COALESCE(TRIM(ultrasound_obstetric),'') AS usg_representation_diff
FROM anc_linked a;

CREATE TEMP TABLE visits_out AS
WITH clinical AS (
  SELECT v.*,
    CASE
      WHEN sbp_mmhg IS NOT NULL AND dbp_mmhg IS NOT NULL THEN 'NUMERIC_COMPLETE'
      WHEN sbp_mmhg IS NOT NULL OR dbp_mmhg IS NOT NULL THEN 'NUMERIC_PARTIAL'
      WHEN REGEXP_CONTAINS(UPPER(CONCAT(COALESCE(systolic_bp,''),' ',COALESCE(diastolic_bp,''))), r'HIPERTENSI') THEN 'SOURCE_HYPERTENSION'
      WHEN REGEXP_CONTAINS(UPPER(CONCAT(COALESCE(systolic_bp,''),' ',COALESCE(diastolic_bp,''))), r'HIPOTENSI') THEN 'SOURCE_HYPOTENSION'
      WHEN REGEXP_CONTAINS(UPPER(CONCAT(COALESCE(systolic_bp,''),' ',COALESCE(diastolic_bp,''))), r'NORMAL') THEN 'SOURCE_NORMAL'
      ELSE 'NOT_ASSESSABLE'
    END AS bp_status,
    CASE
      WHEN lila_cm IS NOT NULL THEN IF(lila_cm < 23.5,'KEK_BY_LILA','NON_KEK_BY_LILA')
      WHEN REGEXP_CONTAINS(UPPER(COALESCE(arm_circumference,'')), r'TIDAK KEK|^NORMAL$') THEN 'SOURCE_NON_KEK'
      WHEN REGEXP_CONTAINS(UPPER(COALESCE(arm_circumference,'')), r'RISIKO.*KEK|RISIKO.*ENERGI') THEN 'SOURCE_RISK_KEK'
      WHEN REGEXP_CONTAINS(UPPER(COALESCE(arm_circumference,'')), r'KEK') THEN 'SOURCE_KEK'
      ELSE 'NOT_ASSESSABLE'
    END AS lila_status,
    CASE
      WHEN tfu_cm IS NOT NULL THEN 'NUMERIC'
      WHEN UPPER(TRIM(COALESCE(tinggi_fundus,''))) LIKE 'TIDAK SESUAI%' THEN 'SOURCE_NOT_APPROPRIATE'
      WHEN UPPER(TRIM(COALESCE(tinggi_fundus,''))) LIKE 'SESUAI USIA%' THEN 'SOURCE_APPROPRIATE'
      ELSE 'NOT_ASSESSABLE'
    END AS tfu_status,
    CASE
      WHEN djj_bpm IS NOT NULL THEN 'NUMERIC'
      WHEN UPPER(COALESCE(djj,'')) LIKE '%TIDAK DIPERIKSA%' THEN 'NOT_EXAMINED'
      WHEN UPPER(COALESCE(djj,'')) LIKE '%TIDAK TERDENGAR%' OR UPPER(COALESCE(djj,'')) LIKE '%TIDAK TERDETEKSI%' THEN 'NOT_DETECTED'
      WHEN UPPER(COALESCE(djj,'')) LIKE '%>160%' THEN 'SOURCE_ABOVE_160'
      WHEN UPPER(COALESCE(djj,'')) LIKE '%<110%' THEN 'SOURCE_BELOW_110'
      WHEN UPPER(COALESCE(djj,'')) LIKE '%NORMAL%' THEN 'SOURCE_NORMAL'
      WHEN UPPER(TRIM(COALESCE(djj,''))) IN ('+','(+)','+/+') THEN 'SOURCE_DETECTED'
      ELSE 'NOT_ASSESSABLE'
    END AS djj_status,
    CASE
      WHEN td_level IS NOT NULL THEN 'IMMUNIZATION_STATUS_RECORDED'
      WHEN UPPER(COALESCE(vaksin_tt,'')) LIKE '%TIDAK DILAKUKAN%' THEN 'NOT_SCREENED'
      WHEN UPPER(TRIM(COALESCE(vaksin_tt,''))) = 'SUDAH' THEN 'REPORTED_DONE_UNSPECIFIED'
      WHEN UPPER(TRIM(COALESCE(vaksin_tt,''))) = 'BELUM' THEN 'REPORTED_NOT_DONE'
      ELSE 'NOT_ASSESSABLE'
    END AS td_status,
    CASE WHEN ttd_count > 0 THEN 'POSITIVE_COUNT_RECORDED'
         WHEN ttd_count = 0 THEN 'ZERO_RECORDED' ELSE 'NOT_ASSESSABLE' END AS ttd_status,
    CASE
      WHEN hb_anc_g_dl IS NOT NULL OR hb_lab_g_dl IS NOT NULL THEN 'NUMERIC'
      WHEN UPPER(CONCAT(COALESCE(hemoglobin,''),' ',COALESCE(lab_hb,''))) LIKE '%TIDAK ANEMIA%' THEN 'SOURCE_NO_ANEMIA'
      WHEN UPPER(CONCAT(COALESCE(hemoglobin,''),' ',COALESCE(lab_hb,''))) LIKE '%ANEMIA BERAT%' THEN 'SOURCE_SEVERE_ANEMIA'
      WHEN UPPER(CONCAT(COALESCE(hemoglobin,''),' ',COALESCE(lab_hb,''))) LIKE '%ANEMIA SEDANG%' THEN 'SOURCE_MODERATE_ANEMIA'
      WHEN UPPER(CONCAT(COALESCE(hemoglobin,''),' ',COALESCE(lab_hb,''))) LIKE '%ANEMIA RINGAN%' THEN 'SOURCE_MILD_ANEMIA'
      WHEN UPPER(CONCAT(COALESCE(hemoglobin,''),' ',COALESCE(lab_hb,''))) LIKE '%TIDAK DIPERIKSA%' THEN 'NOT_EXAMINED'
      ELSE 'NOT_ASSESSABLE'
    END AS hb_status,
    CASE WHEN UPPER(TRIM(COALESCE(Tatalaksana,''))) = 'YA' THEN 'REPORTED_YES'
         WHEN UPPER(TRIM(COALESCE(Tatalaksana,''))) = 'TIDAK' THEN 'REPORTED_NO'
         ELSE 'NOT_ASSESSABLE' END AS tatalaksana_status,
    CASE WHEN UPPER(TRIM(COALESCE(konseling,''))) IN ('YA','COMPLETED') THEN 'REPORTED_DONE'
         WHEN UPPER(TRIM(COALESCE(konseling,''))) = 'TIDAK' THEN 'REPORTED_NOT_DONE'
         ELSE 'NOT_ASSESSABLE' END AS konseling_status,
    CASE
      WHEN UPPER(TRIM(COALESCE(NULLIF(usg,''),ultrasound_obstetric,''))) IN ('TIDAK','TIDAK DIPERIKSA') THEN 'NOT_EXAMINED'
      WHEN UPPER(COALESCE(NULLIF(usg,''),ultrasound_obstetric,'')) LIKE '%KECURIGAAN%ABNORMAL%' THEN 'EXAMINED_SUSPECT_ABNORMAL'
      WHEN UPPER(TRIM(COALESCE(NULLIF(usg,''),ultrasound_obstetric,''))) IN ('HASIL TIDAK NORMAL','TIDAK NORMAL') THEN 'EXAMINED_ABNORMAL'
      WHEN UPPER(TRIM(COALESCE(NULLIF(usg,''),ultrasound_obstetric,''))) IN
        ('YA','Y','DIPERIKSA','NORMAL','HASIL NORMAL','DIPERIKSA, HASIL NORMAL',
         'DIPERIKSA HASIL NORMAL','ULTRASOUND OBSTETRIC SCAN NORMAL') THEN 'EXAMINED'
      ELSE 'NOT_ASSESSABLE'
    END AS usg_status,
    CASE WHEN UPPER(TRIM(COALESCE(keswa,''))) IN ('YA','COMPLETED') THEN 'REPORTED_DONE'
         WHEN UPPER(TRIM(COALESCE(keswa,''))) IN ('TIDAK','NOT-DONE') THEN 'REPORTED_NOT_DONE'
         ELSE 'NOT_ASSESSABLE' END AS keswa_status
  FROM visit_parsed v
)
SELECT c.*,
  weight_kg IS NOT NULL AND height_cm IS NOT NULL AS t1_evidence,
  bp_status IN ('NUMERIC_COMPLETE','SOURCE_NORMAL','SOURCE_HYPERTENSION','SOURCE_HYPOTENSION') AS t2_evidence,
  lila_status IN ('KEK_BY_LILA','NON_KEK_BY_LILA','SOURCE_KEK','SOURCE_NON_KEK','SOURCE_RISK_KEK') AS t3_evidence,
  tfu_status IN ('NUMERIC','SOURCE_APPROPRIATE','SOURCE_NOT_APPROPRIATE') AS t4_evidence,
  djj_status IN ('NUMERIC','SOURCE_NORMAL','SOURCE_ABOVE_160','SOURCE_BELOW_110','SOURCE_DETECTED','NOT_DETECTED') AS t5_evidence,
  td_status IN ('IMMUNIZATION_STATUS_RECORDED','REPORTED_DONE_UNSPECIFIED') AS t6_evidence,
  ttd_count IS NOT NULL AS t7_evidence,
  (hb_status IN ('NUMERIC','SOURCE_NO_ANEMIA','SOURCE_MILD_ANEMIA','SOURCE_MODERATE_ANEMIA','SOURCE_SEVERE_ANEMIA')
   OR hiv_status IN ('NON_REACTIVE','REACTIVE') OR hepb_status IN ('NON_REACTIVE','REACTIVE')
   OR sifilis_status IN ('NON_REACTIVE','REACTIVE')) AS t8_evidence,
  konseling_status = 'REPORTED_DONE' AS t10_evidence,
  usg_status IN ('EXAMINED','EXAMINED_ABNORMAL','EXAMINED_SUSPECT_ABNORMAL') AS t11_evidence,
  keswa_status = 'REPORTED_DONE' AS t12_evidence
FROM clinical c;

-- 5. Aggregate one summary per episode (clinical record counts != unique clinical encounters).
CREATE TEMP TABLE anc_episode_agg AS
SELECT linked_episode_key AS episode_key,
  COUNT(*) AS anc_visit_records,
  COUNT(DISTINCT visit_date) AS anc_distinct_dates,
  MIN(visit_date) AS first_anc_date,
  MAX(visit_date) AS latest_anc_date,
  COUNTIF(k_visit_standard = 'K1') AS k1_records,
  COUNTIF(k_visit_standard = 'K2') AS k2_records,
  COUNTIF(k_visit_standard = 'K3') AS k3_records,
  COUNTIF(k_visit_standard = 'K4') AS k4_records,
  COUNTIF(k_visit_standard = 'K5') AS k5_records,
  COUNTIF(k_visit_standard = 'K6') AS k6_records,
  COUNTIF(k_visit_standard IS NULL) AS unclassified_k_visits,
  COUNT(DISTINCT COALESCE(birthDate,tgllahir)) AS maternal_birth_date_variants,
  IF(COUNT(DISTINCT COALESCE(birthDate,tgllahir)) = 1, MIN(COALESCE(birthDate,tgllahir)), NULL) AS maternal_birth_date,
  LOGICAL_OR(t1_evidence) AS t1_any,
  LOGICAL_OR(t2_evidence) AS t2_any,
  LOGICAL_OR(t3_evidence) AS t3_any,
  LOGICAL_OR(t4_evidence) AS t4_any,
  LOGICAL_OR(t5_evidence) AS t5_any,
  LOGICAL_OR(t6_evidence) AS t6_any,
  LOGICAL_OR(t7_evidence) AS t7_any,
  LOGICAL_OR(t8_evidence) AS t8_any,
  LOGICAL_OR(t10_evidence) AS t10_any,
  LOGICAL_OR(t11_evidence) AS t11_any,
  LOGICAL_OR(t12_evidence) AS t12_any,
  MAX(td_level) AS highest_td_level,
  MAX(ttd_count) AS maximum_recorded_ttd_count,
  MIN(lila_cm) AS minimum_lila_cm,
  COUNTIF(hb_representation_diff) AS hb_representation_mismatches,
  COUNTIF(usg_representation_diff) AS usg_representation_mismatches,
  COUNTIF(hiv_status = 'REACTIVE') AS hiv_reactive_records,
  COUNTIF(hepb_status = 'REACTIVE') AS hepb_reactive_records,
  COUNTIF(sifilis_status = 'REACTIVE') AS sifilis_reactive_records,
  ARRAY_AGG(IF(weight_kg IS NOT NULL, STRUCT(weight_kg AS val), NULL)
     IGNORE NULLS ORDER BY visit_date, visit_record_key LIMIT 1)[SAFE_OFFSET(0)].val AS first_weight_kg,
  ARRAY_AGG(IF(weight_kg IS NOT NULL, STRUCT(weight_kg AS val), NULL)
     IGNORE NULLS ORDER BY visit_date DESC, visit_record_key DESC LIMIT 1)[SAFE_OFFSET(0)].val AS latest_weight_kg,
  ARRAY_AGG(IF(height_cm IS NOT NULL, STRUCT(height_cm AS val), NULL)
     IGNORE NULLS ORDER BY visit_date DESC, visit_record_key DESC LIMIT 1)[SAFE_OFFSET(0)].val AS latest_height_cm,
  ARRAY_AGG(IF(lila_cm IS NOT NULL, STRUCT(lila_cm AS val), NULL)
     IGNORE NULLS ORDER BY visit_date DESC, visit_record_key DESC LIMIT 1)[SAFE_OFFSET(0)].val AS latest_lila_cm,
  ARRAY_AGG(IF(COALESCE(hb_lab_g_dl,hb_anc_g_dl) IS NOT NULL,
       STRUCT(COALESCE(hb_lab_g_dl,hb_anc_g_dl) AS val), NULL)
     IGNORE NULLS ORDER BY visit_date DESC, visit_record_key DESC LIMIT 1)[SAFE_OFFSET(0)].val AS latest_hb_g_dl
FROM visits_out
WHERE is_auto_linked AND linked_episode_key IS NOT NULL
GROUP BY linked_episode_key;

CREATE TEMP TABLE episodes_out AS
SELECT e.*,
  COALESCE(a.anc_visit_records, 0) AS anc_visit_records,
  COALESCE(a.anc_distinct_dates, 0) AS anc_distinct_dates,
  a.* EXCEPT(episode_key,anc_visit_records,anc_distinct_dates),
  (
    IF(COALESCE(a.t1_any,FALSE),1,0) + IF(COALESCE(a.t2_any,FALSE),1,0) +
    IF(COALESCE(a.t3_any,FALSE),1,0) + IF(COALESCE(a.t4_any,FALSE),1,0) +
    IF(COALESCE(a.t5_any,FALSE),1,0) + IF(COALESCE(a.t6_any,FALSE),1,0) +
    IF(COALESCE(a.t7_any,FALSE),1,0) + IF(COALESCE(a.t8_any,FALSE),1,0) +
    IF(COALESCE(a.t10_any,FALSE),1,0) + IF(COALESCE(a.t11_any,FALSE),1,0) +
    IF(COALESCE(a.t12_any,FALSE),1,0)
  ) AS documented_components_11,
  IF(COALESCE(a.anc_visit_records,0) > 0,
    ROUND(100 * SAFE_DIVIDE(
      IF(COALESCE(a.t1_any,FALSE),1,0) + IF(COALESCE(a.t2_any,FALSE),1,0) +
      IF(COALESCE(a.t3_any,FALSE),1,0) + IF(COALESCE(a.t4_any,FALSE),1,0) +
      IF(COALESCE(a.t5_any,FALSE),1,0) + IF(COALESCE(a.t6_any,FALSE),1,0) +
      IF(COALESCE(a.t7_any,FALSE),1,0) + IF(COALESCE(a.t8_any,FALSE),1,0) +
      IF(COALESCE(a.t10_any,FALSE),1,0) + IF(COALESCE(a.t11_any,FALSE),1,0) +
      IF(COALESCE(a.t12_any,FALSE),1,0), 11), 1), NULL
  ) AS documentation_index_11_pct,
  'SOURCE_UNVERIFIED' AS t9_validation_status
FROM episode_base e
LEFT JOIN anc_episode_agg a USING(episode_key);

-- 6. Matrix 12T in one pass: 12 rows per linked visit, aggregate K, then pivot.
-- There is no permanent matrix_visit or matrix_k intermediate table.
CREATE TEMP TABLE matrix_visit AS
SELECT v.linked_episode_key AS episode_key, v.visit_record_key, v.visit_date,
  v.k_visit_standard AS k_visit, v.Sumber_Data AS source_system,
  x.component_no, x.result_status, x.has_evidence, x.not_done,
  x.review_flag, x.clinical_finding, x.display_value
FROM visits_out v
CROSS JOIN UNNEST([
  STRUCT(1 AS component_no,
    IF(v.t1_evidence,'BOTH_MEASUREMENTS',IF(v.weight_kg IS NOT NULL OR v.height_cm IS NOT NULL,'PARTIAL_MEASUREMENT','NOT_ASSESSABLE')) AS result_status,
    v.t1_evidence AS has_evidence, FALSE AS not_done,
    v.weight_duration_artifact OR v.height_duration_artifact AS review_flag, FALSE AS clinical_finding,
    CONCAT('BB: ', COALESCE(CAST(v.weight_kg AS STRING),'—'), ' kg; TB: ',COALESCE(CAST(v.height_cm AS STRING),'—'),' cm') AS display_value),
  STRUCT(2,v.bp_status,v.t2_evidence,FALSE,FALSE,
    v.bp_status = 'SOURCE_HYPERTENSION' OR v.sbp_mmhg >= 140 OR v.dbp_mmhg >= 90,
    IF(v.sbp_mmhg IS NOT NULL AND v.dbp_mmhg IS NOT NULL,
      CONCAT(CAST(v.sbp_mmhg AS STRING),'/',CAST(v.dbp_mmhg AS STRING),' mmHg'),
      COALESCE(NULLIF(TRIM(v.systolic_bp),''),'—'))),
  STRUCT(3,v.lila_status,v.t3_evidence,FALSE,FALSE,
    v.lila_status IN ('KEK_BY_LILA','SOURCE_KEK','SOURCE_RISK_KEK'),
    COALESCE(CAST(v.lila_cm AS STRING),NULLIF(TRIM(v.arm_circumference),''),'—')),
  STRUCT(4,v.tfu_status,v.t4_evidence,FALSE,FALSE,
    v.tfu_status = 'SOURCE_NOT_APPROPRIATE',
    COALESCE(CAST(v.tfu_cm AS STRING),NULLIF(TRIM(v.tinggi_fundus),''),'—')),
  STRUCT(5,v.djj_status,v.t5_evidence,v.djj_status = 'NOT_EXAMINED',FALSE,
    v.djj_status IN ('NOT_DETECTED','SOURCE_ABOVE_160','SOURCE_BELOW_110') OR v.djj_bpm > 160 OR v.djj_bpm < 110,
    CONCAT('DJJ: ',COALESCE(CAST(v.djj_bpm AS STRING),NULLIF(TRIM(v.djj),''),'—'),'; Presentasi: tidak tersedia')),
  STRUCT(6,v.td_status,v.t6_evidence,v.td_status IN ('NOT_SCREENED','REPORTED_NOT_DONE'),FALSE,FALSE,
    COALESCE(NULLIF(TRIM(v.vaksin_tt),''),'—')),
  STRUCT(7,v.ttd_status,v.t7_evidence,FALSE,FALSE,FALSE,
    COALESCE(CAST(v.ttd_count AS STRING),NULLIF(TRIM(v.ttd),''),'—')),
  STRUCT(8,v.hb_status,v.t8_evidence,v.hb_status = 'NOT_EXAMINED',v.hb_representation_diff,
    v.hiv_status = 'REACTIVE' OR v.hepb_status = 'REACTIVE' OR v.sifilis_status = 'REACTIVE' OR
    v.hb_status IN ('SOURCE_MILD_ANEMIA','SOURCE_MODERATE_ANEMIA','SOURCE_SEVERE_ANEMIA') OR
    COALESCE(v.hb_lab_g_dl,v.hb_anc_g_dl) < 11,
    CONCAT('Hb: ',COALESCE(NULLIF(TRIM(v.hemoglobin),''),'—'),
      IF(v.hb_representation_diff,CONCAT(' / lab: ',COALESCE(NULLIF(TRIM(v.lab_hb),''),'—')),''),
      '; HIV: ',COALESCE(NULLIF(TRIM(v.lab_hiv),''),'—'),
      '; Sifilis: ',COALESCE(NULLIF(TRIM(v.lab_sifilis),''),'—'),
      '; HBsAg: ',COALESCE(NULLIF(TRIM(v.lab_hep_b),''),'—'))),
  STRUCT(9,v.tatalaksana_status,FALSE,FALSE,TRUE,FALSE,
    CONCAT(COALESCE(NULLIF(TRIM(v.Tatalaksana),''),'—'),' (belum tervalidasi)')),
  STRUCT(10,v.konseling_status,v.t10_evidence,v.konseling_status = 'REPORTED_NOT_DONE',FALSE,FALSE,
    COALESCE(NULLIF(TRIM(v.konseling),''),'—')),
  STRUCT(11,v.usg_status,v.t11_evidence,v.usg_status = 'NOT_EXAMINED',v.usg_representation_diff,
    v.usg_status IN ('EXAMINED_ABNORMAL','EXAMINED_SUSPECT_ABNORMAL'),
    COALESCE(NULLIF(TRIM(v.usg),''),NULLIF(TRIM(v.ultrasound_obstetric),''),'—')),
  STRUCT(12,v.keswa_status,v.t12_evidence,v.keswa_status = 'REPORTED_NOT_DONE',FALSE,FALSE,
    CONCAT(COALESCE(NULLIF(TRIM(v.keswa),''),'—'),'; Jadwal ulang: tidak tersedia'))
]) AS x
WHERE v.is_auto_linked AND v.linked_episode_key IS NOT NULL;

CREATE TEMP TABLE matrix_agg AS
WITH grouped AS (
  SELECT episode_key, k_visit, component_no,
    COUNT(*) AS record_count,
    COUNTIF(has_evidence) AS evidence_count,
    COUNTIF(not_done) AS not_done_count,
    COUNTIF(review_flag) AS review_count,
    COUNTIF(clinical_finding) AS finding_count,
    COUNTIF(result_status = 'PARTIAL_MEASUREMENT') AS partial_count,
    COUNTIF(result_status = 'ZERO_RECORDED') AS zero_count,
    STRING_AGG(CONCAT(FORMAT_DATE('%d-%m-%Y',visit_date),' | ',
      COALESCE(source_system,'UNKNOWN'),' | ',COALESCE(display_value,'—')),
      '\n' ORDER BY visit_date, source_system, visit_record_key) AS history
  FROM matrix_visit
  WHERE k_visit IN ('K1','K2','K3','K4','K5','K6')
  GROUP BY episode_key,k_visit,component_no
)
SELECT *, CASE
  WHEN component_no = 9 THEN 'SOURCE_UNVERIFIED'
  WHEN finding_count > 0 THEN 'SOURCE_FINDING_REVIEW'
  WHEN evidence_count > 0 AND review_count > 0 THEN 'HAS_EVIDENCE_REVIEW_FLAG'
  WHEN evidence_count > 0 THEN 'HAS_EVIDENCE'
  WHEN component_no = 1 AND partial_count > 0 THEN 'PARTIAL_EVIDENCE'
  WHEN component_no = 7 AND zero_count > 0 THEN 'DOCUMENTED_ZERO'
  WHEN not_done_count > 0 THEN 'REPORTED_NOT_DONE'
  WHEN review_count > 0 THEN 'NEEDS_REVIEW'
  ELSE 'NO_EVIDENCE'
END AS status
FROM grouped;

CREATE TEMP TABLE matrix_pivot AS
SELECT * FROM (
  SELECT episode_key,component_no,k_visit,history,status,record_count
  FROM matrix_agg
)
PIVOT (
  MAX(history) AS history, MAX(status) AS status, MAX(record_count) AS records
  FOR k_visit IN ('K1' AS k1,'K2' AS k2,'K3' AS k3,'K4' AS k4,'K5' AS k5,'K6' AS k6)
);

CREATE TEMP TABLE matrix_out AS
SELECT e.episode_key, c.component_no, c.component_name,
  COALESCE(p.history_k1,'—') AS history_k1,COALESCE(p.history_k2,'—') AS history_k2,
  COALESCE(p.history_k3,'—') AS history_k3,COALESCE(p.history_k4,'—') AS history_k4,
  COALESCE(p.history_k5,'—') AS history_k5,COALESCE(p.history_k6,'—') AS history_k6,
  COALESCE(p.status_k1,'NO_VISIT') AS status_k1,COALESCE(p.status_k2,'NO_VISIT') AS status_k2,
  COALESCE(p.status_k3,'NO_VISIT') AS status_k3,COALESCE(p.status_k4,'NO_VISIT') AS status_k4,
  COALESCE(p.status_k5,'NO_VISIT') AS status_k5,COALESCE(p.status_k6,'NO_VISIT') AS status_k6,
  COALESCE(p.records_k1,0) AS records_k1,COALESCE(p.records_k2,0) AS records_k2,
  COALESCE(p.records_k3,0) AS records_k3,COALESCE(p.records_k4,0) AS records_k4,
  COALESCE(p.records_k5,0) AS records_k5,COALESCE(p.records_k6,0) AS records_k6
FROM episodes_out e
CROSS JOIN UNNEST([
  STRUCT(1 AS component_no,'Timbang BB dan ukur TB' AS component_name),
  STRUCT(2,'Ukur tekanan darah'), STRUCT(3,'Nilai status gizi (LiLA)'),
  STRUCT(4,'Ukur tinggi fundus uteri'), STRUCT(5,'Presentasi janin dan DJJ'),
  STRUCT(6,'Skrining imunisasi Td'), STRUCT(7,'Tablet tambah darah'),
  STRUCT(8,'Tes laboratorium'), STRUCT(9,'Tatalaksana kasus'),
  STRUCT(10,'Temu wicara / konseling'), STRUCT(11,'Pemeriksaan USG'),
  STRUCT(12,'Skrining keswa dan jadwal ulang')
]) c
LEFT JOIN matrix_pivot p ON e.episode_key = p.episode_key AND c.component_no = p.component_no;

-- 7. Dynamic QA gates: no hard-coded row counts, so tomorrow's source growth is valid.
ASSERT (SELECT COUNT(*) = COUNT(DISTINCT episode_key) FROM episodes_out)
  AS 'Episode keys are not unique';
ASSERT (SELECT COUNT(*) = (SELECT SUM(cohort_source_rows) FROM episodes_out) FROM src_cohort)
  AS 'Cohort records missing from episode output';
ASSERT (SELECT COUNT(*) = (SELECT COUNT(*) FROM src_anc) AND COUNT(*) = COUNT(DISTINCT visit_record_key)
        FROM visits_out) AS 'ANC visit record preservation or uniqueness failed';
ASSERT (SELECT COUNT(*) = 0 FROM visits_out v LEFT JOIN episodes_out e
        ON v.linked_episode_key=e.episode_key
        WHERE v.is_auto_linked AND e.episode_key IS NULL)
  AS 'Auto-linked visit without episode master';
ASSERT (SELECT (SELECT SUM(anc_visit_records) FROM episodes_out) =
               (SELECT COUNTIF(is_auto_linked) FROM visits_out))
  AS 'Episode ANC summary count mismatch';
ASSERT (SELECT COUNT(*) = 12 * (SELECT COUNT(*) FROM episodes_out)
        AND COUNT(*) = COUNT(DISTINCT CONCAT(episode_key,'|',CAST(component_no AS STRING)))
        FROM matrix_out) AS 'Matrix is not 12 unique rows per episode';
ASSERT (SELECT SUM(records_k1+records_k2+records_k3+records_k4+records_k5+records_k6) =
          12 * (SELECT COUNT(*) FROM visits_out WHERE is_auto_linked AND k_visit_standard IS NOT NULL)
        FROM matrix_out) AS 'Matrix did not preserve classified visit components';

-- 8. Publish only after the preceding QA checks pass.
CREATE OR REPLACE TABLE `stellar-orb-451904-d9.maternal_12t.t_visit_clinical`
CLUSTER BY nik_clean, linkage_status AS SELECT * FROM visits_out;

CREATE OR REPLACE TABLE `stellar-orb-451904-d9.maternal_12t.t_episode_summary`
CLUSTER BY nik_clean, episode_resolution_status AS SELECT * FROM episodes_out;

CREATE OR REPLACE TABLE `stellar-orb-451904-d9.maternal_12t.t_matrix_wide`
CLUSTER BY episode_key, component_no AS SELECT * FROM matrix_out;

-- Dashboard views are deliberately NOT created in this scheduled query.
-- Create them ONCE by running maternal_12t_setup_views_once.sql
-- as a SEPARATE BigQuery query job (no temporary UDFs in that job).

-- Run summary shown in BigQuery scheduled job history (no patient-level data).
SELECT
  (SELECT COUNT(*) FROM `stellar-orb-451904-d9.maternal_12t.t_episode_summary`) AS episodes,
  (SELECT COUNT(*) FROM `stellar-orb-451904-d9.maternal_12t.t_visit_clinical`) AS anc_source_records,
  (SELECT COUNTIF(is_auto_linked) FROM `stellar-orb-451904-d9.maternal_12t.t_visit_clinical`) AS linked_records,
  (SELECT COUNT(*) FROM `stellar-orb-451904-d9.maternal_12t.t_matrix_wide`) AS matrix_rows,
  'PASS' AS integrity_qa;