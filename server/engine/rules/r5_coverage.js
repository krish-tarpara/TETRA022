/**
 * R5 - Coverage / unsupported claim.
 *
 * The pitch deck asserts a number. Does anything else in the data room back it up?
 *
 * This is the rule that catches what a comparison-only engine structurally cannot: a claim
 * with nothing to compare against. A tool that only looks for conflicts reports a deck full
 * of unbacked assertions as perfectly clean, because there is no second number to disagree
 * with. Absence of evidence is the finding.
 *
 * Severity scales with the metric's importance, so an unsupported revenue claim ranks far
 * above an unsupported TAM claim - which matches how an investor actually reads a deck. TAM
 * is always a guess; revenue is supposed to be a fact.
 */

const rulepack = require('../rulepack.json');
const { makeFinding } = require('../finding');
const { formatAmount } = require('../canonicalize/currency');
const { labelOf, unitOf } = require('../../services/normalization/taxonomyMap');

const DECK_CATEGORIES = new Set(rulepack.deck_categories);

/**
 * Metrics nobody expects a deck to substantiate. Flagging these would bury the real findings
 * under noise, and noise is how a verification tool loses trust.
 */
const NOT_EXPECTED_TO_BE_BACKED = new Set(['tam']);

function run(graph) {
  const findings = [];

  for (const node of graph.nodes) {
    const deckObservations = node.observations.filter(o => DECK_CATEGORIES.has(o.document_category));
    if (deckObservations.length === 0) continue;

    if (NOT_EXPECTED_TO_BE_BACKED.has(node.metric_key)) continue;

    // Backed if any non-deck document states the same metric for the same period and basis.
    const corroborating = node.observations.filter(o => !DECK_CATEGORIES.has(o.document_category));
    if (corroborating.length > 0) continue;

    // Before calling it unsupported, check whether the claim is derivable from other
    // documents. A deck stating ARR that no statement mentions is still substantiated if the
    // statements give MRR - the number exists, just under a different name.
    const derivable = findDerivation(node, graph);

    findings.push(unsupportedFinding(node, deckObservations, graph, derivable));
  }

  return findings;
}

/**
 * Can this claim be reconstructed from non-deck documents via an identity?
 *
 * Reported rather than acted on: the claim is still not *directly* evidenced, so it stays a
 * finding, but the severity drops and the follow-up question changes from "please provide
 * documentation" to "please confirm this is the derived figure".
 */
function findDerivation(node, graph) {
  for (const identity of rulepack.identities) {
    if (identity.result !== node.metric_key) continue;

    const operands = identityOperands(identity);
    const resolved = operands.map(key => graph.index.one(key, node.period_key, node.basis_class));

    if (resolved.every(n => n && n.consensus_value !== null)) {
      const nonDeckSources = resolved.flatMap(n =>
        n.observations.filter(o => !DECK_CATEGORIES.has(o.document_category))
      );
      if (nonDeckSources.length >= operands.length) {
        return {
          identity_id: identity.id,
          expression: identity.expression,
          from_documents: [...new Set(nonDeckSources.map(o => o.filename))]
        };
      }
    }
  }
  return null;
}

function identityOperands(identity) {
  if (identity.type === 'linear') return identity.terms.map(([, key]) => key);
  if (identity.type === 'ratio') return [identity.numerator, identity.denominator];
  if (identity.type === 'product') return [identity.operand];
  return [];
}

function unsupportedFinding(node, deckObservations, graph, derivable) {
  const primary = deckObservations[0];
  const unit = node.unit || unitOf(node.metric_key);
  const valueDisplay = fmt(node.consensus_value, unit, primary.currency);

  const documentsSearched = [...new Set(
    graph.nodes
      .flatMap(n => n.observations)
      .filter(o => !DECK_CATEGORIES.has(o.document_category))
      .map(o => o.filename)
  )];

  return makeFinding({
    rule_id: derivable ? 'R5.derivable_only' : 'R5.unsupported_claim',
    rule_class: 'R5',
    metric_key: node.metric_key,
    period_key: node.period_key,
    node,
    graph,
    observations: deckObservations,
    computation: {
      expression: `${labelOf(node.metric_key)} @ ${node.period_key} claimed in deck, evidence sought in all other documents`,
      substituted: derivable
        ? `${primary.filename} states ${valueDisplay}. Not stated directly elsewhere, but derivable via ${derivable.expression} from ${derivable.from_documents.join(', ')}.`
        : `${primary.filename} states ${valueDisplay}. No supporting figure found in ${documentsSearched.length > 0 ? documentsSearched.join(', ') : 'any other document'}.`,
      stated: node.consensus_value,
      computed: null,
      delta_abs: null,
      // A coverage gap has no variance to measure. Materiality therefore rests entirely on
      // the metric's importance, which is exactly the intended behaviour: how bad an
      // unsupported claim is depends on what was claimed, not on any arithmetic.
      delta_pct: null,
      tolerance_pct: null,
      result: 'UNSUPPORTED',
      blocked_reason: null
    },
    extra: {
      sub_type: derivable ? 'derivable_not_stated' : 'unsupported_claim',
      claimed_in: [...new Set(deckObservations.map(o => o.filename))],
      documents_searched: documentsSearched,
      derivation: derivable,
      // Drives the coverage ratio in the readiness score.
      contributes_to_coverage_gap: true
    }
  });
}

function fmt(value, unit, currency) {
  if (value === null || value === undefined) return '-';
  if (unit === 'pct') return `${round(value, 2)}%`;
  if (unit === 'count') return Math.round(value).toLocaleString('en-IN');
  if (unit === 'months') return `${round(value, 1)} months`;
  if (unit === 'ratio') return `${round(value, 2)}x`;
  return formatAmount(value, currency || 'INR');
}

function round(n, places) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

module.exports = { run, RULE_CLASS: 'R5' };
