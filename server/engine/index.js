/**
 * Engine entry point. Observations in, scored report out, no network calls.
 *
 * This function is the whole product: it is synchronous, deterministic, and testable. Run it
 * twice on the same observations and you get byte-identical findings and an identical score.
 * That is the property that lets the report be called an audit rather than an opinion, and
 * it is why nothing in this path is allowed to touch an LLM, a clock, or a random number.
 */

const rulepack = require('./rulepack.json');
const { buildFactGraph } = require('./factGraph');
const { assignRefCodes } = require('./finding');
const { calculateScore } = require('./scoring');

const RULES = [
  require('./rules/r1_cross_source'),
  require('./rules/r2_identities'),
  require('./rules/r5_coverage')
];

/**
 * @param {Array}  observations  canonical observations
 * @param {object} options       { fxRates, documents }
 * @returns {object} { findings, score, breakdown, graph, rulepack_version, stats }
 */
function verify(observations, options = {}) {
  const graph = buildFactGraph(observations, options);

  const findings = [];
  const ruleStats = {};

  for (const rule of RULES) {
    // One broken rule must not cost the entire report. A partial audit that says which rule
    // failed is far more useful than a stack trace.
    try {
      const produced = rule.run(graph) || [];
      findings.push(...produced);
      ruleStats[rule.RULE_CLASS] = { produced: produced.length, error: null };
    } catch (err) {
      console.error(`Rule ${rule.RULE_CLASS} failed:`, err);
      ruleStats[rule.RULE_CLASS] = { produced: 0, error: err.message };
    }
  }

  const ordered = assignRefCodes(findings);
  const breakdown = calculateScore(ordered, graph, options.documents || []);

  return {
    findings: ordered,
    // `score` is the number; `breakdown` is how it was reached. Keeping them separate stops
    // callers from writing result.score.score, which reads like a typo even when correct.
    score: breakdown.score,
    breakdown,
    graph,
    rulepack_version: rulepack.version,
    stats: {
      ...graph.stats,
      rules: ruleStats,
      findings_by_class: ordered.reduce((acc, f) => {
        acc[f.classification] = (acc[f.classification] || 0) + 1;
        return acc;
      }, {})
    }
  };
}

/** Findings that represent problems, worst first. */
function problems(findings) {
  return findings
    .filter(f => f.classification !== 'VERIFIED_CONSISTENT')
    .sort((a, b) => b.severity_score - a.severity_score);
}

/** Findings that represent verified agreement. Half of what makes a report credible. */
function confirmations(findings) {
  return findings.filter(f => f.classification === 'VERIFIED_CONSISTENT');
}

module.exports = { verify, problems, confirmations, RULES };
