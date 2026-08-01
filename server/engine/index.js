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
const { explainAll, executiveSummary } = require('./explain');

const RULES = [
  require('./rules/r1_cross_source'),
  require('./rules/r2_identities'),
  require('./rules/r3_rollup'),
  require('./rules/r4_temporal'),
  require('./rules/r5_coverage'),
  require('./rules/r6_plausibility'),
  require('./rules/r7_captable')
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

  const resolved = resolveConflicts(findings);
  const ordered = assignRefCodes(resolved);
  const breakdown = calculateScore(ordered, graph, options.documents || []);

  // Templated prose, applied before any AI sees the findings. The narrator can improve on
  // these strings later, but the report is complete and readable without it - so an LLM
  // outage costs polish, never a verdict.
  explainAll(ordered);

  return {
    findings: ordered,
    executive_summary: executiveSummary(breakdown, ordered),
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

/**
 * Cross-rule conflict resolution.
 *
 * Rules run independently and deliberately don't know about each other - that keeps each one
 * simple and testable. The cost is that two rules can describe the same underlying error, and
 * a duplicate does real damage: it appears twice in the UI, and it counts twice against the
 * readiness score.
 *
 * Each case below is a specific overlap found by testing, resolved by keeping the finding that
 * tells the reader more.
 */
function resolveConflicts(findings) {
  let out = findings;

  out = dropExactDuplicates(out);
  out = dropDerivedWhereStatedExists(out);
  out = dropConsistentWhereProblemExists(out);

  return out;
}

/**
 * Belt and braces: identical rule, metric, period and node should be impossible, but a future
 * rule that loops over periods carelessly would produce them. Cheaper to guard than to debug.
 */
function dropExactDuplicates(findings) {
  const seen = new Set();
  const out = [];

  for (const f of findings) {
    const key = [f.rule_id, f.metric_key, f.period_key, f.node_key, f.computation.result].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }

  return out;
}

/**
 * R6 checks a derived value for plausibility; R2 checks a stated value against a computed one.
 * When a document states the figure, R2's finding is strictly more informative - it names the
 * discrepancy rather than just calling the result odd - so R6's derived version is redundant.
 *
 * R6 already guards against this internally. This catches the case where the two rules disagree
 * about whether a stated node exists, e.g. because subjects split it.
 */
function dropDerivedWhereStatedExists(findings) {
  const statedKeys = new Set(
    findings
      .filter(f => f.rule_class === 'R2')
      .map(f => `${f.metric_key}|${f.period_key}`)
  );

  return findings.filter(f => {
    const isDerived = f.rule_class === 'R6' && f.details && f.details.derived;
    if (!isDerived) return true;
    return !statedKeys.has(`${f.metric_key}|${f.period_key}`);
  });
}

/**
 * Never report a metric as verified consistent in the same period where another rule found a
 * real problem with it.
 *
 * This happens legitimately: two documents can agree perfectly on a gross profit figure that is
 * nonetheless arithmetically impossible given their own revenue and COGS. R1 says "consistent",
 * R2 says "wrong". Both are true, but showing a green tick next to a red finding for the same
 * number reads as a contradiction and undermines both.
 *
 * The problem wins. A confirmation is only worth showing when nothing else contradicts it.
 */
function dropConsistentWhereProblemExists(findings) {
  const problemKeys = new Set(
    findings
      .filter(f => f.classification !== 'VERIFIED_CONSISTENT')
      .map(f => `${f.metric_key}|${f.period_key}`)
  );

  return findings.filter(f => {
    if (f.classification !== 'VERIFIED_CONSISTENT') return true;
    return !problemKeys.has(`${f.metric_key}|${f.period_key}`);
  });
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

module.exports = { verify, problems, confirmations, resolveConflicts, RULES };
