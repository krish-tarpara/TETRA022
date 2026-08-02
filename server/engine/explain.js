/**
 * Deterministic narration.
 *
 * Turns findings into plain English and investor questions using templates - no AI, no network,
 * no possibility of failure. This exists so the report is complete on its own: if Groq is
 * rate-limited, down, or out of credit, the user still gets a full, readable, scored report
 * and only loses some polish.
 *
 * That is the whole reason the LLM sits outside the critical path. The narrator in
 * services/ai/narrator.js may replace these strings with better prose, but it can only ever
 * improve on a working baseline - it can never be the difference between a report and an error
 * page.
 *
 * Templates are written to be specific rather than generic. "The pitch deck states Rs 5.2 Cr
 * where the audited statements state Rs 3.2 Cr, a difference of 62.5%" is more useful than
 * "a discrepancy was detected in revenue", and costs nothing extra to produce.
 */

const rulepack = require('./rulepack.json');
const { formatAmount } = require('./canonicalize/currency');
const { labelOf, unitOf } = require('../services/normalization/taxonomyMap');

/**
 * Fill in narrative and follow_up_question on every finding that lacks them.
 *
 * Mutates in place and returns the same array. Only writes to those two fields - never to a
 * value, a score, or a classification.
 */
function explainAll(findings) {
  for (const finding of findings) {
    if (!finding.narrative) finding.narrative = narrate(finding);
    if (!finding.follow_up_question) finding.follow_up_question = question(finding);
    finding.narrative_source = finding.narrative_source || 'template';
  }
  return findings;
}

/** One or two sentences describing what was found. */
function narrate(finding) {
  const metric = finding.metric_label || labelOf(finding.metric_key);
  const period = humanPeriod(finding.period_key);
  const comp = finding.computation || {};

  if (comp.blocked_reason) return blockedNarrative(finding, metric, period);

  switch (finding.rule_class) {
    case 'R1': return crossSourceNarrative(finding, metric, period);
    case 'R2': return identityNarrative(finding, metric, period);
    case 'R3': return rollupNarrative(finding, metric, period);
    case 'R4': return temporalNarrative(finding, metric, period);
    case 'R5': return coverageNarrative(finding, metric, period);
    case 'R6': return plausibilityNarrative(finding, metric, period);
    case 'R7': return captableNarrative(finding, metric, period);
    default: return `${metric} for ${period}: ${comp.expression || 'checked'}.`;
  }
}

function crossSourceNarrative(finding, metric, period) {
  const comp = finding.computation;
  const sources = finding.details.sources || [];

  if (finding.classification === 'VERIFIED_CONSISTENT') {
    const names = sources.map(s => s.filename).join(' and ');
    const gap = comp.delta_pct;

    // "Agrees" reads as "identical", which is misleading when the figures differ by a few percent
    // and merely fall inside this metric's tolerance. Say which it is.
    if (gap !== null && gap !== undefined && gap > 0.05) {
      const tol = comp.tolerance_abs !== undefined && comp.tolerance_abs !== null
        ? `${comp.tolerance_abs} percentage points`
        : `${comp.tolerance_pct}%`;
      return `${metric} for ${period} differs by ${pct(gap)} across ${sources.length} documents ` +
        `(${names}), which is within the ${tol} tolerance for this metric. Treated as consistent.`;
    }

    return `${metric} for ${period} agrees across ${sources.length} documents (${names}). ` +
      `No action needed.`;
  }

  const sorted = [...sources].sort((a, b) => b.value_anchor - a.value_anchor);
  const high = sorted[0];
  const low = sorted[sorted.length - 1];

  let text = `${high.filename} states ${metric} for ${period} as ` +
    `${money(high.value_anchor, finding)}, while ${low.filename} states ` +
    `${money(low.value_anchor, finding)} - a difference of ${pct(comp.delta_pct)}.`;

  // The self-serving direction is the part an investor reacts to, so say it in words rather
  // than leaving it as a multiplier in the score breakdown.
  const dir = finding.factors && finding.factors.detail && finding.factors.detail.direction;
  if (dir && dir.reason === 'self_serving') {
    text += ` The figure in the less authoritative document is the more favourable one.`;
  }

  if (finding.details.outliers && finding.details.outliers.length === 1 && sources.length > 2) {
    text += ` ${finding.details.outliers[0].filename} is the only document that disagrees, ` +
      `which suggests an out-of-date figure rather than a systematic problem.`;
  }

  if (comp.fx_applied && comp.fx_applied.length > 0) {
    const rate = comp.fx_applied[0];
    text += ` This comparison used an exchange rate of ${rate.rate} for ${rate.pair.replace('_', '/')}, ` +
      `which you supplied.`;
  }

  return text;
}

function identityNarrative(finding, metric, period) {
  const comp = finding.computation;

  if (finding.classification === 'VERIFIED_CONSISTENT') {
    return `${metric} for ${period} reconciles correctly: ${comp.expression}.`;
  }

  const docs = finding.details.documents_involved || [];
  const where = comp.single_document && docs.length === 1
    ? `within ${docs[0]} alone`
    : `across ${docs.join(' and ')}`;

  let text = `The figures ${where} do not reconcile for ${period}. ` +
    `${comp.expression} gives ${money(comp.computed, finding)}, but ${money(comp.stated, finding)} is stated ` +
    `- a difference of ${pct(comp.delta_pct)}.`;

  if (comp.single_document) {
    text += ` This is an internal inconsistency: the document contradicts itself.`;
  }

  const culprit = finding.details.likely_culprit;
  if (culprit && culprit.metric_key) {
    text += ` If the other figures are correct, ${labelOf(culprit.metric_key)} would need to be ` +
      `${money(culprit.would_need_to_be, finding)}.`;
  }

  return text;
}

function rollupNarrative(finding, metric, period) {
  const comp = finding.computation;
  const d = finding.details;
  const grain = d.granularity_from === 'month' ? 'monthly' : 'quarterly';

  if (finding.classification === 'VERIFIED_CONSISTENT') {
    return `The ${d.component_count} ${grain} ${metric} figures add up to the stated total for ${period}.`;
  }

  let text = `The ${d.component_count} ${grain} ${metric} figures add up to ` +
    `${money(comp.computed, finding)}, but the total stated for ${period} is ` +
    `${money(comp.stated, finding)} - a difference of ${pct(comp.delta_pct)}.`;

  if (d.likely_culprit) {
    text += ` ${humanPeriod(d.likely_culprit.period_key)} is the closest match to the gap, ` +
      `so it is the most likely place the error sits.`;
  }

  return text;
}

function temporalNarrative(finding, metric, period) {
  const d = finding.details;

  if (d.reason === 'margin_step_change') {
    return `${metric} is projected to reach ${pct(d.projected.value, 1)} in ` +
      `${humanPeriod(d.projected.period_key)}, against a best historical result of ` +
      `${pct(d.best_historical.value, 1)} in ${humanPeriod(d.best_historical.period_key)} ` +
      `- a step of ${d.step_pp} percentage points. This is an assumption rather than an error, ` +
      `but it carries a large part of the forecast.`;
  }

  if (d.reason === 'burn_drop_without_headcount_reduction') {
    return `Burn is projected to fall by ${pct(d.drop_pct, 1)} in ${period}, but ${d.headcount_note}. ` +
      `Since salaries usually dominate burn, this reduction needs an explanation.`;
  }

  if (d.reason === 'reversal_from_decline_to_growth') {
    return `${metric} declined over the historical period, but is projected to grow ` +
      `${pct(d.implied_growth_pct, 1)} in ${period}. A reversal of this size needs a stated cause.`;
  }

  if (d.reason === 'no_trend_available_large_absolute_growth') {
    return `${metric} is projected to grow ${pct(d.implied_growth_pct, 1)} in ${period}. ` +
      `There is not enough history in the documents to judge whether this is consistent with past ` +
      `performance.`;
  }

  return `${metric} grew at approximately ${pct(d.trailing_cagr_pct, 1)} per year historically, ` +
    `but is projected to grow ${pct(d.implied_growth_pct, 1)} in ${period} - about ` +
    `${d.growth_ratio} times the historical rate. This is an assumption, not an error, but it is ` +
    `doing significant work in the forecast.`;
}

function coverageNarrative(finding, metric, period) {
  const d = finding.details;
  const claimedIn = (d.claimed_in || []).join(', ');

  if (d.sub_type === 'derivable_not_stated') {
    return `${claimedIn} states ${metric} for ${period}, and no other document states it directly. ` +
      `It can be derived from other figures (${d.derivation.expression}) in ` +
      `${d.derivation.from_documents.join(', ')}, so the number is supportable but not stated ` +
      `independently.`;
  }

  const searched = (d.documents_searched || []).length;
  return `${claimedIn} states ${metric} for ${period}, but no supporting figure appears in ` +
    `${searched === 0 ? 'any other document' : `any of the ${searched} other documents provided`}. ` +
    `This claim cannot be verified against the current document set.`;
}

function plausibilityNarrative(finding, metric, period) {
  const comp = finding.computation;
  const d = finding.details;

  const value = d.derived ? comp.computed : comp.stated;
  const base = d.derived
    ? `${metric} for ${period} works out to ${plain(value, d.band.unit, finding)} from the figures provided`
    : `${metric} for ${period} is stated as ${plain(value, d.band.unit, finding)}`;

  let text = `${base}, which is outside the plausible range. ${d.assumption}`;
  if (d.likely_cause) text += ` ${d.likely_cause}`;
  return text;
}

function captableNarrative(finding, metric, period) {
  const comp = finding.computation;
  const d = finding.details;

  if (d.reason === 'ownership_sum_possibly_incomplete') {
    return `The ${d.holder_count} shareholdings identified for ${period} total ` +
      `${pct(d.total, 2)}, which is ${pct(Math.abs(d.gap_pp), 2)} short of 100%. ` +
      `This most likely means not every shareholder was read from the document, rather than an ` +
      `error in the cap table. Worth confirming the full shareholder list.`;
  }

  if (d.reason === 'ownership_sum') {
    if (finding.classification === 'VERIFIED_CONSISTENT') {
      return `The ${d.holder_count} shareholdings for ${period} total 100% as expected.`;
    }
    const dir = d.gap_pp > 0 ? 'over' : 'short of';
    return `The ${d.holder_count} shareholdings for ${period} total ${pct(d.total, 2)}, ` +
      `which is ${points(Math.abs(d.gap_pp))} ${dir} 100%. A cap table that does not total 100% ` +
      `means the ownership split is not fully defined.`;
  }

  if (d.reason === 'new_investor_stake') {
    if (finding.classification === 'VERIFIED_CONSISTENT') {
      return `The new investor's stake of ${pct(d.stated_pct, 2)} matches the round economics.`;
    }
    return `The cap table gives the incoming investor ${pct(d.stated_pct, 2)}, but a raise of ` +
      `${money(d.round_size, finding)} at a post-money valuation of ${money(d.post_money, finding)} ` +
      `implies ${pct(d.computed_pct, 2)}. One of the three figures is inconsistent with the other two.`;
  }

  if (d.reason === 'esop_pool_mismatch') {
    if (finding.classification === 'VERIFIED_CONSISTENT') {
      return `The stated ESOP pool matches the cap table.`;
    }
    return `The ESOP pool is stated as ${pct(d.stated_pct, 2)} but appears as ` +
      `${pct(d.cap_table_pct, 2)} in the cap table. The difference affects founder and investor ` +
      `dilution.`;
  }

  return `${metric} for ${period}: ${comp.expression}.`;
}

function blockedNarrative(finding, metric, period) {
  const comp = finding.computation;

  if (comp.blocked_reason === 'currency_mismatch') {
    const currencies = (finding.details.currencies || []).join(' and ');
    return `${metric} for ${period} is stated in more than one currency (${currencies}) and no ` +
      `exchange rate was supplied, so these figures could not be compared. This is not a finding ` +
      `against the documents - supply a rate and the comparison will run.`;
  }

  return `${metric} for ${period} could not be verified (${comp.blocked_reason}). ` +
    `Reported as unresolved rather than as a discrepancy.`;
}

// ── Follow-up questions ──────────────────────────────────────────────────────────

/**
 * The question an investor would actually send the founder.
 *
 * Specific, quotable, and answerable. "Please explain the difference in revenue" wastes a round
 * trip; naming both documents, both figures and the period does not.
 */
function question(finding) {
  const metric = finding.metric_label || labelOf(finding.metric_key);
  const period = humanPeriod(finding.period_key);
  const comp = finding.computation || {};

  if (finding.classification === 'VERIFIED_CONSISTENT') return null;

  if (comp.blocked_reason === 'currency_mismatch') {
    return `Which currency are the ${metric} figures for ${period} reported in, and what exchange ` +
      `rate should be used to compare them?`;
  }

  switch (finding.rule_class) {
    case 'R1': {
      const sources = finding.details.sources || [];
      const sorted = [...sources].sort((a, b) => b.value_anchor - a.value_anchor);
      if (sorted.length < 2) return `Can you confirm the correct ${metric} figure for ${period}?`;
      return `Your ${sorted[0].filename} reports ${metric} for ${period} as ` +
        `${money(sorted[0].value_anchor, finding)}, while ${sorted[sorted.length - 1].filename} reports ` +
        `${money(sorted[sorted.length - 1].value_anchor, finding)}. Which figure is correct, and what ` +
        `accounts for the difference?`;
    }

    case 'R2':
      return `In ${(finding.details.documents_involved || []).join(' and ')}, ${comp.expression} ` +
        `does not hold for ${period}: the figures give ${money(comp.computed, finding)} but ` +
        `${money(comp.stated, finding)} is stated. Can you provide a reconciliation?`;

    case 'R3':
      return `Your ${finding.details.granularity_from === 'month' ? 'monthly' : 'quarterly'} ` +
        `${metric} figures sum to ${money(comp.computed, finding)}, but the total for ${period} is ` +
        `stated as ${money(comp.stated, finding)}. Can you confirm which is correct?`;

    case 'R4':
      if (finding.details.reason === 'margin_step_change') {
        return `What specific changes support ${metric} improving to ` +
          `${pct(finding.details.projected.value, 1)} in ${humanPeriod(finding.details.projected.period_key)}, ` +
          `given your best historical result was ${pct(finding.details.best_historical.value, 1)}?`;
      }
      if (finding.details.reason === 'burn_drop_without_headcount_reduction') {
        return `Your projections show burn falling by ${pct(finding.details.drop_pct, 1)} in ${period} ` +
          `while headcount does not fall. Which cost lines are being reduced?`;
      }
      return `Your projections assume ${metric} grows ${pct(finding.details.implied_growth_pct, 1)} in ` +
        `${period}, against a historical rate of about ${pct(finding.details.trailing_cagr_pct, 1)}. ` +
        `What specifically drives that acceleration?`;

    case 'R5':
      if (finding.details.sub_type === 'derivable_not_stated') {
        return `Can you confirm that the ${metric} figure of ${money(comp.stated, finding)} for ` +
          `${period} is derived from ${finding.details.derivation.expression}, and provide the ` +
          `underlying working?`;
      }
      return `Can you provide documentation supporting the ${metric} figure of ` +
        `${money(comp.stated, finding)} for ${period} stated in ` +
        `${(finding.details.claimed_in || []).join(', ')}?`;

    case 'R6':
      return `${metric} for ${period} appears as ` +
        `${plain(finding.details.derived ? comp.computed : comp.stated, finding.details.band.unit, finding)}, ` +
        `which is outside the possible range. Can you confirm the units and the correct figure?`;

    case 'R7':
      if (finding.details.reason === 'ownership_sum_possibly_incomplete') {
        return `Can you provide the complete shareholder list for ${period}? The rows identified ` +
          `total ${pct(finding.details.total, 2)}.`;
      }
      if (finding.details.reason === 'new_investor_stake') {
        return `The cap table shows the incoming investor at ${pct(finding.details.stated_pct, 2)}, ` +
          `but the round size and post-money valuation imply ${pct(finding.details.computed_pct, 2)}. ` +
          `Which is correct?`;
      }
      if (finding.details.reason === 'esop_pool_mismatch') {
        return `Is the ESOP pool ${pct(finding.details.stated_pct, 2)} or ` +
          `${pct(finding.details.cap_table_pct, 2)}, and is it on a pre- or post-money basis?`;
      }
      return `Can you provide a cap table for ${period} where the shareholdings total 100%?`;

    default:
      return `Can you clarify the ${metric} figure for ${period}?`;
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────────

/**
 * Turn a canonical period key into something a person would say.
 *
 * `M03-FY2024-25` becoming "March 2025" matters here - the code is correct but nobody reads
 * fiscal-year month codes fluently, and a narrative full of them is unusable.
 */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function humanPeriod(periodKey) {
  if (!periodKey || periodKey === 'UNKNOWN') return 'an unstated period';

  const month = periodKey.match(/^M(\d\d)-FY(\d{4})-(\d\d)$/);
  if (month) {
    const monthNum = parseInt(month[1], 10);
    const fyStart = parseInt(month[2], 10);
    // Months 1-3 (Jan-Mar) fall in the second calendar year of an April-March fiscal year.
    const calendarYear = monthNum >= rulepack.fiscal.start_month ? fyStart : fyStart + 1;
    return `${MONTH_NAMES[monthNum - 1]} ${calendarYear}`;
  }

  const quarter = periodKey.match(/^Q(\d)-(FY\d{4}-\d\d)$/);
  if (quarter) return `Q${quarter[1]} ${quarter[2]}`;

  const relative = periodKey.match(/^REL-Y(\d)$/);
  if (relative) return `projected year ${relative[1]}`;

  return periodKey;
}

/**
 * Format a value in the unit of the metric the finding is ABOUT.
 *
 * Taking the unit from `evidence[0]` was wrong and produced visibly broken output. An identity like
 * `gross_profit / revenue x 100 = gross_margin` cites currency operands as its first evidence, so a
 * computed margin of 37.5 was rendered "Rs 38". The metric key is the only reliable source of the
 * unit, because it describes the result rather than whichever input happened to be listed first.
 */
function money(value, finding) {
  if (value === null || value === undefined) return 'an unstated figure';
  const unit = unitOf(finding.metric_key) || firstEvidenceUnit(finding) || 'currency';
  return plain(value, unit, finding);
}

function firstEvidenceUnit(finding) {
  const evidence = (finding.evidence || [])[0];
  return evidence ? evidence.unit : null;
}

function plain(value, unit, finding) {
  if (value === null || value === undefined) return '-';

  const evidence = (finding.evidence || [])[0] || {};
  const currency = evidence.currency || rulepack.fiscal.base_currency;

  if (unit === 'pct') return `${round(value, 2)}%`;
  if (unit === 'count') return Math.round(value).toLocaleString('en-IN');
  if (unit === 'months') return `${round(value, 1)} months`;
  if (unit === 'ratio') return `${round(value, 2)}x`;
  return formatAmount(value, currency);
}

/**
 * Percentage-POINT differences, which are not the same thing as a percentage.
 *
 * A cap table totalling 93 is 7 percentage points short of 100, not "7% short". Writing the
 * second is the kind of imprecision an investor notices immediately.
 */
function points(value, places = 2) {
  if (value === null || value === undefined) return 'an unknown amount';
  const rounded = round(value, places);
  return `${rounded} percentage point${rounded === 1 ? '' : 's'}`;
}

function pct(value, places = 2) {
  if (value === null || value === undefined) return 'an unknown amount';
  return `${round(value, places)}%`;
}

function round(n, places) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

/**
 * An overall assessment for the top of the report.
 *
 * Templated, so the one-page summary is never blank even with no AI available.
 */
function executiveSummary(breakdown, findings) {
  const counts = breakdown.counts;
  const problems = findings.filter(f => f.classification !== 'VERIFIED_CONSISTENT');
  const worst = problems[0];

  const parts = [];

  parts.push(
    `Across ${breakdown.coverage.document_types_present.length} document types, ` +
    `${breakdown.coverage.nodes_checked} figures were examined and ` +
    `${breakdown.coverage.nodes_corroborated} could be cross-checked against a second document.`
  );

  if (problems.length === 0) {
    parts.push('No inconsistencies were found.');
  } else {
    const bits = [];
    if (counts.VERIFIED_MISMATCH) bits.push(`${counts.VERIFIED_MISMATCH} confirmed mismatch${counts.VERIFIED_MISMATCH === 1 ? '' : 'es'}`);
    if (counts.MISSING_INFORMATION) bits.push(`${counts.MISSING_INFORMATION} unsupported or missing item${counts.MISSING_INFORMATION === 1 ? '' : 's'}`);
    if (counts.UNUSUAL_ASSUMPTION_CHANGE) bits.push(`${counts.UNUSUAL_ASSUMPTION_CHANGE} unusual assumption${counts.UNUSUAL_ASSUMPTION_CHANGE === 1 ? '' : 's'}`);
    if (counts.UNRESOLVED_INCONSISTENCY) bits.push(`${counts.UNRESOLVED_INCONSISTENCY} item${counts.UNRESOLVED_INCONSISTENCY === 1 ? '' : 's'} that could not be verified`);
    parts.push(`The review identified ${bits.join(', ')}.`);
  }

  if (worst) {
    const weakest = Object.values(breakdown.pillars)
      .filter(p => p.applicable)
      .sort((a, b) => a.score - b.score)[0];
    if (weakest) {
      parts.push(`The weakest area is ${weakest.label.toLowerCase()} (${weakest.score}/100), ` +
        `driven principally by ${worst.ref_code}.`);
    }
  }

  if (breakdown.ceiling_applied) {
    parts.push(
      `The score is capped at ${breakdown.ceiling} because only ` +
      `${breakdown.coverage.nodes_corroborated} of ${breakdown.coverage.nodes_checked} figures ` +
      `could be independently corroborated. Additional documents would raise this ceiling.`
    );
  }

  return parts.join(' ');
}

module.exports = { explainAll, narrate, question, executiveSummary, humanPeriod, points };
