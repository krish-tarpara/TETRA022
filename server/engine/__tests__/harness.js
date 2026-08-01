/**
 * Minimal test harness. No dependencies on purpose - the engine's whole selling point is
 * that it is verifiable, so its test runner should not need a network install to work.
 *
 * Usage:  node server/engine/__tests__/run.js
 */

const results = { passed: 0, failed: 0, failures: [] };
let currentSuite = '';

function suite(name, fn) {
  currentSuite = name;
  console.log(`\n${name}`);
  fn();
  currentSuite = '';
}

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.failed++;
    results.failures.push({ suite: currentSuite, name, message: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message.split('\n').join('\n        ')}`);
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

/** Float comparison with an explicit tolerance, because exact equality on floats is a lie. */
function near(actual, expected, tolerance, label) {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) {
    throw new Error(`${label || 'value'}\n  expected: ~${expected}\n  actual:   ${JSON.stringify(actual)} (not a finite number)`);
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label || 'value'}\n  expected: ${expected} +/- ${tolerance}\n  actual:   ${actual}`);
  }
}

function truthy(value, label) {
  if (!value) throw new Error(`${label || 'value'} should be truthy, got ${JSON.stringify(value)}`);
}

function falsy(value, label) {
  if (value) throw new Error(`${label || 'value'} should be falsy, got ${JSON.stringify(value)}`);
}

function report() {
  const total = results.passed + results.failed;
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${results.passed}/${total} passed`);

  if (results.failed > 0) {
    console.log(`\n${results.failed} failure(s):`);
    for (const f of results.failures) {
      console.log(`  ${f.suite} > ${f.name}`);
    }
    process.exitCode = 1;
  }
  return results;
}

module.exports = { suite, test, eq, near, truthy, falsy, report };
