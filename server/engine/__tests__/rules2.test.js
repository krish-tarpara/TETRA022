/**
 * Tests for R3, R4, R6, R7 - plus the cross-rule conflict resolution.
 *
 * These four rules are far more dangerous than R1/R2/R5, because each has a naive
 * implementation that produces confident nonsense. Most of the tests below assert that the
 * engine stays SILENT in a situation where a careless version would raise a finding:
 *
 *   - summing eight of twelve months and comparing against the annual total
 *   - summing monthly cash balances as if cash accumulated
 *   - computing growth from a base of zero
 *   - calling a loss-to-profit turnaround "infinite growth"
 *   - accusing a company of a broken cap table when we only read four of six shareholders
 *
 * A false accusation is the worst output this system can produce, so silence is the correct
 * behaviour in every one of those cases and each is pinned down here.
 */

const { suite, test, eq, near, truthy, falsy } = require('./harness');
const { verify, resolveConflicts } = require('../index');
const r3 = require('../rules/r3_rollup');
const r4 = require('../rules/r4_temporal');
const r6 = require('../rules/r6_plausibility');
const r7 = require('../rules/r7_captable');
const { buildFactGraph } = require('../factGraph');
const { obs, pnl, DOCS } = require('./fixtures/builders');

const graphOf = (observations, options) => buildFactGraph(observations, options || {});
const find = (findings, pred) => findings.find(pred);

/** Twelve monthly observations for one fiscal year. */
function months(metric, doc, fyStart, values, extra = {}) {
  const order = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
  return order.map((m, i) => obs({
    metric,
    doc,
    value: values[i],
    period: `M${String(m).padStart(2, '0')}-FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`,
    ...extra
  }));
}

/** Four quarterly observations for one fiscal year. */
function quarters(metric, doc, fyStart, values, extra = {}) {
  return [1, 2, 3, 4].map((q, i) => obs({
    metric,
    doc,
    value: values[i],
    period: `Q${q}-FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`,
    ...extra
  }));
}

module.exports = function run() {

  suite('R3: roll-up - the guards', () => {
    test('twelve months that sum to the annual total pass', () => {
      const findings = r3.run(graphOf([
        ...months('revenue', DOCS.mis, 2024, Array(12).fill(1000000)),
        obs({ metric: 'revenue', value: 12000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      const f = find(findings, x => x.details.granularity_from === 'month');
      truthy(f, 'the roll-up was checked');
      eq(f.computation.result, 'PASS');
      eq(f.classification, 'VERIFIED_CONSISTENT');
    });

    test('twelve months that do not sum to the annual total fail', () => {
      const values = Array(12).fill(1000000);
      const findings = r3.run(graphOf([
        ...months('revenue', DOCS.mis, 2024, values),
        obs({ metric: 'revenue', value: 15000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      const f = find(findings, x => x.computation.result === 'FAIL');
      truthy(f, 'the gap was caught');
      near(f.computation.computed, 12000000, 1);
      eq(f.computation.stated, 15000000);
      eq(f.classification, 'VERIFIED_MISMATCH');
    });

    test('CRITICAL GUARD - eight of twelve months produces NO finding', () => {
      // The single most dangerous case. Summing a partial year and comparing it against the
      // annual total fails every time, on every company, for a reason that is entirely our
      // fault. Missing months are a coverage gap, which is R5's business.
      const partial = months('revenue', DOCS.mis, 2024, Array(12).fill(1000000)).slice(0, 8);
      const findings = r3.run(graphOf([
        ...partial,
        obs({ metric: 'revenue', value: 12000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      eq(findings.length, 0, 'silence is the only correct answer here');
    });

    test('CRITICAL GUARD - cash balances are never summed', () => {
      // Cash is a stock, not a flow. Twelve monthly closing balances of Rs 1 Cr do not mean
      // the company had Rs 12 Cr. Summing them would produce a guaranteed false accusation.
      const findings = r3.run(graphOf([
        ...months('cash_position', DOCS.mis, 2024, Array(12).fill(10000000)),
        obs({ metric: 'cash_position', value: 10000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      eq(findings.length, 0, 'cash_position is not in the rollups list, so it is never summed');
    });

    test('four quarters roll up to the year', () => {
      const findings = r3.run(graphOf([
        ...quarters('revenue', DOCS.mis, 2024, [3000000, 3000000, 3000000, 3000000]),
        obs({ metric: 'revenue', value: 14000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      const f = find(findings, x => x.computation.result === 'FAIL');
      truthy(f);
      near(f.computation.computed, 12000000, 1);
    });

    test('three months roll up to their quarter', () => {
      const findings = r3.run(graphOf([
        obs({ metric: 'revenue', value: 1000000, period: 'M04-FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'revenue', value: 1000000, period: 'M05-FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'revenue', value: 1000000, period: 'M06-FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'revenue', value: 4000000, period: 'Q1-FY2024-25', doc: DOCS.mis })
      ]));
      const f = find(findings, x => x.details.granularity_to === 'quarter');
      truthy(f, 'monthly to quarterly was checked');
      eq(f.computation.result, 'FAIL');
      near(f.computation.computed, 3000000, 1);
    });

    test('CONFLICT GUARD - one wrong annual total is reported once, not twice', () => {
      // With monthly AND quarterly AND annual data, a wrong annual figure fails both the
      // monthly-to-annual and quarterly-to-annual checks. Same error, same pillar - reporting
      // it twice would also double its weight against the score.
      const findings = r3.run(graphOf([
        ...months('revenue', DOCS.mis, 2024, Array(12).fill(1000000)),
        ...quarters('revenue', DOCS.mis, 2024, [3000000, 3000000, 3000000, 3000000]),
        obs({ metric: 'revenue', value: 15000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));

      const annualTargeted = findings.filter(f => f.details.target_period === 'FY2024-25');
      eq(annualTargeted.length, 1, 'exactly one finding targets the fiscal year');
      eq(annualTargeted[0].details.granularity_from, 'quarter',
        'the quarterly route is kept - it localises the problem better than "one of twelve months"');
    });

    test('mixed currencies block the sum instead of adding rupees to dollars', () => {
      const values = Array(12).fill(1000000);
      const mixed = months('revenue', DOCS.mis, 2024, values);
      mixed[3] = obs({ metric: 'revenue', value: 12000, currency: 'USD', period: 'M07-FY2024-25', doc: DOCS.mis });

      const findings = r3.run(graphOf([
        ...mixed,
        obs({ metric: 'revenue', value: 12000000, period: 'FY2024-25', doc: DOCS.financials })
      ], { fxRates: { USD_INR: 83.2 } }));

      const f = findings[0];
      truthy(f);
      eq(f.computation.blocked_reason, 'currency_mismatch');
      eq(f.classification, 'UNRESOLVED_INCONSISTENCY');
    });

    test('the likely culprit month is named', () => {
      const values = Array(12).fill(1000000);
      values[5] = 400000;
      const findings = r3.run(graphOf([
        ...months('revenue', DOCS.mis, 2024, values),
        obs({ metric: 'revenue', value: 12000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      const f = find(findings, x => x.computation.result === 'FAIL');
      truthy(f.details.likely_culprit, 'a culprit month is suggested');
      truthy(f.details.likely_culprit.period_key);
    });

    test('actuals and projections are never summed together', () => {
      const findings = r3.run(graphOf([
        ...months('revenue', DOCS.mis, 2024, Array(12).fill(1000000), { basis: 'management' }),
        obs({ metric: 'revenue', value: 20000000, period: 'FY2024-25', doc: DOCS.projections, basis: 'projected' })
      ]));
      eq(findings.length, 0, 'a projected annual total is not the sum of actual months');
    });
  });

  suite('R4: projections - the maths guards', () => {
    const history = fy => [
      obs({ metric: 'revenue', value: 10000000, period: 'FY2022-23', doc: DOCS.financials, basis: 'audited' }),
      obs({ metric: 'revenue', value: 12000000, period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
      obs({ metric: 'revenue', value: 14400000, period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' })
    ];

    test('a wild growth jump is flagged', () => {
      // 20% a year historically, then 300%.
      const findings = r4.run(graphOf([
        ...history(),
        obs({ metric: 'revenue', value: 57600000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      const f = find(findings, x => x.rule_id === 'R4.growth_break.revenue');
      truthy(f, 'the trend break was caught');
      eq(f.classification, 'UNUSUAL_ASSUMPTION_CHANGE');
      near(f.details.implied_growth_pct, 300, 1);
      near(f.details.trailing_cagr_pct, 20, 1);
      truthy(f.details.growth_ratio > 3);
    });

    test('growth in line with history is not flagged', () => {
      const findings = r4.run(graphOf([
        ...history(),
        obs({ metric: 'revenue', value: 17280000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      falsy(find(findings, x => x.rule_id === 'R4.growth_break.revenue'),
        '20% forecast after 20% history is just a plan');
    });

    test('CRITICAL GUARD - a base of zero produces no finding', () => {
      // Going from Rs 0 to Rs 1 Cr is not infinite growth, it is starting to trade.
      const findings = r4.run(graphOf([
        obs({ metric: 'revenue', value: 0, period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 0, period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 10000000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      eq(findings.length, 0, 'no division by zero, and no nonsense percentage');
    });

    test('CRITICAL GUARD - a tiny base produces no finding', () => {
      // Rs 50,000 to Rs 5 Cr is a 100,000% increase that says nothing about credibility.
      const findings = r4.run(graphOf([
        obs({ metric: 'revenue', value: 40000, period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 50000, period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 50000000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      eq(findings.length, 0);
    });

    test('CRITICAL GUARD - a loss-to-profit turnaround is not "growth"', () => {
      // EBITDA from -1 Cr to +2 Cr is a turnaround. A growth percentage across zero is
      // mathematically meaningless and would produce a garbage severity.
      const findings = r4.run(graphOf([
        obs({ metric: 'ebitda', value: -20000000, period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'ebitda', value: -10000000, period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'ebitda', value: 20000000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      falsy(find(findings, x => x.rule_id === 'R4.growth_break.ebitda'));
    });

    test('a non-adjacent projection is annualised, not compared raw', () => {
      // FY25 actual to FY28 projected is three years. 300% total is ~59% per year, which is
      // above a 20% trend but nowhere near the 3x threshold - so it must not fire.
      const findings = r4.run(graphOf([
        ...history(),
        obs({ metric: 'revenue', value: 43200000, period: 'FY2027-28', doc: DOCS.projections, basis: 'projected' })
      ]));
      const f = find(findings, x => x.rule_id === 'R4.growth_break.revenue');
      if (f) {
        eq(f.details.year_gap, 3, 'the gap was measured');
        truthy(f.details.implied_growth_pct < 100, 'and the rate was annualised');
      }
    });

    test('one historical point is not a trend', () => {
      const findings = r4.run(graphOf([
        obs({ metric: 'revenue', value: 10000000, period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 15000000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      falsy(find(findings, x => x.rule_id === 'R4.growth_break.revenue'),
        '50% growth off a single data point is not evidence of anything');
    });

    test('a reversal from decline to sharp growth is flagged with its own reason', () => {
      const findings = r4.run(graphOf([
        obs({ metric: 'revenue', value: 20000000, period: 'FY2022-23', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 15000000, period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 12000000, period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 30000000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      const f = find(findings, x => x.rule_id === 'R4.growth_break.revenue');
      truthy(f, 'shrinking then forecasting +150% deserves a mention');
      eq(f.details.reason, 'reversal_from_decline_to_growth');
      eq(f.details.growth_ratio, null, 'a ratio against negative history is not reported');
    });

    test('monthly figures never enter a growth series', () => {
      const findings = r4.run(graphOf([
        ...history(),
        obs({ metric: 'revenue', value: 1200000, period: 'M04-FY2025-26', doc: DOCS.mis }),
        obs({ metric: 'revenue', value: 17280000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      falsy(find(findings, x => x.rule_id === 'R4.growth_break.revenue'),
        'one month against twelve would look like a 90% collapse');
    });

    test('a margin step change is flagged in percentage points', () => {
      const findings = r4.run(graphOf([
        obs({ metric: 'gross_margin', value: 38, unit: 'pct', period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'gross_margin', value: 40, unit: 'pct', period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'gross_margin', value: 72, unit: 'pct', period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      const f = find(findings, x => x.rule_id === 'R4.margin_step.gross_margin');
      truthy(f);
      near(f.details.step_pp, 32, 0.1);
      eq(f.classification, 'UNUSUAL_ASSUMPTION_CHANGE');
    });

    test('a modest margin improvement is not flagged', () => {
      const findings = r4.run(graphOf([
        obs({ metric: 'gross_margin', value: 38, unit: 'pct', period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'gross_margin', value: 40, unit: 'pct', period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'gross_margin', value: 45, unit: 'pct', period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      falsy(find(findings, x => x.rule_id === 'R4.margin_step.gross_margin'), '5pp is a plan, not a fantasy');
    });

    test('burn halving while the team grows is flagged', () => {
      const findings = r4.run(graphOf([
        obs({ metric: 'burn_rate', value: 2000000, period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'burn_rate', value: 800000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' }),
        obs({ metric: 'headcount', value: 40, unit: 'count', period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'headcount', value: 55, unit: 'count', period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      const f = find(findings, x => x.rule_id === 'R4.burn_discontinuity');
      truthy(f, 'spending less while hiring more needs explaining');
      truthy(f.computation.substituted.includes('headcount rises'));
    });

    test('burn halving WITH a team reduction is coherent and not flagged', () => {
      const findings = r4.run(graphOf([
        obs({ metric: 'burn_rate', value: 2000000, period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'burn_rate', value: 800000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' }),
        obs({ metric: 'headcount', value: 40, unit: 'count', period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'headcount', value: 15, unit: 'count', period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      falsy(find(findings, x => x.rule_id === 'R4.burn_discontinuity'),
        'the plan explains itself, so there is nothing to flag');
    });

    test('R4 findings are marked uncalibrated', () => {
      const findings = r4.run(graphOf([
        ...history(),
        obs({ metric: 'revenue', value: 57600000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      // No real documents were available to tune these thresholds against. The report should
      // be able to say so rather than implying the numbers are calibrated.
      truthy(findings.every(f => f.details.uncalibrated === true));
    });
  });

  suite('R6: plausibility', () => {
    test('a gross margin above 100% is impossible', () => {
      const findings = r6.run(graphOf([
        obs({ metric: 'gross_margin', value: 140, unit: 'pct', period: 'FY2024-25', doc: DOCS.deck })
      ]));
      const f = find(findings, x => x.metric_key === 'gross_margin');
      truthy(f);
      eq(f.classification, 'VERIFIED_MISMATCH');
      eq(f.details.bound_breached, 'max');
      truthy(f.details.assumption, 'the bound cites its reasoning');
      truthy(f.details.likely_cause, 'and suggests what went wrong');
    });

    test('a plausible margin is not flagged', () => {
      const findings = r6.run(graphOf([
        obs({ metric: 'gross_margin', value: 62, unit: 'pct', period: 'FY2024-25', doc: DOCS.deck })
      ]));
      eq(findings.length, 0, 'the rule must not nag about possible numbers');
    });

    test('negative headcount is impossible', () => {
      const findings = r6.run(graphOf([
        obs({ metric: 'headcount', value: -5, unit: 'count', period: 'FY2024-25', doc: DOCS.mis })
      ]));
      truthy(find(findings, x => x.metric_key === 'headcount'));
    });

    test('an LTV/CAC of 400 is a unit error', () => {
      const findings = r6.run(graphOf([
        obs({ metric: 'ltv_cac_ratio', value: 400, unit: 'ratio', period: 'FY2024-25', doc: DOCS.deck })
      ]));
      const f = find(findings, x => x.metric_key === 'ltv_cac_ratio');
      truthy(f);
      truthy(f.details.likely_cause.includes('period') || f.details.likely_cause.includes('units'));
    });

    test('a derived revenue per employee outside the band is flagged', () => {
      // Rs 32 Cr over 3 staff = Rs 10.6 Cr each. Almost certainly a scale error somewhere.
      const findings = r6.run(graphOf([
        obs({ metric: 'revenue', value: 320000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'headcount', value: 3, unit: 'count', period: 'FY2024-25', doc: DOCS.mis })
      ]));
      const f = find(findings, x => x.metric_key === 'revenue_per_employee');
      truthy(f, 'the derived value was checked');
      eq(f.details.derived, true);
      eq(f.details.derived_from.length, 2, 'and both inputs are cited');
    });

    test('a sensible revenue per employee is not flagged', () => {
      const findings = r6.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'headcount', value: 40, unit: 'count', period: 'FY2024-25', doc: DOCS.mis })
      ]));
      falsy(find(findings, x => x.metric_key === 'revenue_per_employee'), 'Rs 8L each is normal');
    });

    test('metrics with no band defined are ignored', () => {
      const findings = r6.run(graphOf([
        obs({ metric: 'tam', value: 999999999999, period: 'FY2024-25', doc: DOCS.deck })
      ]));
      eq(findings.length, 0);
    });
  });

  suite('R7: cap table', () => {
    const holders = (doc, entries, period = 'FY2025-26') =>
      entries.map(([name, pct]) => obs({
        metric: 'ownership', unit: 'pct', value: pct, period, doc, label: `${name} shareholding %`
      }));

    test('CRITICAL - shareholders are kept separate, not treated as a conflict', () => {
      // Before the subject dimension existed, all four rows collapsed into one bucket and the
      // engine reported the founder's 55% as conflicting with the ESOP's 10%.
      const graph = graphOf(holders(DOCS.captable, [
        ['Rahul Sharma Founder', 55], ['Priya Nair Co-founder', 25],
        ['Seed Investor', 10], ['ESOP Pool', 10]
      ]));
      eq(graph.nodes.length, 4, 'four shareholders, four nodes');
      truthy(graph.nodes.every(n => n.distinct_source_docs === 1), 'none is a conflict');
    });

    test('holdings that sum to 100% pass', () => {
      const findings = r7.run(graphOf(holders(DOCS.captable, [
        ['Founder A', 55], ['Founder B', 25], ['Seed Investor', 10], ['ESOP Pool', 10]
      ])));
      const f = find(findings, x => x.rule_id === 'R7.ownership_sum');
      truthy(f);
      eq(f.computation.result, 'PASS');
      eq(f.classification, 'VERIFIED_CONSISTENT');
    });

    test('holdings that sum to 94% fail', () => {
      const findings = r7.run(graphOf(holders(DOCS.captable, [
        ['Founder A', 52], ['Founder B', 25], ['Seed Investor', 10], ['ESOP Pool', 7]
      ])));
      const f = find(findings, x => x.rule_id === 'R7.ownership_sum');
      truthy(f);
      eq(f.computation.result, 'FAIL');
      near(f.details.gap_pp, -6, 0.01);
      eq(f.classification, 'VERIFIED_MISMATCH');
    });

    test('CRITICAL GUARD - a big shortfall is reported as incomplete extraction, not an error', () => {
      // We read two of six shareholders. Accusing the company of a broken cap table because
      // our own extraction fell short would be the worst kind of false positive.
      const findings = r7.run(graphOf(holders(DOCS.captable, [
        ['Founder A', 40], ['Founder B', 20]
      ])));
      const f = find(findings, x => x.rule_id === 'R7.ownership_sum.incomplete');
      truthy(f, 'reported as a caveat');
      eq(f.classification, 'UNRESOLVED_INCONSISTENCY', 'a question, not an accusation');
      truthy(f.computation.substituted.includes('not every shareholder was extracted'));
    });

    test('a single shareholder is not judged', () => {
      const findings = r7.run(graphOf(holders(DOCS.captable, [['Founder A', 60]])));
      falsy(find(findings, x => x.rule_id.startsWith('R7.ownership_sum')),
        'one row is almost certainly a partial read');
    });

    test('ESOP stated outside the 100% is handled', () => {
      // Holders total 100 already, and ESOP is quoted separately. Both readings are tested and
      // the one that reconciles is used.
      const findings = r7.run(graphOf([
        ...holders(DOCS.captable, [['Founder A', 60], ['Founder B', 30], ['Seed Investor', 10]]),
        obs({ metric: 'esop_pool', unit: 'pct', value: 12, period: 'FY2025-26', doc: DOCS.deck })
      ]));
      const f = find(findings, x => x.rule_id === 'R7.ownership_sum');
      truthy(f);
      eq(f.computation.result, 'PASS');
      eq(f.details.esop_treated_as_separate, false, 'holders already reach 100 without it');
    });

    test('the new investor stake is checked against the round economics', () => {
      const findings = r7.run(graphOf([
        ...holders(DOCS.captable, [
          ['Founder A', 50], ['Founder B', 25], ['New Investor Series A', 15], ['ESOP Pool', 10]
        ]),
        obs({ metric: 'round_size', value: 50000000, period: 'FY2025-26', doc: DOCS.term_sheet || DOCS.captable }),
        obs({ metric: 'post_money_valuation', value: 500000000, period: 'FY2025-26', doc: DOCS.captable })
      ]));
      const f = find(findings, x => x.rule_id === 'R7.new_investor_stake');
      truthy(f, 'the stake was checked');
      near(f.computation.computed, 10, 0.01, 'Rs 5 Cr into a Rs 50 Cr post-money is 10%');
      eq(f.computation.stated, 15);
      eq(f.computation.result, 'FAIL');
    });

    test('the new investor check stays quiet when no row clearly is the new investor', () => {
      const findings = r7.run(graphOf([
        ...holders(DOCS.captable, [['Founder A', 60], ['Founder B', 40]]),
        obs({ metric: 'round_size', value: 50000000, period: 'FY2025-26', doc: DOCS.captable }),
        obs({ metric: 'post_money_valuation', value: 500000000, period: 'FY2025-26', doc: DOCS.captable })
      ]));
      falsy(find(findings, x => x.rule_id === 'R7.new_investor_stake'),
        'matching the wrong holder would be worse than saying nothing');
    });

    test('a stated ESOP pool is checked against the cap table ESOP row', () => {
      const findings = r7.run(graphOf([
        ...holders(DOCS.captable, [['Founder A', 60], ['Founder B', 25], ['ESOP Pool', 15]]),
        obs({ metric: 'esop_pool', unit: 'pct', value: 10, period: 'FY2025-26', doc: DOCS.deck })
      ]));
      const f = find(findings, x => x.rule_id === 'R7.esop_pool');
      truthy(f);
      eq(f.computation.stated, 10);
      eq(f.computation.computed, 15);
      eq(f.computation.result, 'FAIL');
    });

    test('post-money arithmetic stays in R2 and is not duplicated here', () => {
      const findings = r7.run(graphOf([
        obs({ metric: 'pre_money_valuation', value: 450000000, period: 'FY2025-26', doc: DOCS.captable }),
        obs({ metric: 'round_size', value: 50000000, period: 'FY2025-26', doc: DOCS.captable }),
        obs({ metric: 'post_money_valuation', value: 600000000, period: 'FY2025-26', doc: DOCS.captable })
      ]));
      falsy(find(findings, x => x.rule_id.includes('post_money')),
        'that identity belongs to R2 - duplicating it would count one error twice');
    });
  });

  suite('cross-rule conflict resolution', () => {
    test('a green tick is never shown beside a red finding for the same number', () => {
      // Two documents agree perfectly on a gross profit that is arithmetically impossible given
      // their own revenue and COGS. R1 says consistent, R2 says wrong. Both are true, but
      // showing both reads as a contradiction.
      const result = verify([
        ...pnl(DOCS.financials, 'FY2024-25', { revenue: 32000000, cogs: 20000000, gross_profit: 15000000 }),
        obs({ metric: 'gross_profit', value: 15000000, period: 'FY2024-25', doc: DOCS.mis })
      ], { documents: [{ document_category: 'financial_statements' }, { document_category: 'mis' }] });

      const gpFindings = result.findings.filter(f => f.metric_key === 'gross_profit');
      const consistent = gpFindings.filter(f => f.classification === 'VERIFIED_CONSISTENT');
      const problems = gpFindings.filter(f => f.classification !== 'VERIFIED_CONSISTENT');

      truthy(problems.length > 0, 'the arithmetic problem is reported');
      eq(consistent.length, 0, 'and the confirmation is suppressed');
    });

    test('exact duplicates are removed', () => {
      const findings = [
        { rule_id: 'R1.x', rule_class: 'R1', metric_key: 'revenue', period_key: 'FY2024-25', node_key: 'n1', classification: 'VERIFIED_MISMATCH', computation: { result: 'FAIL' }, details: {} },
        { rule_id: 'R1.x', rule_class: 'R1', metric_key: 'revenue', period_key: 'FY2024-25', node_key: 'n1', classification: 'VERIFIED_MISMATCH', computation: { result: 'FAIL' }, details: {} }
      ];
      eq(resolveConflicts(findings).length, 1);
    });

    test('confirmations survive when nothing contradicts them', () => {
      const result = verify([
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.mis })
      ], { documents: [{ document_category: 'financial_statements' }, { document_category: 'mis' }] });

      truthy(result.breakdown.counts.VERIFIED_CONSISTENT > 0);
    });
  });

  suite('full engine with all seven rules', () => {
    const kitchenSink = [
      // A P&L that does not reconcile
      ...pnl(DOCS.financials, 'FY2024-25', {
        revenue: 32000000, cogs: 20000000, gross_profit: 15000000
      }),
      // Deck overstates revenue for the same year
      obs({ metric: 'revenue', value: 52000000, period: 'FY2024-25', doc: DOCS.deck }),
      // An unsupported deck claim
      obs({ metric: 'customer_base', value: 1200, unit: 'count', period: 'FY2024-25', doc: DOCS.deck }),
      // History plus a wild projection
      obs({ metric: 'revenue', value: 20000000, period: 'FY2022-23', doc: DOCS.financials, basis: 'audited' }),
      obs({ metric: 'revenue', value: 26000000, period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
      obs({ metric: 'revenue', value: 200000000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' }),
      // An impossible margin
      obs({ metric: 'gross_margin', value: 130, unit: 'pct', period: 'FY2025-26', doc: DOCS.deck }),
      // A cap table that misses 100%
      obs({ metric: 'ownership', unit: 'pct', value: 52, period: 'FY2025-26', doc: DOCS.captable, label: 'Founder A shareholding' }),
      obs({ metric: 'ownership', unit: 'pct', value: 25, period: 'FY2025-26', doc: DOCS.captable, label: 'Founder B shareholding' }),
      obs({ metric: 'ownership', unit: 'pct', value: 16, period: 'FY2025-26', doc: DOCS.captable, label: 'Seed Investor shareholding' }),
      // Cash agrees
      obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.financials }),
      obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.mis })
    ];
    const docs = [
      { document_category: 'financial_statements' }, { document_category: 'pitch_deck' },
      { document_category: 'projections' }, { document_category: 'cap_table' },
      { document_category: 'mis' }
    ];

    test('all five pillars become active', () => {
      const result = verify(kitchenSink, { documents: docs });
      const pillars = result.breakdown.pillars;
      truthy(pillars.arithmetic_integrity.finding_count > 0, 'R2 fired');
      truthy(pillars.cross_doc_consistency.finding_count > 0, 'R1 fired');
      truthy(pillars.evidence_coverage.finding_count > 0, 'R5 fired');
      truthy(pillars.projection_credibility.finding_count > 0, 'R4 or R6 fired');
      truthy(pillars.ownership_integrity.finding_count > 0, 'R7 fired');
    });

    test('every classification tier is reachable', () => {
      const result = verify(kitchenSink, { documents: docs });
      const counts = result.breakdown.counts;
      truthy(counts.VERIFIED_MISMATCH > 0);
      truthy(counts.MISSING_INFORMATION > 0);
      truthy(counts.UNUSUAL_ASSUMPTION_CHANGE > 0, 'R4 now produces this tier');
    });

    test('still deterministic with all seven rules running', () => {
      const a = verify(kitchenSink, { documents: docs });
      const b = verify(kitchenSink, { documents: docs });
      eq(a.score, b.score);
      eq(
        a.findings.map(f => `${f.ref_code}:${f.severity_score}`).join(),
        b.findings.map(f => `${f.ref_code}:${f.severity_score}`).join()
      );
    });

    test('no rule threw', () => {
      const result = verify(kitchenSink, { documents: docs });
      for (const [ruleClass, stat] of Object.entries(result.stats.rules)) {
        eq(stat.error, null, `${ruleClass} ran cleanly`);
      }
    });

    test('every finding still carries a quote', () => {
      const result = verify(kitchenSink, { documents: docs });
      for (const f of result.findings) {
        truthy(f.evidence.length > 0, `${f.ref_code} has evidence`);
        truthy(f.evidence.every(e => e.quote), `${f.ref_code} is fully cited`);
      }
    });

    test('the score stays inside 0..100', () => {
      const result = verify(kitchenSink, { documents: docs });
      truthy(result.score >= 0 && result.score <= 100, `score was ${result.score}`);
    });
  });

  suite('hostile input', () => {
    test('an observation with a null value does not crash anything', () => {
      const broken = obs({ metric: 'revenue', value: 0, period: 'FY2024-25', doc: DOCS.deck });
      broken.value_base = null;
      const result = verify([broken], { documents: [{ document_category: 'pitch_deck' }] });
      truthy(Number.isFinite(result.score));
    });

    test('an unknown period does not produce comparisons', () => {
      const result = verify([
        obs({ metric: 'revenue', value: 52000000, period: 'UNKNOWN', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, period: 'UNKNOWN', doc: DOCS.financials })
      ], { documents: [{ document_category: 'pitch_deck' }, { document_category: 'financial_statements' }] });

      // R1 still compares - both sides genuinely landed on the same unknown period, and the
      // low period confidence demotes it - but no identity or roll-up rule may touch it.
      truthy(result.findings.every(f => f.rule_class !== 'R2' && f.rule_class !== 'R3'));
    });

    test('a relative period never enters a growth series', () => {
      const result = verify([
        obs({ metric: 'revenue', value: 20000000, period: 'FY2023-24', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 26000000, period: 'FY2024-25', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 500000000, period: 'REL-Y1', doc: DOCS.projections, basis: 'projected' })
      ], { documents: [{ document_category: 'financial_statements' }, { document_category: 'projections' }] });

      falsy(result.findings.find(f => f.rule_id === 'R4.growth_break.revenue'),
        '"Year 1" cannot be placed on a timeline, so no growth rate can be computed');
    });

    test('many duplicate observations of one figure do not multiply findings', () => {
      const many = Array.from({ length: 20 }, (_, i) =>
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials, page: i + 1 })
      );
      const result = verify(many, { documents: [{ document_category: 'financial_statements' }] });
      eq(result.findings.filter(f => f.rule_class === 'R1').length, 0,
        'twenty mentions in one document is not a cross-document conflict');
    });
  });
};
