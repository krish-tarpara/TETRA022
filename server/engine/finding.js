/**
 * Finding assembly.
 *
 * Rules describe *what* they found - the equation, the numbers, the evidence. This file turns
 * that description into a scored, classified, reference-coded finding. Keeping it in one place
 * means every rule gets identical severity treatment, and a change to the scoring model cannot
 * accidentally apply to some rules and not others.
 *
 * A finding is designed to be self-contained: everything needed to render it, defend it, or
 * recompute it is inside the object. No rule needs to be re-run to explain its own output.
 */

const crypto = require('crypto');
const rulepack = require('./rulepack.json');
const { scoreFinding } = require('./severity');
const { classify, pillarFor } = require('./classify');
const { labelOf } = require('../services/normalization/taxonomyMap');

/** Short codes so ref codes read like audit references: REV-R1-001. */
const METRIC_ABBREV = {
  revenue: 'REV', arr: 'ARR', mrr: 'MRR', revenue_growth: 'GRW',
  cogs: 'COGS', gross_profit: 'GP', gross_margin: 'GM',
  opex: 'OPEX', ebitda: 'EBITDA', ebitda_margin: 'EBM',
  net_profit: 'NP', net_margin: 'NM',
  depreciation_amortization: 'DA', interest_expense: 'INT', tax_expense: 'TAX',
  total_assets: 'ASST', liabilities: 'LIAB', equity: 'EQTY',
  cash_position: 'CASH', opening_cash: 'OCSH', closing_cash: 'CCSH',
  net_cash_flow: 'NCF', burn_rate: 'BURN', cash_runway: 'RWAY',
  customer_base: 'CUST', churn_rate: 'CHRN', cac: 'CAC', ltv: 'LTV', ltv_cac_ratio: 'LTVC',
  ownership: 'OWN', esop_pool: 'ESOP', valuation: 'VAL',
  pre_money_valuation: 'PRE', post_money_valuation: 'POST', round_size: 'RND',
  headcount: 'HC', revenue_per_employee: 'RPE', tam: 'TAM'
};

/**
 * @param {object} spec
 * @param {string} spec.rule_id        e.g. 'R2.gross_profit'
 * @param {string} spec.rule_class     'R1'..'R7'
 * @param {string} spec.metric_key
 * @param {string} [spec.period_key]
 * @param {object} spec.computation    { expression, substituted, stated, computed, delta_abs, delta_pct, tolerance_pct|tolerance_abs, result, blocked_reason }
 * @param {Array}  spec.observations   observations the finding is built from
 * @param {object} [spec.node]         source fact node, when there is one
 * @param {object} [spec.graph]        fact graph, for the scale anchor
 * @param {object} [spec.extra]        rule-specific payload, stored under details
 * @returns {object} finding
 */
function makeFinding(spec) {
  const scored = scoreFinding({
    rule_class: spec.rule_class,
    metric_key: spec.metric_key,
    computation: spec.computation,
    observations: spec.observations || [],
    node: spec.node,
    graph: spec.graph,
    crossed_currency: spec.crossed_currency
  });

  const classified = classify({
    rule_class: spec.rule_class,
    computation: spec.computation,
    confidence_factor: scored.confidence_factor
  });

  // A confirmation has no severity - it is not a problem. Reporting "VERIFIED_CONSISTENT,
  // severity 6, MINOR" alongside a green tick reads as a contradiction, and scoring already
  // excludes these findings, so the number served no purpose.
  const isConfirmation = classified.classification === 'VERIFIED_CONSISTENT';

  return {
    finding_id: crypto.randomUUID(),
    ref_code: null, // assigned by assignRefCodes once the full set is known
    rule_id: spec.rule_id,
    rule_class: spec.rule_class,
    rulepack_version: rulepack.version,

    classification: classified.classification,
    classification_reason: classified.reason,
    severity_score: isConfirmation ? 0 : scored.severity_score,
    severity_band: isConfirmation ? 'NONE' : scored.severity_band,
    pillar: pillarFor(spec.rule_class),

    metric_key: spec.metric_key,
    metric_label: labelOf(spec.metric_key),
    period_key: spec.period_key || (spec.node ? spec.node.period_key : null),

    computation: spec.computation,
    factors: scored.factors,
    evidence: buildEvidence(spec.observations || [], spec.node),

    node_key: spec.node ? spec.node.node_key : null,
    details: spec.extra || {},

    // Filled by L7. Templates in explain.js guarantee these are never empty in the report.
    narrative: null,
    follow_up_question: null,
    adjudication: null
  };
}

/**
 * Evidence rows. Every finding must be traceable to a page and a verbatim quote, because a
 * finding nobody can check is indistinguishable from one we made up.
 */
function buildEvidence(observations, node) {
  return observations.map(obs => {
    const nodeValue = node && node.values
      ? node.values.find(v => v.observation_id === obs.observation_id)
      : null;

    return {
      observation_id: obs.observation_id,
      document_id: obs.document_id,
      filename: obs.filename,
      document_category: obs.document_category,
      page: obs.source ? obs.source.page : null,
      cell: obs.source ? obs.source.cell : null,
      quote: obs.source ? obs.source.quote : null,
      raw_label: obs.raw_label,
      value_raw: obs.value_raw,
      value_base: obs.value_base,
      value_anchor: nodeValue ? nodeValue.value_anchor : obs.value_base,
      currency: obs.currency,
      unit: obs.unit,
      basis: obs.basis,
      period_key: obs.period_key
    };
  });
}

/**
 * Assign stable reference codes.
 *
 * Sorted by severity first so REV-R1-001 is always the worst revenue conflict, which makes
 * the codes useful in conversation ("what's REV-R1-001?") rather than just unique.
 */
function assignRefCodes(findings) {
  const counters = new Map();

  const sorted = [...findings].sort((a, b) => b.severity_score - a.severity_score);

  for (const finding of sorted) {
    const abbrev = METRIC_ABBREV[finding.metric_key] || finding.metric_key.slice(0, 4).toUpperCase();
    const prefix = `${abbrev}-${finding.rule_class}`;
    const n = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, n);
    finding.ref_code = `${prefix}-${String(n).padStart(3, '0')}`;
  }

  return sorted;
}

/** Percentage gap between a stated and a computed value, guarding division by zero. */
function deltaPct(stated, computed) {
  const denom = Math.max(Math.abs(stated), Math.abs(computed));
  if (denom === 0) return 0;
  return (Math.abs(stated - computed) / denom) * 100;
}

module.exports = { makeFinding, assignRefCodes, deltaPct, buildEvidence, METRIC_ABBREV };
