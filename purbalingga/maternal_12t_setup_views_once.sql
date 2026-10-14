-- SETUP ONCE: dashboard views for stellar-orb-451904-d9.maternal_12t
-- IMPORTANT: Run this as a NEW, SEPARATE BigQuery job after the scheduled
-- refresh script has created all 3 tables successfully.
-- Do not run in the same query job as temporary UDF definitions.
-- No schedule needed: views automatically read refreshed permanent tables.

CREATE OR REPLACE VIEW `stellar-orb-451904-d9.maternal_12t.v_episode_overview` AS
SELECT e.*,
  CASE
    WHEN e.maternal_birth_date IS NOT NULL AND e.hpht IS NOT NULL
      AND e.maternal_birth_date <= e.hpht
    THEN DATE_DIFF(e.hpht,e.maternal_birth_date,YEAR)
      - IF(FORMAT_DATE('%m%d',e.hpht) < FORMAT_DATE('%m%d',e.maternal_birth_date),1,0)
    ELSE NULL
  END AS maternal_age_at_hpht
FROM `stellar-orb-451904-d9.maternal_12t.t_episode_summary` e;

CREATE OR REPLACE VIEW `stellar-orb-451904-d9.maternal_12t.v_dashboard_detail` AS
SELECT e.*, m.* EXCEPT(episode_key)
FROM `stellar-orb-451904-d9.maternal_12t.v_episode_overview` e
JOIN `stellar-orb-451904-d9.maternal_12t.t_matrix_wide` m USING(episode_key);

CREATE OR REPLACE VIEW `stellar-orb-451904-d9.maternal_12t.v_unclassified_k` AS
SELECT * FROM `stellar-orb-451904-d9.maternal_12t.t_visit_clinical`
WHERE is_auto_linked AND k_visit_standard IS NULL;

-- Verify that all views return the expected number of rows from the materialized tables.
SELECT
  (SELECT COUNT(*) FROM `stellar-orb-451904-d9.maternal_12t.v_episode_overview`) AS overview_rows,
  (SELECT COUNT(*) FROM `stellar-orb-451904-d9.maternal_12t.v_dashboard_detail`) AS detail_rows,
  (SELECT COUNT(*) FROM `stellar-orb-451904-d9.maternal_12t.v_unclassified_k`) AS unclassified_visit_rows,
  (SELECT COUNT(*) FROM `stellar-orb-451904-d9.maternal_12t.t_episode_summary`) AS materialized_episode_rows,
  (SELECT COUNT(*) FROM `stellar-orb-451904-d9.maternal_12t.t_matrix_wide`) AS materialized_matrix_rows;