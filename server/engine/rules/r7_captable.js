/**
 * R7 - Cap table integrity.
 *
 * The cap table decides what the investor actually buys, so its base weight is 17 - second
 * only to broken arithmetic. A 2% error in revenue is a reporting problem; a 2% error in the
 * cap table is a different deal.
 *
 * Three checks:
 *   1. Ownership percentages sum to 100.
 *   2. The new investor's stake matches round size divided by post-money valuation.
 *   3. The ESOP pool stated matches the ESOP line in the cap table.
 *
 * Deliberately NOT here: `pre_money + round_size = post_money`. That is an accounting identity
 * and lives in R2, where it belongs. Duplicating it would report one error twice and count it
 * twice against the score, in two different pillars.
 *
 * The hard part is the ownership sum, because a shortfall has two completely different
 * meanings and only one of them is the company's fault:
 *
 *   - the cap table really doesn't add up          -> a genuine finding
 *   - we only extracted 4 of the 6 shareholders    -> our problem, not theirs
 *
 * Guessing wrong in the second case means accusing a company of a broken cap table because our
 * own extraction was incomplete. The guards below lean hard towards silence, and where a
 * shortfall is ambiguous the finding says so in as many words.
 */

const rulepack = require('../rulepack.json');
const { makeFinding } = require('../finding');
const { formatAmount } = require('../canonicalize/currency');

const CFG = rulepack.captable;

/**
 * Below this many shareholders, a sum that misses 100% is far more likely to be incomplete
 * extraction than a real cap table error, so the rule stays quiet.
 */
const MIN_HOLDERS_TO_JUDGE = 2;

/**
 * A shortfall larger than this is treated as "probably missing shareholders" rather than
 * "the cap table is wrong", and reported as a coverage caveat instead of an accusation.
 * A real cap table error is a rounding-scale mistake; a 40% hole is a missing founder.
 */
const SHORTFALL_LOOKS_INCOMPLETE_PP = 15;

function run(graph) {
  const findings = [];

  for (const periodKey of periodsIn(graph)) {
    for (const basisClass of ['actual', 'forward']) {
      const sumFinding = checkOwnershipSum(periodKey, basisClass, graph);
      if (sumFinding) findings.push(sumFinding);

      const stakeFinding = checkNewInvestorStake(periodKey, basisClass, graph);
      if (stakeFinding) findings.push(stakeFinding);

      const esopFinding = checkEsopPool(periodKey, basisClass, graph);
      if (esopFinding) findings.push(esopFinding);
    }
  }

  return findings;
}

/**
 * Do the shareholdings sum to 100%?
 *
 * ESOP is the wrinkle. Some cap tables list it as a holder inside the 100%, others state it
 * separately alongside holders that already total 100%. Rather than guess, we test both
 * interpretations and accept whichever reconciles - reporting which one we used.
 */
function checkOwnershipSum(periodKey, basisClass, graph) {
  const holders = graph.index
    .all('ownership', periodKey, basisClass)
    .filter(n => n.consensus_value !== null && !n.blocked_reason);

  if (holders.length < MIN_HOLDERS_TO_JUDGE) return null;

  const holderSum = holders.reduce((total, n) => total + n.consensus_value, 0);

  const esopNode = graph.index.one('esop_pool', periodKey, basisClass);
  const esopValue = esopNode && esopNode.consensus_value !== null ? esopNode.consensus_value : null;

  const withoutEsop = Math.abs(holderSum - CFG.ownership_sum_target);
  const withEsop = esopValue === null
    ? Infinity
    : Math.abs(holderSum + esopValue - CFG.ownership_sum_target);

  // Whichever reading is closer to 100 is the one the document most likely intended.
  const esopIsSeparate = withEsop < withoutEsop;
  const total = esopIsSeparate ? holderSum + esopValue : holderSum;
  const gapPp = total - CFG.ownership_sum_target;

  if (Math.abs(gapPp) <= CFG.ownership_sum_tolerance_pp) {
    return buildSumFinding({
      periodKey, basisClass, graph, holders, esopNode, esopIsSeparate,
      total, gapPp, incomplete: false, passed: true
    });
  }

  // A large shortfall almost certainly means we did not read every shareholder. Say that
  // rather than accusing the company of a broken cap table.
  const looksIncomplete = gapPp < 0 && Math.abs(gapPp) > SHORTFALL_LOOKS_INCOMPLETE_PP;

  return buildSumFinding({
    periodKey, basisClass, graph, holders, esopNode, esopIsSeparate,
    total, gapPp, incomplete: looksIncomplete, passed: false
  });
}

function buildSumFinding(ctx) {
  const { periodKey, basisClass, graph, holders, esopNode, esopIsSeparate, total, gapPp, incomplete, passed } = ctx;

  const observations = [
    ...holders.flatMap(n => n.observations),
    ...(esopIsSeparate && esopNode ? esopNode.observations : [])
  ];

  const breakdown = holders
    .map(n => `${n.subject || 'unnamed'} ${round(n.consensus_value, 2)}%`)
    .join(' + ') + (esopIsSeparate && esopNode ? ` + ESOP ${round(esopNode.consensus_value, 2)}%` : '');

  const substituted = incomplete
    ? `${breakdown} = ${round(total, 2)}%. This is ${round(Math.abs(gapPp), 2)} percentage points short of 100%, ` +
      `which most likely means not every shareholder was extracted from the document rather than an error in the cap table itself.`
    : `${breakdown} = ${round(total, 2)}%   [should total 100%]`;

  return makeFinding({
    rule_id: incomplete ? 'R7.ownership_sum.incomplete' : 'R7.ownership_sum',
    rule_class: 'R7',
    metric_key: 'ownership',
    period_key: periodKey,
    // No single node owns this finding - it spans every shareholder - so corroboration falls
    // back to the single-source multiplier, which is correct here.
    node: null,
    graph,
    observations,
    computation: {
      expression: 'sum of all shareholdings = 100%',
      substituted,
      stated: total,
      computed: CFG.ownership_sum_target,
      delta_abs: gapPp,
      delta_pct: null,
      tolerance_abs: CFG.ownership_sum_tolerance_pp,
      result: passed ? 'PASS' : 'FAIL',
      // An incomplete extraction is not something we can assert against the company, so the
      // finding is demoted to a question via the standard blocked path.
      blocked_reason: incomplete ? 'unit_unknown' : null
    },
    extra: {
      reason: incomplete ? 'ownership_sum_possibly_incomplete' : 'ownership_sum',
      holder_count: holders.length,
      holders: holders.map(n => ({
        subject: n.subject,
        value: n.consensus_value,
        sources: n.distinct_source_docs
      })),
      esop_treated_as_separate: esopIsSeparate,
      esop_value: esopNode ? esopNode.consensus_value : null,
      total: round(total, 3),
      gap_pp: round(gapPp, 3),
      basis_class: basisClass
    }
  });
}

/**
 * Does the new investor's stated stake match the round economics?
 *
 * new_investor_% = round_size / post_money_valuation x 100
 *
 * Only fires when a shareholder actually looks like the incoming investor, since matching the
 * wrong holder against the round would be worse than saying nothing.
 */
function checkNewInvestorStake(periodKey, basisClass, graph) {
  const roundSize = graph.index.one('round_size', periodKey, basisClass);
  const postMoney = graph.index.one('post_money_valuation', periodKey, basisClass);

  if (!roundSize || !postMoney) return null;
  if (roundSize.consensus_value === null || postMoney.consensus_value === null) return null;
  if (roundSize.blocked_reason || postMoney.blocked_reason) return null;
  if (postMoney.consensus_value <= 0) return null;

  // Both figures must be in one currency, or the ratio is meaningless.
  const currencies = new Set(
    [roundSize, postMoney].flatMap(n => n.observations.map(o => o.currency).filter(Boolean))
  );
  if (currencies.size > 1) return null;

  const investorNode = findNewInvestorNode(periodKey, basisClass, graph);
  if (!investorNode) return null;

  const computed = (roundSize.consensus_value / postMoney.consensus_value) * 100;
  const stated = investorNode.consensus_value;
  const gapPp = stated - computed;

  const tolerance = rulepack.tolerances.percentage_point_metrics.ownership;
  const within = Math.abs(gapPp) <= tolerance;

  const currency = roundSize.observations[0] ? roundSize.observations[0].currency : 'INR';

  return makeFinding({
    rule_id: 'R7.new_investor_stake',
    rule_class: 'R7',
    metric_key: 'ownership',
    period_key: periodKey,
    node: investorNode,
    graph,
    observations: [...roundSize.observations, ...postMoney.observations, ...investorNode.observations],
    computation: {
      expression: 'round_size / post_money_valuation x 100 = new investor ownership %',
      substituted: `${formatAmount(roundSize.consensus_value, currency)} / ${formatAmount(postMoney.consensus_value, currency)} x 100` +
        ` = ${round(computed, 2)}%   [cap table states ${round(stated, 2)}% for ${investorNode.subject}]`,
      stated,
      computed,
      delta_abs: gapPp,
      delta_pct: null,
      tolerance_abs: tolerance,
      result: within ? 'PASS' : 'FAIL',
      blocked_reason: null
    },
    extra: {
      reason: 'new_investor_stake',
      investor_subject: investorNode.subject,
      round_size: roundSize.consensus_value,
      post_money: postMoney.consensus_value,
      computed_pct: round(computed, 3),
      stated_pct: round(stated, 3),
      basis_class: basisClass
    }
  });
}

/** Words that identify the incoming investor's row in a cap table. */
const NEW_INVESTOR_HINTS = ['new investor', 'incoming', 'series', 'proposed', 'this round', 'lead investor'];

function findNewInvestorNode(periodKey, basisClass, graph) {
  const holders = graph.index
    .all('ownership', periodKey, basisClass)
    .filter(n => n.consensus_value !== null && n.subject);

  const matches = holders.filter(n =>
    NEW_INVESTOR_HINTS.some(hint => n.subject.includes(hint))
  );

  // Exactly one match, or we cannot be sure which row is the new money.
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Does a separately stated ESOP pool match the ESOP row in the cap table?
 *
 * Only meaningful when both exist as distinct figures - which happens when a deck quotes an
 * ESOP percentage and the cap table lists an ESOP holder line.
 */
function checkEsopPool(periodKey, basisClass, graph) {
  const esopNode = graph.index.one('esop_pool', periodKey, basisClass);
  if (!esopNode || esopNode.consensus_value === null || esopNode.blocked_reason) return null;

  const esopHolder = graph.index
    .all('ownership', periodKey, basisClass)
    .find(n => n.subject && /\besop\b|option pool/.test(n.subject) && n.consensus_value !== null);

  if (!esopHolder) return null;

  const stated = esopNode.consensus_value;
  const inCapTable = esopHolder.consensus_value;
  const gapPp = stated - inCapTable;

  const tolerance = rulepack.tolerances.percentage_point_metrics.esop_pool;
  const within = Math.abs(gapPp) <= tolerance;

  return makeFinding({
    rule_id: 'R7.esop_pool',
    rule_class: 'R7',
    metric_key: 'esop_pool',
    period_key: periodKey,
    node: esopNode,
    graph,
    observations: [...esopNode.observations, ...esopHolder.observations],
    computation: {
      expression: 'stated ESOP pool % = ESOP line in cap table',
      substituted: `stated ${round(stated, 2)}% vs cap table ${round(inCapTable, 2)}%   [gap ${round(Math.abs(gapPp), 2)} percentage points]`,
      stated,
      computed: inCapTable,
      delta_abs: gapPp,
      delta_pct: null,
      tolerance_abs: tolerance,
      result: within ? 'PASS' : 'FAIL',
      blocked_reason: null
    },
    extra: {
      reason: 'esop_pool_mismatch',
      stated_pct: round(stated, 3),
      cap_table_pct: round(inCapTable, 3),
      basis_class: basisClass
    }
  });
}

function periodsIn(graph) {
  return [...new Set(graph.nodes.map(n => n.period_key))].filter(p => p && p !== 'UNKNOWN');
}

function round(n, places) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

module.exports = { run, RULE_CLASS: 'R7' };
