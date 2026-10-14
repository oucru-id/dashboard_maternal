const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const service = read('HighRiskService.gs');
const scripts = read('ScriptsHighRisk.html');
const highRiskPage = read('PageHighRisk.html');
const analyticsPage = read('PageAnalytics.html');

const context = {
  console,
  getReadModelPath_: (name) => `\`${name}\``,
  clientSafeError_: (message) => new Error(message)
};
vm.createContext(context);
vm.runInContext(service, context, { filename: 'HighRiskService.gs' });

const sql = context.highRiskAppBaseSql_();
assert(sql.includes("current_ga_days BETWEEN 0 AND 293 THEN 'ACTIVE_PREGNANCY'"));
assert(sql.includes("current_ga_days >= 294 THEN 'OVER_42W_NO_OUTCOME'"));
assert(!sql.includes('BETWEEN 0 AND 294'));
assert(!sql.includes('current_ga_days > 294'));

const exampleDays = (Date.UTC(2026, 9, 5) - Date.UTC(2025, 11, 15)) / 86400000;
assert.strictEqual(exampleDays, 294);
assert.strictEqual(Math.floor(exampleDays / 7), 42);

assert(scripts.includes("callServer('getHighRiskPregnancyDetail'"));
assert(scripts.includes('await Promise.allSettled(requests)'));
assert(scripts.includes("failures.push('riwayat klinis')"));
assert(scripts.includes("failures.push('evidence risiko')"));
assert(scripts.includes("document.getElementById('hrDetailContent').hidden = false"));
assert(scripts.includes('Detail utama ditampilkan, tetapi sebagian data gagal dimuat.'));
assert(scripts.includes('Periksa operation getHighRiskPregnancyDetail di Executions / Cloud Logging.'));
assert(scripts.includes("OVER_42W_NO_OUTCOME: '≥42 Minggu, Belum Ada Luaran'"));

assert(highRiskPage.includes('≥42 Minggu, Belum Ada Luaran'));
assert(analyticsPage.includes('≥42 Minggu, Belum Ada Luaran'));
assert(!highRiskPage.includes('&gt;42 Minggu'));
assert(!analyticsPage.includes('&gt;42 Minggu'));

assert(service.includes('WHERE pregnancy_key = @pregnancy_key'));
assert(service.includes("toBQParam_('pregnancy_key', 'STRING', key)"));

console.log('HIGH_RISK_MONITORING_CONTRACT_OK active_days=0-293 overdue_from=294 partial_detail=true');
