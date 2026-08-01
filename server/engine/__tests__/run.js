/**
 * Engine test runner.  node server/engine/__tests__/run.js
 *
 * Deliberately dependency-free: the engine's claim is that its verdicts are reproducible and
 * verifiable, and that claim is weaker if checking it requires an npm install to succeed.
 */

const { report } = require('./harness');

const suites = [
  './canonicalize.test.js',
  './factGraph.test.js',
  './rules.test.js'
];

console.log('FinVerify engine tests');
console.log(`rulepack v${require('../rulepack.json').version}`);

for (const path of suites) {
  require(path)();
}

report();
