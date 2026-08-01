/**
 * Adjudication - user overrides, then recompute.
 *
 * The engine's verdict is arithmetic, but the inputs to that arithmetic contain assumptions the
 * user is better placed to settle than we are:
 *
 *   "The deck is out of date - treat the audited statements as authoritative."
 *   "We've explained the revenue gap, accept it."
 *   "Use 84.1 for the dollar, not 83.2."
 *   "2% tolerance is too tight for our business, use 5%."
 *
 * Because scoring is pure arithmetic, applying any of these and recomputing takes microseconds
 * rather than another LLM round trip. That is what makes live what-if possible, and it is the
 * single most persuasive thing this system can demonstrate: a reviewer challenges an assumption,
 * and the score moves in front of them with the changed pillars highlighted.
 *
 * The integrity rule: an adjudication never edits a finding. It re-runs the whole engine with
 * altered inputs and records what was altered. Nothing is silently rewritten, so any score can
 * be traced back to the assumptions that produced it.
 */

const { verify } = require('./index');
const rulepack = require('./rulepack.json');

/**
 * @typedef {object} Adjudication
 * @property {string} type              'authoritative_source' | 'accept_explanation' | 'fx_rate' | 'tolerance'
 * @property {string} [document_id]     for authoritative_source
 * @property {string} [finding_ref]     for accept_explanation
 * @property {string} [note]            the user's reason, recorded verbatim
 * @property {object} [fx_rates]        for fx_rate
 * @property {string} [metric_key]      for tolerance
 * @property {number} [tolerance_pct]   for tolerance
 */

/**
 * Re-run verification with user adjudications applied.
 *
 * @param {Array} observations              the session's canonical observations
 * @param {object} options                  { fxRates, documents }
 * @param {Adjudication[]} adjudications    what the user has decided
 * @returns {object} the same shape as verify(), plus an `adjudications` audit trail
 */
function adjudicate(observations, options = {}, adjudications = []) {
  const applied = [];

  // Work on copies. Mutating the stored observations would make the original, un-adjudicated
  // result irrecoverable - and the user must always be able to see what the documents said
  // before anyone started overriding things.
  let workingObservations = observations.map(cloneObservation);
  let workingOptions = { ...options, fxRates: { ...(options.fxRates || {}) } };
  let toleranceOverrides = {};
  const acceptedRefs = new Set();

  for (const adj of adjudications) {
    switch (adj.type) {
      case 'authoritative_source': {
        const result = applyAuthoritativeSource(workingObservations, adj);
        workingObservations = result.observations;
        applied.push({ ...adj, effect: result.effect });
        break;
      }

      case 'fx_rate': {
        workingOptions.fxRates = { ...workingOptions.fxRates, ...adj.fx_rates, source: 'user_adjudicated' };
        applied.push({ ...adj, effect: `Exchange rates updated: ${describeRates(adj.fx_rates)}` });
        break;
      }

      case 'tolerance': {
        if (!adj.metric_key || typeof adj.tolerance_pct !== 'number') {
          applied.push({ ...adj, effect: 'Ignored - a metric_key and numeric tolerance_pct are required.' });
          break;
        }
        toleranceOverrides[adj.metric_key] = adj.tolerance_pct;
        applied.push({
          ...adj,
          effect: `Tolerance for ${adj.metric_key} changed from ${originalTolerance(adj.metric_key)}% to ${adj.tolerance_pct}%`
        });
        break;
      }

      case 'accept_explanation': {
        if (!adj.finding_ref) {
          applied.push({ ...adj, effect: 'Ignored - a finding_ref is required.' });
          break;
        }
        acceptedRefs.add(adj.finding_ref);
        applied.push({ ...adj, effect: `${adj.finding_ref} accepted as explained and excluded from the score.` });
        break;
      }

      default:
        applied.push({ ...adj, effect: `Ignored - unknown adjudication type "${adj.type}".` });
    }
  }

  const restoreTolerances = withTolerances(toleranceOverrides);

  let result;
  try {
    result = verify(workingObservations, workingOptions);
  } finally {
    // Always restore, even if verification throws. The rule pack is module-level state shared
    // by every session in the process, and leaking an override into the next request would make
    // scores depend on who ran before you - the exact opposite of what this engine promises.
    restoreTolerances();
  }

  // Accepted findings are retained and visibly marked, never deleted. A reviewer must be able
  // to see what was waived and by whom - a silently disappeared finding is indistinguishable
  // from one that was never found.
  if (acceptedRefs.size > 0) {
    result = applyAcceptances(result, acceptedRefs, adjudications, workingOptions);
  }

  return {
    ...result,
    adjudications: applied,
    adjudicated: applied.length > 0
  };
}

/**
 * Mark one document as the authority.
 *
 * Rather than deleting the other documents' figures - which would destroy the evidence trail -
 * this raises the authoritative document's confidence to full and reduces the confidence of
 * conflicting figures. Findings survive, but their severity falls and low-confidence ones
 * demote from mismatches to questions.
 *
 * The effect a user expects from "the deck is just out of date" is exactly that: the conflict
 * is still visible, it just stops dominating the score.
 */
const AUTHORITATIVE_CONFIDENCE = 1.0;
const SUPERSEDED_CONFIDENCE_FACTOR = 0.5;

function applyAuthoritativeSource(observations, adj) {
  if (!adj.document_id) {
    return { observations, effect: 'Ignored - a document_id is required.' };
  }

  const target = observations.filter(o => o.document_id === adj.document_id);
  if (target.length === 0) {
    return { observations, effect: `Ignored - no observations belong to document ${adj.document_id}.` };
  }

  // Which (metric, period, basis) combinations does the authority actually cover? Only those
  // are superseded. Marking the statements authoritative says nothing about a customer count
  // they never mention.
  const covered = new Set(
    target.map(o => `${o.metric_key}|${o.period_key}|${o.basis_class}|${o.subject || '-'}`)
  );

  let superseded = 0;

  const updated = observations.map(obs => {
    const key = `${obs.metric_key}|${obs.period_key}|${obs.basis_class}|${obs.subject || '-'}`;

    if (obs.document_id === adj.document_id) {
      return {
        ...obs,
        confidence: { ...obs.confidence, value: AUTHORITATIVE_CONFIDENCE },
        adjudication: { authoritative: true, note: adj.note || null }
      };
    }

    if (covered.has(key)) {
      superseded++;
      return {
        ...obs,
        confidence: {
          ...obs.confidence,
          value: obs.confidence.value * SUPERSEDED_CONFIDENCE_FACTOR
        },
        adjudication: { superseded_by: adj.document_id, note: adj.note || null }
      };
    }

    return obs;
  });

  return {
    observations: updated,
    effect: `${target[0].filename} marked authoritative. ${superseded} conflicting figure(s) in other documents reduced in confidence.`
  };
}

/**
 * Exclude accepted findings from the score without hiding them.
 *
 * The score is recalculated from the remaining findings, but the accepted ones stay in the list
 * flagged as waived so the report still shows what was raised and set aside.
 */
function applyAcceptances(result, acceptedRefs, adjudications, options) {
  const { calculateScore } = require('./scoring');

  const findings = result.findings.map(f => {
    if (!acceptedRefs.has(f.ref_code)) return f;

    const adj = adjudications.find(a => a.finding_ref === f.ref_code);
    return {
      ...f,
      adjudication: {
        type: 'accept_explanation',
        accepted: true,
        note: adj && adj.note ? adj.note : null,
        original_severity: f.severity_score,
        original_classification: f.classification
      },
      // Zeroed for scoring purposes only. The original values are preserved above so the UI can
      // show "was CRITICAL 41.8, accepted as explained".
      severity_score: 0,
      severity_band: 'MINOR'
    };
  });

  const scoreable = findings.filter(f => !(f.adjudication && f.adjudication.accepted));
  const breakdown = calculateScore(scoreable, result.graph, options.documents || []);

  return { ...result, findings, score: breakdown.score, breakdown };
}

/**
 * Temporarily override metric tolerances in the shared rule pack.
 *
 * Returns a restore function. Both the mutation and the restore are deliberately narrow: only
 * `tolerances.by_metric` keys named in the override are touched, and the previous values -
 * including "this key did not exist" - are captured so the restore is exact.
 */
function withTolerances(overrides) {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return () => {};

  const previous = {};
  for (const key of keys) {
    previous[key] = Object.prototype.hasOwnProperty.call(rulepack.tolerances.by_metric, key)
      ? rulepack.tolerances.by_metric[key]
      : undefined;
    rulepack.tolerances.by_metric[key] = overrides[key];
  }

  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete rulepack.tolerances.by_metric[key];
      } else {
        rulepack.tolerances.by_metric[key] = previous[key];
      }
    }
  };
}

function originalTolerance(metricKey) {
  const byMetric = rulepack.tolerances.by_metric[metricKey];
  if (byMetric !== undefined) return byMetric;
  const pp = rulepack.tolerances.percentage_point_metrics[metricKey];
  if (pp !== undefined) return pp;
  return rulepack.tolerances.default_pct;
}

function describeRates(rates) {
  return Object.entries(rates || {})
    .filter(([k]) => k !== 'source' && k !== 'as_of')
    .map(([pair, rate]) => `${pair} = ${rate}`)
    .join(', ');
}

/** Deep-enough copy: only the fields adjudication touches need to be independent. */
function cloneObservation(obs) {
  return {
    ...obs,
    confidence: { ...obs.confidence },
    source: { ...obs.source }
  };
}

/**
 * Compare two runs so the UI can show what an adjudication changed.
 *
 * The demo beat: score 62 becomes 81, and this tells you which two pillars moved and by how
 * much, so the change is explained rather than just asserted.
 */
function diff(before, after) {
  const pillars = {};

  for (const name of Object.keys(before.breakdown.pillars)) {
    const b = before.breakdown.pillars[name];
    const a = after.breakdown.pillars[name];
    if (!a) continue;

    pillars[name] = {
      label: b.label,
      before: b.score,
      after: a.score,
      change: round(a.score - b.score, 1),
      changed: Math.abs(a.score - b.score) >= 0.1
    };
  }

  const beforeRefs = new Map(before.findings.map(f => [f.ref_code, f]));
  const reclassified = after.findings
    .filter(f => {
      const prior = beforeRefs.get(f.ref_code);
      return prior && prior.classification !== f.classification;
    })
    .map(f => ({
      ref_code: f.ref_code,
      from: beforeRefs.get(f.ref_code).classification,
      to: f.classification,
      severity_before: beforeRefs.get(f.ref_code).severity_score,
      severity_after: f.severity_score
    }));

  return {
    score: { before: before.score, after: after.score, change: after.score - before.score },
    band: { before: before.breakdown.band, after: after.breakdown.band },
    pillars,
    pillars_changed: Object.values(pillars).filter(p => p.changed).map(p => p.label),
    reclassified,
    finding_count: { before: before.findings.length, after: after.findings.length }
  };
}

function round(n, places) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

module.exports = { adjudicate, diff, withTolerances };
