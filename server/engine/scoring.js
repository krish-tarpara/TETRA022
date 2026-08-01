/**
 * Readiness score. Five pillars, saturating, with a coverage ceiling.
 *
 * The naive formula (100 - sum of weights) fails in two directions at once:
 *
 *   - It goes negative. Twelve findings and you are at -20, which means nothing.
 *   - It is linear, so twelve trivial findings score worse than three catastrophic ones.
 *     That is backwards: an investor cares far more about one broken balance sheet than
 *     about twelve headcount rounding differences.
 *
 * Saturation fixes both. Within a pillar, `100K/(K + sum)` means the first serious finding
 * costs a lot and the twentieth trivial one costs almost nothing, and the result can never
 * leave 0..100.
 *
 * The coverage ceiling fixes a third, worse problem: a single tidy pitch deck with nothing to
 * contradict it scored 100 under the old formula. That is the most misleading output the
 * system could possibly produce. A claim nobody checked is not a claim that passed.
 */

const rulepack = require('./rulepack.json');

const PILLARS = rulepack.pillars;
const K = rulepack.scoring.saturation_k;
const CEILING = rulepack.scoring.ceiling;

/**
 * @param {Array}  findings   scored findings from the rule engine
 * @param {object} graph      the fact graph
 * @param {Array}  documents  [{ document_category }]
 * @returns {object} score breakdown
 */
function calculateScore(findings, graph, documents) {
  // Positive confirmations do not subtract from the score. They are reported, and they raise
  // the coverage ratio, but "we verified this and it was fine" must never cost points.
  const negative = findings.filter(f => f.classification !== 'VERIFIED_CONSISTENT');

  const pillars = {};
  for (const [name, def] of Object.entries(PILLARS)) {
    const pillarFindings = negative.filter(f => f.pillar === name);
    const severitySum = pillarFindings.reduce((sum, f) => sum + f.severity_score, 0);

    // A pillar with nothing to check scores 100 but is marked not_applicable, so the UI can
    // show "no cap table uploaded" rather than implying a clean bill of health.
    const applicable = isPillarApplicable(name, def, graph, findings);

    pillars[name] = {
      name,
      label: def.label,
      weight: def.weight,
      score: round(100 * K / (K + severitySum), 1),
      severity_sum: round(severitySum, 1),
      finding_count: pillarFindings.length,
      applicable,
      top_findings: pillarFindings
        .sort((a, b) => b.severity_score - a.severity_score)
        .slice(0, 3)
        .map(f => ({ ref_code: f.ref_code, severity: f.severity_score, metric: f.metric_key }))
    };
  }

  const base = Object.values(pillars).reduce((sum, p) => sum + p.score * p.weight, 0);
  const coverage = calculateCoverage(graph, documents);
  const finalScore = Math.round(Math.min(base, coverage.ceiling));

  return {
    score: finalScore,
    base_score: round(base, 1),
    ceiling: coverage.ceiling,
    ceiling_applied: coverage.ceiling < base,
    band: bandFor(finalScore),
    label: rulepack.scoring.labels[bandFor(finalScore)],
    pillars,
    coverage,
    counts: countByClassification(findings),
    rulepack_version: rulepack.version
  };
}

/**
 * Was there anything for this pillar to examine?
 *
 * Distinguishes "we checked the cap table and it was fine" from "you never gave us a cap
 * table". Both score 100, but only the first one means anything.
 */
function isPillarApplicable(name, def, graph, findings) {
  if (findings.some(f => f.pillar === name)) return true;

  if (name === 'ownership_integrity') {
    return graph.nodes.some(n => n.metric_key === 'ownership' || n.metric_key === 'esop_pool');
  }
  if (name === 'projection_credibility') {
    return graph.nodes.some(n => n.basis_class === 'forward');
  }
  if (name === 'cross_doc_consistency') {
    return graph.stats.multi_source_nodes > 0;
  }
  return graph.nodes.length > 0;
}

/**
 * The coverage ceiling.
 *
 * Two components. Evidence coverage asks how many claims were actually corroborated by a
 * second independent document. Document-type coverage asks how much of the expected data
 * room showed up at all.
 *
 * A single pitch deck therefore lands at 55 + 45*(0.6*0 + 0.4*0.2) = 58.6 at best. Internally
 * flawless, still not investor-ready, because nothing in it was verifiable. That is the
 * correct answer and the naive formula's 100 was badly wrong.
 */
function calculateCoverage(graph, documents) {
  const nodesChecked = graph.nodes.length;
  const corroborated = graph.nodes.filter(n => n.distinct_source_docs >= 2).length;

  const evidenceRatio = nodesChecked > 0 ? corroborated / nodesChecked : 0;

  const categories = [...new Set((documents || []).map(d => d.document_category).filter(Boolean))];
  const docTypeRatio = Math.min(1, categories.length / CEILING.expected_doc_types);

  const ceiling = CEILING.floor + CEILING.span * (
    CEILING.evidence_weight * evidenceRatio + CEILING.doc_type_weight * docTypeRatio
  );

  return {
    ceiling: round(ceiling, 1),
    evidence_coverage_ratio: round(evidenceRatio, 3),
    doc_type_ratio: round(docTypeRatio, 3),
    nodes_checked: nodesChecked,
    nodes_corroborated: corroborated,
    document_types_present: categories,
    document_types_expected: CEILING.expected_doc_types
  };
}

function countByClassification(findings) {
  const counts = {
    VERIFIED_MISMATCH: 0,
    UNRESOLVED_INCONSISTENCY: 0,
    MISSING_INFORMATION: 0,
    UNUSUAL_ASSUMPTION_CHANGE: 0,
    VERIFIED_CONSISTENT: 0
  };
  for (const f of findings) {
    if (counts[f.classification] !== undefined) counts[f.classification]++;
  }

  counts.unsupported_claims = findings.filter(
    f => f.details && f.details.sub_type === 'unsupported_claim'
  ).length;
  counts.total_findings = findings.length;

  return counts;
}

function bandFor(score) {
  const bands = rulepack.scoring.bands;
  if (score >= bands.READY) return 'READY';
  if (score >= bands.CONDITIONAL) return 'CONDITIONAL';
  if (score >= bands.MATERIAL_GAPS) return 'MATERIAL_GAPS';
  return 'HIGH_RISK';
}

function round(n, places) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

module.exports = { calculateScore, calculateCoverage, bandFor };
