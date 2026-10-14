const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const scriptsSource = read('Scripts.html')
  .replace(/^\s*<script>\s*/, '')
  .replace(/\s*<\/script>\s*$/, '');

const context = {
  console,
  sessionStorage: { getItem: () => '', setItem: () => {}, removeItem: () => {} },
  document: {
    addEventListener: () => {},
    getElementById: () => null,
    querySelectorAll: () => []
  },
  window: { scrollTo: () => {} },
  google: { script: { run: {} } },
  setTimeout,
  clearTimeout
};
vm.createContext(context);
vm.runInContext(scriptsSource, context, { filename: 'Scripts.html' });

const labels = (display) => display.lines.map((line) => line.label);
const hasLabel = (display, text) => labels(display).some((label) => label.includes(text));

const config = read('Config.gs');
const timeline = read('TimelineService.gs');
const page = read('PageMain.html');
const legacyModel = ['t_matneo_clinical_timeline', 'v2'].join('_');
assert(config.includes("TIMELINE: 't_matneo_clinical_timeline_v3'"));
assert(!config.includes(legacyModel));
assert(timeline.includes('WHERE pregnancy_key = @pregnancy_key'));
assert(timeline.includes("toBQParam_('pregnancy_key', 'STRING', key)"));
assert(timeline.includes('ORDER BY event_date IS NULL, event_date, event_sort_order, timeline_event_id'));
[
  'tt_status_norm', 'ttd_obtained', 'mms_obtained', 'counselling_status_norm',
  'ultrasound_obstetric_norm', 'mental_health_screening_status_norm', 'lab_hiv_norm',
  'lab_hep_b_norm', 'lab_syphilis_norm', 'lab_blood_group', 'lab_rhesus',
  'protein_urine_category_norm', 'treatment_anemia', 'treatment_preeclampsia',
  'treatment_kek', 'diagnoses', 'medications', 'procedures', 'tt_conflict_flag',
  'protein_urine_conflict_flag'
].forEach((field) => assert(timeline.includes(field), `backend field missing: ${field}`));

const componentNumbers = [...scriptsSource.matchAll(/number:\s*(\d+),/g)].map((match) => Number(match[1]));
assert.deepStrictEqual(componentNumbers.slice(0, 12), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
assert(page.includes('Hanya presentasi janin terstruktur dan jadwal kunjungan ulang yang belum didukung'));
assert.strictEqual(context.ancVisitCode({ event_subtype: 'K1' }), 'K1');
assert.strictEqual(context.ancVisitCode({ event_subtype: 'ANC', event_label: 'ANC K1' }), '');

assert(hasLabel(context.tetanusDisplay({ tt_order: 2 }), 'TT2'));
assert.strictEqual(context.tetanusDisplay({ tt_status_norm: 'NOT_TESTED' }).type, 'not-done');
assert.strictEqual(context.tetanusDisplay({}).type, 'not-recorded');
assert.strictEqual(context.tetanusDisplay({ tt_conflict_flag: true }).type, 'conflict');

assert(hasLabel(context.supplementationDisplay({ ttd_obtained: 30 }), 'TTD: 30 tablet'));
assert(hasLabel(context.supplementationDisplay({}), 'TTD: Belum tercatat'));
assert(!labels(context.supplementationDisplay({ ttd_obtained: -1, iron_supplementation: '-1' })).join(' ').includes('-1'));
assert.strictEqual(context.supplementationDisplay({ ttd_conflict_flag: true }).type, 'conflict');

['lab_hiv', 'lab_syphilis', 'lab_hep_b'].forEach((rawField) => {
  const normField = `${rawField}_norm`;
  const conflictField = `${rawField}_conflict_flag`;
  assert(hasLabel(context.laboratoryAssessmentDisplay({ [normField]: 'NEGATIVE' }), 'Negatif'));
  assert(hasLabel(context.laboratoryAssessmentDisplay({ [normField]: 'POSITIVE' }), 'Positif'));
  assert(hasLabel(context.laboratoryAssessmentDisplay({ [normField]: 'NOT_TESTED' }), 'Tidak diperiksa'));
  assert.strictEqual(context.laboratoryAssessmentDisplay({ [conflictField]: true }).type, 'conflict');
});
assert.strictEqual(context.laboratoryAssessmentDisplay({}).type, 'not-recorded');
assert(hasLabel(context.laboratoryAssessmentDisplay({ protein_urine_assessed_flag: false }), 'Belum tercatat'));

assert(hasLabel(context.ultrasoundDisplay({ ultrasound_obstetric_norm: 'NORMAL_REPORTED' }), 'Normal'));
assert(hasLabel(context.ultrasoundDisplay({ ultrasound_obstetric_norm: 'ABNORMAL_SUSPECTED' }), 'abnormal'));
assert.strictEqual(context.ultrasoundDisplay({ ultrasound_obstetric_norm: 'NOT_TESTED' }).type, 'not-done');
assert.strictEqual(context.ultrasoundDisplay({ usg_conflict_flag: true }).type, 'conflict');

assert(hasLabel(context.counsellingDisplay({ counselling_status_norm: 'YES' }), 'Dilakukan'));
assert.strictEqual(context.counsellingDisplay({ counselling_status_norm: 'NO' }).type, 'not-done');
assert.strictEqual(context.counsellingDisplay({ counselling_conflict_flag: true }).type, 'conflict');

assert(hasLabel(context.mentalHealthDisplay({ mental_health_screening_status_norm: 'YES' }), 'Skrining keswa: Dilakukan'));
assert(hasLabel(context.mentalHealthDisplay({}), 'Jadwal ulang: Data belum tersedia'));
assert(hasLabel(context.fetalAssessmentDisplay({ fhr_category: 'NORMAL' }), 'Presentasi: Data belum tersedia'));

const management = context.caseManagementDisplay({
  treatment_anemia: ['TTD', 'Kontrol Hb'],
  treatment_preeclampsia: 'Pantau tekanan darah',
  treatment_kek: 'Konseling gizi'
});
assert(hasLabel(management, 'TTD · Kontrol Hb'));
assert(hasLabel(management, 'Pantau tekanan darah'));
assert(hasLabel(management, 'Konseling gizi'));
assert.strictEqual(context.caseManagementDisplay({ treatment_anemia: '-' }).type, 'not-recorded');

assert(scriptsSource.includes("if (type === 'OUTCOME')"));
assert(scriptsSource.includes("else if (type === 'PNC_SUMMARY')"));
assert(scriptsSource.includes("callServer(\n        'getEventPayload'"));
assert(scriptsSource.includes("displays.length + ' peristiwa ANC memakai label K yang sama"));
assert(!scriptsSource.includes('.map(component.value).filter(isPresent)'));

console.log('CLINICAL_TIMELINE_V3_CONTRACT_OK scenarios=TT,TTD,LAB,USG,COUNSELLING,MENTAL_HEALTH,CASE_MANAGEMENT,OUTCOME,PNC');
