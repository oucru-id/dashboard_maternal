const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const highRiskSource = fs.readFileSync(path.join(root, 'HighRiskService.gs'), 'utf8');
const analyticsSource = fs.readFileSync(path.join(root, 'AnalyticsService.gs'), 'utf8');
const context = {
  console,
  getReadModelPath_: (name) => `\`${name}\``,
  clientSafeError_: (message) => new Error(message)
};
vm.createContext(context);
vm.runInContext(highRiskSource, context, { filename: 'HighRiskService.gs' });

const canonicalCases = [
  ['Gunung Sari', 'Puskesmas Gunungsari'],
  ['Gunungsari', 'Puskesmas Gunungsari'],
  ['PKM GUNUNG SARI', 'Puskesmas Gunungsari'],
  ['UPTD BLUD Puskesmas Gunungsari', 'Puskesmas Gunungsari'],
  ['Kediri', 'Puskesmas Kediri'],
  ['Puskesmas Kediri', 'Puskesmas Kediri'],
  ['PUSKESMAS PKM KEDIRI', 'Puskesmas Kediri'],
  ['Puskesmas Rawat Inap Kediri', 'Puskesmas Kediri'],
  ['Labu Api', 'Puskesmas Labuapi'],
  ['Puskesmas Labuapi', 'Puskesmas Labuapi'],
  ['RSUD Patut Patuh Patju', 'RSUD Patut Patuh Patju'],
  ['Puskesmas Dasan Tapen', 'Puskesmas Dasan Tapen'],
  ['PKM SEKOTONG', 'Puskesmas Sekotong']
];

canonicalCases.forEach(([input, expected]) => {
  assert.strictEqual(context.canonicalPuskesmasName_(input), expected, input);
});
assert.strictEqual(context.canonicalPuskesmasName_('Lokasi Perlu Verifikasi'), 'Lokasi Perlu Verifikasi');
assert.strictEqual(context.canonicalPuskesmasName_('Fasilitas Baru'), 'Fasilitas Baru');
assert.strictEqual(context.normalizePuskesmasFilter_(' PKM KEDIRI '), 'Puskesmas Kediri');
assert.strictEqual(context.normalizePuskesmasFilter_(''), null);

const sqlExpression = context.canonicalPuskesmasSql_('puskesmas_display');
assert(sqlExpression.includes('NORMALIZE_AND_CASEFOLD'));
assert(sqlExpression.includes("WHEN 'gunungsari' THEN 'Puskesmas Gunungsari'"));
assert(sqlExpression.includes("WHEN 'kediri' THEN 'Puskesmas Kediri'"));
assert(sqlExpression.includes("WHEN 'labuapi' THEN 'Puskesmas Labuapi'"));
assert(sqlExpression.includes("WHEN 'patutpatuhpatju' THEN 'RSUD Patut Patuh Patju'"));

const baseSql = context.highRiskAppBaseSql_();
assert(baseSql.includes('END AS puskesmas_group'));
assert(baseSql.includes("WHEN 'gunungsari' THEN 'Puskesmas Gunungsari'"));
assert(baseSql.includes("WHEN 'kediri' THEN 'Puskesmas Kediri'"));
assert(highRiskSource.includes('puskesmas: normalizePuskesmasFilter_(input.puskesmas)'));
assert(analyticsSource.includes('puskesmas: normalizePuskesmasFilter_(input.puskesmas)'));
assert(analyticsSource.includes("'FROM scoped GROUP BY region'"));

console.log('PUSKESMAS_GROUPING_CONTRACT_OK variants=' + canonicalCases.length + ' canonical_groups=21');
