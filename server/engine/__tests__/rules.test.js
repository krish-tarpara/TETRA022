/**
 * Rule and severity tests.
 *
 * These are the golden fixtures. No real documents exist to calibrate against, so these
 * hand-authored cases ARE the specification: each one states a set of claims and the verdict
 * the engine is required to reach. If the engine ever stops reaching it, `npm test` says so.
 *
 * The two headline cases from the plan are asserted explicitly:
 *   - deck Rs 5.2 Cr vs audited Rs 3.2 Cr revenue    -> CRITICAL
 *   - headcount 42 vs 47 across two management docs  -> low severity
 * Same rule, same mechanism, ~4x apart, entirely from arithmetic. That contrast is the demo.
 */

const { suite, test, eq, near, truthy, falsy } = require('./harness');
const { verify, problems, confirmations } = require('../index');
const r1 = require('../rules/r1_cross_source');
const r2 = require('../rules/r2_identities');
const r5 = require('../rules/r5_coverage');
const { buildFactGraph } = require('../factGraph');
const { obs, pnl, DOCS } = require('./fixtures/builders');

const graphOf = (observations, options) => buildFactGraph(observations, options || {});
const find = (findings, pred) => findings.find(pred);

module.exports = function run() {

  suite('R1: cross-source conflict', () => {
    test('a 62% revenue gap is a VERIFIED_MISMATCH', () => {
      const findings = r1.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck, basis: 'management' }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.auditor, basis: 'audited' })
      ]));
      eq(findings.length, 1);
      eq(findings[0].classification, 'VERIFIED_MISMATCH');
      eq(findings[0].computation.result, 'FAIL');
    });

    test('agreement produces a VERIFIED_CONSISTENT confirmation, not silence', () => {
      const findings = r1.run(graphOf([
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'cash_position', value: 12050000, period: 'FY2024-25', doc: DOCS.mis })
      ]));
      eq(findings.length, 1);
      eq(findings[0].classification, 'VERIFIED_CONSISTENT');
      eq(findings[0].computation.result, 'PASS');
    });

    test('a marginal gap is UNRESOLVED, not an accusation', () => {
      // 3% on revenue: past the 2% tolerance but inside 2x it. Not confident enough to
      // call it a mismatch, too far off to call it consistent.
      const findings = r1.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 33000000, period: 'FY2024-25', doc: DOCS.mis })
      ]));
      eq(findings[0].classification, 'UNRESOLVED_INCONSISTENCY');
      eq(findings[0].classification_reason, 'marginal_variance');
    });

    test('a single document produces no R1 finding', () => {
      const findings = r1.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck })
      ]));
      eq(findings.length, 0, 'self-contradiction is R2 territory');
    });

    test('actuals vs projections is not an R1 conflict', () => {
      const findings = r1.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.financials, basis: 'audited' }),
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.projections, basis: 'projected' })
      ]));
      eq(findings.length, 0, 'a forecast is not a contradiction');
    });

    test('low confidence does NOT demote an agreement', () => {
      // The confidence gate protects against unsupported accusations. Agreement is not an
      // accusation, so a badly-read pair that nonetheless agrees stays a confirmation rather than
      // becoming a manufactured "inconsistency".
      const findings = r1.run(graphOf([
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.deck,
              confidence: { value: 0.5, parse: 0.55 } }),
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.auditor })
      ]));
      eq(findings[0].classification, 'VERIFIED_CONSISTENT');
    });

    test('low confidence demotes a mismatch to a question', () => {
      // Same 62% gap as the headline case, but one number came off an unreadable slide.
      const findings = r1.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck,
              confidence: { value: 0.6, parse: 0.55 } }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.auditor })
      ]));
      eq(findings[0].classification, 'UNRESOLVED_INCONSISTENCY');
      eq(findings[0].classification_reason, 'below_confidence_gate');
    });
  });

  suite('R1: currency', () => {
    test('no FX rate blocks the comparison and says why', () => {
      const findings = r1.run(graphOf([
        obs({ metric: 'revenue', value: 625000, currency: 'USD', period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, currency: 'INR', period: 'FY2025-26', doc: DOCS.auditor })
      ], { fxRates: {} }));

      // The two observations sit on separate nodes, so no comparison finding exists at all -
      // which is the honest outcome, not a fabricated mismatch.
      eq(findings.length, 0);
    });

    test('with an FX rate the comparison happens and records the rate', () => {
      const findings = r1.run(graphOf([
        obs({ metric: 'revenue', value: 625000, currency: 'USD', period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, currency: 'INR', period: 'FY2025-26', doc: DOCS.auditor })
      ], { fxRates: { USD_INR: 83.2, source: 'user', as_of: '2026-08-01' } }));

      eq(findings.length, 1);
      eq(findings[0].classification, 'VERIFIED_MISMATCH');
      truthy(findings[0].computation.fx_applied, 'the conversion is recorded on the finding');
      truthy(findings[0].computation.substituted.includes('83.2'),
        'the rate appears in the substitution the user reads');
      truthy(findings[0].factors.confidence < 1, 'an assumed rate costs confidence');
    });
  });

  suite('R2: accounting identities', () => {
    test('a P&L that does not add up fails, from a single document', () => {
      // The headline R2 case: one document, no comparison needed.
      const findings = r2.run(graphOf(pnl(DOCS.deck, 'FY2025-26', {
        revenue: 52000000,
        cogs: 31000000,
        gross_profit: 24000000   // should be 21,000,000
      }, { basis: 'management' })));

      const gp = find(findings, f => f.rule_id === 'R2.gross_profit');
      truthy(gp, 'gross profit identity fired');
      eq(gp.classification, 'VERIFIED_MISMATCH');
      eq(gp.computation.result, 'FAIL');
      near(gp.computation.computed, 21000000, 1);
      eq(gp.computation.stated, 24000000);
      near(gp.computation.delta_pct, 12.5, 0.1);
      eq(gp.computation.single_document, true, 'caught inside one document');
    });

    test('the substitution string shows the actual arithmetic', () => {
      const findings = r2.run(graphOf(pnl(DOCS.deck, 'FY2025-26', {
        revenue: 52000000, cogs: 31000000, gross_profit: 24000000
      })));
      const gp = find(findings, f => f.rule_id === 'R2.gross_profit');
      eq(gp.computation.expression, 'revenue - cogs = gross_profit');
      // Rupee amounts render in Indian grouping - 2,10,00,000 not 21,000,000 - because that
      // is how an Indian founder or investor reads the number off their own statements.
      truthy(gp.computation.substituted.includes('2,10,00,000'), 'computed value shown');
      truthy(gp.computation.substituted.includes('2,40,00,000'), 'stated value shown');
      truthy(gp.computation.substituted.includes('5,20,00,000'), 'revenue operand shown');
    });

    test('a P&L that reconciles passes', () => {
      const findings = r2.run(graphOf(pnl(DOCS.financials, 'FY2024-25', {
        revenue: 32000000, cogs: 20000000, gross_profit: 12000000
      })));
      const gp = find(findings, f => f.rule_id === 'R2.gross_profit');
      eq(gp.classification, 'VERIFIED_CONSISTENT');
      eq(gp.computation.result, 'PASS');
    });

    test('the balance sheet identity fires', () => {
      const findings = r2.run(graphOf(pnl(DOCS.financials, 'FY2024-25', {
        total_assets: 50000000, liabilities: 20000000, equity: 28000000
      })));
      const bs = find(findings, f => f.rule_id === 'R2.balance_sheet');
      truthy(bs);
      eq(bs.classification, 'VERIFIED_MISMATCH');
      near(bs.computation.computed, 48000000, 1);
    });

    test('the cash flow identity fires', () => {
      const findings = r2.run(graphOf(pnl(DOCS.mis, 'FY2024-25', {
        opening_cash: 10000000, net_cash_flow: 2000000, closing_cash: 15000000
      })));
      const cf = find(findings, f => f.rule_id === 'R2.cash_flow');
      truthy(cf);
      eq(cf.classification, 'VERIFIED_MISMATCH');
    });

    test('the margin identity is tested in percentage points', () => {
      const findings = r2.run(graphOf([
        ...pnl(DOCS.deck, 'FY2024-25', { revenue: 32000000, gross_profit: 12000000 }),
        obs({ metric: 'gross_margin', value: 45, unit: 'pct', period: 'FY2024-25', doc: DOCS.deck })
      ]));
      const gm = find(findings, f => f.rule_id === 'R2.gross_margin_pct');
      truthy(gm, 'margin identity fired');
      near(gm.computation.computed, 37.5, 0.1);
      eq(gm.computation.stated, 45);
      eq(gm.classification, 'VERIFIED_MISMATCH');
    });

    test('ARR = MRR x 12', () => {
      const findings = r2.run(graphOf([
        obs({ metric: 'mrr', value: 3000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'arr', value: 42000000, period: 'FY2025-26', doc: DOCS.deck })
      ]));
      const arr = find(findings, f => f.rule_id === 'R2.arr_from_mrr');
      truthy(arr);
      near(arr.computation.computed, 36000000, 1);
      eq(arr.classification, 'VERIFIED_MISMATCH');
    });

    test('missing operands mean no finding, not a false one', () => {
      const findings = r2.run(graphOf(pnl(DOCS.deck, 'FY2025-26', {
        revenue: 52000000, gross_profit: 24000000   // cogs absent
      })));
      falsy(find(findings, f => f.rule_id === 'R2.gross_profit'),
        'an identity cannot be tested without all its terms');
    });

    test('mixed currencies inside one identity blocks rather than accuses', () => {
      const findings = r2.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, currency: 'INR', period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'cogs', value: 375000, currency: 'USD', period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'gross_profit', value: 21000000, currency: 'INR', period: 'FY2025-26', doc: DOCS.deck })
      ], { fxRates: { USD_INR: 83.2 } }));

      const gp = find(findings, f => f.rule_id === 'R2.gross_profit');
      truthy(gp);
      eq(gp.computation.blocked_reason, 'currency_mismatch');
      eq(gp.classification, 'UNRESOLVED_INCONSISTENCY');
    });

    test('periods are never crossed', () => {
      const findings = r2.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'cogs', value: 31000000, period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'gross_profit', value: 21000000, period: 'FY2025-26', doc: DOCS.deck })
      ]));
      falsy(find(findings, f => f.rule_id === 'R2.gross_profit'),
        'FY26 revenue minus FY25 cogs is not an identity');
    });

    test('CRITICAL - documents are not blended into one equation', () => {
      // The financial statements reconcile perfectly on their own. The deck states a different
      // gross profit. Blending the two into a consensus and testing that would report an
      // arithmetic failure that NEITHER document commits - the real issue is a cross-document
      // conflict, which belongs to R1.
      const findings = r2.run(graphOf([
        ...pnl(DOCS.financials, 'FY2024-25', { revenue: 32000000, cogs: 20000000, gross_profit: 12000000 }),
        obs({ metric: 'gross_profit', value: 15000000, period: 'FY2024-25', doc: DOCS.deck })
      ]));

      const failures = findings.filter(f => f.computation.result === 'FAIL');
      eq(failures.length, 0, 'no invented arithmetic error');

      const pass = find(findings, f => f.details.identity_id === 'gross_profit');
      truthy(pass, 'the identity was still checked');
      eq(pass.details.scope, 'within_document', 'and checked inside the statements alone');
      eq(pass.computation.single_document, true);
    });

    test('two documents each failing the same identity produce two findings', () => {
      const findings = r2.run(graphOf([
        ...pnl(DOCS.financials, 'FY2024-25', { revenue: 32000000, cogs: 20000000, gross_profit: 15000000 }),
        ...pnl(DOCS.mis, 'FY2024-25', { revenue: 32000000, cogs: 20000000, gross_profit: 14000000 })
      ]));
      const gpFailures = findings.filter(
        f => f.details.identity_id === 'gross_profit' && f.computation.result === 'FAIL'
      );
      eq(gpFailures.length, 2, 'each document contradicts itself separately');
      truthy(gpFailures.every(f => f.computation.single_document));
    });

    test('an identity split across documents is still checked, but marked as such', () => {
      // Deck gives revenue and gross profit, statements give COGS. No single document has all
      // three, so the only way to test the identity is to combine them - which is worth doing,
      // and worth labelling.
      const findings = r2.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'gross_profit', value: 15000000, period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'cogs', value: 20000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      const f = find(findings, x => x.details.identity_id === 'gross_profit');
      truthy(f, 'the identity was checked across documents');
      eq(f.details.scope, 'across_documents');
      eq(f.computation.single_document, false, 'so it is not a self-contradiction claim');
    });

    test('the likely culprit is named', () => {
      const findings = r2.run(graphOf(pnl(DOCS.deck, 'FY2025-26', {
        revenue: 52000000, cogs: 31000000, gross_profit: 24000000
      })));
      const gp = find(findings, f => f.rule_id === 'R2.gross_profit');
      truthy(gp.details.likely_culprit, 'a culprit hint is offered');
      truthy(gp.details.likely_culprit.metric_key, 'and it names a metric');
    });
  });

  suite('R5: unsupported claims', () => {
    test('a deck claim with no backing anywhere is MISSING_INFORMATION', () => {
      const findings = r5.run(graphOf([
        obs({ metric: 'customer_base', value: 1200, unit: 'count', period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      eq(findings.length, 1);
      eq(findings[0].classification, 'MISSING_INFORMATION');
      eq(findings[0].details.sub_type, 'unsupported_claim');
      eq(findings[0].metric_key, 'customer_base');
    });

    test('a corroborated deck claim produces no R5 finding', () => {
      const findings = r5.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      eq(findings.length, 0);
    });

    test('a non-deck claim is not R5 material', () => {
      const findings = r5.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials })
      ]));
      eq(findings.length, 0, 'R5 only polices what the deck asserts');
    });

    test('TAM is exempt - nobody substantiates market size', () => {
      const findings = r5.run(graphOf([
        obs({ metric: 'tam', value: 5000000000, period: 'FY2025-26', doc: DOCS.deck })
      ]));
      eq(findings.length, 0, 'flagging TAM would bury the real findings in noise');
    });

    test('an unsupported revenue claim outranks an unsupported headcount claim', () => {
      const findings = r5.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'headcount', value: 42, unit: 'count', period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2025-26', doc: DOCS.financials })
      ]));
      const rev = find(findings, f => f.metric_key === 'revenue');
      const hc = find(findings, f => f.metric_key === 'headcount');
      truthy(rev && hc, 'both flagged');
      truthy(rev.severity_score > hc.severity_score,
        `revenue (${rev.severity_score}) should outrank headcount (${hc.severity_score})`);
    });

    test('a derivable claim is softened, not dismissed', () => {
      // Deck states ARR; statements never say "ARR" but do state MRR. The number exists.
      const findings = r5.run(graphOf([
        obs({ metric: 'arr', value: 36000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'mrr', value: 3000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'mrr', value: 3000000, period: 'FY2025-26', doc: DOCS.financials })
      ]));
      const arr = find(findings, f => f.metric_key === 'arr');
      truthy(arr, 'still reported');
      eq(arr.details.sub_type, 'derivable_not_stated');
      truthy(arr.details.derivation, 'the derivation path is recorded');
    });
  });

  suite('severity: the weighting model', () => {
    test('HEADLINE - deck Rs 5.2 Cr vs audited Rs 3.2 Cr revenue is CRITICAL', () => {
      const findings = r1.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck, basis: 'management' }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.auditor, basis: 'audited' })
      ]));
      const f = findings[0];

      eq(f.severity_band, 'CRITICAL');
      truthy(f.severity_score >= 30, `severity ${f.severity_score} should clear the CRITICAL band`);
      eq(f.factors.base, 15, 'R1 base weight');
      truthy(f.factors.materiality > 1.8, 'revenue at full importance, large gap');
      eq(f.factors.direction, 1.25, 'the deck overstates against audited - self-serving');
      eq(f.factors.corroboration, 1.15, 'one against one is a standoff');
    });

    test('a 3-person headcount gap is inside tolerance and reported as consistent', () => {
      // Headcount tolerance is deliberately loose (8%) - it is a snapshot that moves weekly,
      // so two documents prepared a month apart legitimately disagree. Flagging this would be
      // noise, and noise is how a verification tool loses the reader's trust.
      const f = r1.run(graphOf([
        obs({ metric: 'headcount', value: 42, unit: 'count', period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'headcount', value: 45, unit: 'count', period: 'FY2024-25', doc: DOCS.kpi })
      ]))[0];
      eq(f.classification, 'VERIFIED_CONSISTENT');
    });

    test('HEADLINE - a headcount gap that does breach tolerance stays low severity', () => {
      const f = r1.run(graphOf([
        obs({ metric: 'headcount', value: 42, unit: 'count', period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'headcount', value: 47, unit: 'count', period: 'FY2024-25', doc: DOCS.kpi })
      ]))[0];

      truthy(f.severity_score < 12, `severity ${f.severity_score} should stay low`);
      truthy(f.severity_band === 'MINOR' || f.severity_band === 'MEDIUM',
        `band was ${f.severity_band}, must not reach HIGH`);
      truthy(f.factors.materiality < 0.8, 'headcount importance is only 0.35');
      eq(f.factors.direction, 1.0, 'no favourable direction defined for headcount');
    });

    test('the two headline cases are far apart', () => {
      // This contrast is the demo slide: identical rule, identical mechanism, ~4x severity
      // difference, entirely from arithmetic the audience can inspect.
      const revenue = r1.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.auditor, basis: 'audited' })
      ]))[0];
      const headcount = r1.run(graphOf([
        obs({ metric: 'headcount', value: 42, unit: 'count', period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'headcount', value: 47, unit: 'count', period: 'FY2024-25', doc: DOCS.kpi })
      ]))[0];

      const ratio = revenue.severity_score / headcount.severity_score;
      truthy(ratio > 3.5,
        `same rule, ${ratio.toFixed(1)}x apart (${revenue.severity_score} vs ${headcount.severity_score})`);
    });

    test('direction - an understating deck is penalised LESS', () => {
      const overstating = r1.run(graphOf([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.auditor, basis: 'audited' })
      ]))[0];
      const understating = r1.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.auditor, basis: 'audited' })
      ]))[0];

      eq(overstating.factors.direction, 1.25);
      eq(understating.factors.direction, 0.85);
      truthy(overstating.severity_score > understating.severity_score,
        'a self-serving error costs more than a conservative one');
    });

    test('direction - an identity uses stated vs computed, not authority tiers', () => {
      // An R2 finding spans several metrics from usually one document, so ranking documents
      // by authority is the wrong question. The right one is whether the stated figure errs
      // in the flattering direction.
      const overstated = r2.run(graphOf(pnl(DOCS.financials, 'FY2024-25', {
        revenue: 32000000, cogs: 20000000, gross_profit: 15000000   // computed 12,000,000
      }))).find(f => f.rule_id === 'R2.gross_profit');

      const understated = r2.run(graphOf(pnl(DOCS.financials, 'FY2024-25', {
        revenue: 32000000, cogs: 20000000, gross_profit: 9000000    // computed 12,000,000
      }))).find(f => f.rule_id === 'R2.gross_profit');

      eq(overstated.factors.direction, 1.25, 'gross profit stated above what the maths supports');
      eq(overstated.factors.detail.direction.reason, 'stated_figure_overstated');
      eq(understated.factors.direction, 0.85, 'stated below - conservative');
      truthy(overstated.severity_score > understated.severity_score);
    });

    test('direction - burn rate is favourable DOWNWARD', () => {
      // A deck claiming a LOWER burn than the MIS shows is the self-serving direction here.
      const f = r1.run(graphOf([
        obs({ metric: 'burn_rate', value: 1500000, period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'burn_rate', value: 2500000, period: 'FY2024-25', doc: DOCS.auditor, basis: 'audited' })
      ]))[0];
      eq(f.factors.direction, 1.25, 'understating burn flatters the company');
    });

    test('corroboration - a lone dissenter is discounted', () => {
      const isolated = r1.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.kpi }),
        obs({ metric: 'revenue', value: 52000000, period: 'FY2024-25', doc: DOCS.deck })
      ]))[0];
      eq(isolated.factors.corroboration, 0.8, 'three against one is a likely stale slide');
    });

    test('materiality - the same percentage gap on a bigger metric scores higher', () => {
      const revenueGap = r1.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 48000000, period: 'FY2024-25', doc: DOCS.deck })
      ]))[0];
      const tamGap = r1.run(graphOf([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'tam', value: 2000000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'tam', value: 3000000000, period: 'FY2024-25', doc: DOCS.deck })
      ])).find(f => f.metric_key === 'tam');

      truthy(revenueGap.severity_score > tamGap.severity_score,
        `50% revenue gap (${revenueGap.severity_score}) must outrank 50% TAM gap (${tamGap.severity_score})`);
    });

    test('severity never exceeds the cap or goes negative', () => {
      const f = r1.run(graphOf([
        obs({ metric: 'revenue', value: 1000, period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 99000000000, period: 'FY2024-25', doc: DOCS.auditor, basis: 'audited' })
      ]))[0];
      truthy(f.severity_score >= 0 && f.severity_score <= 100, `bounded: ${f.severity_score}`);
    });
  });

  suite('scoring: pillars and coverage ceiling', () => {
    test('a clean two-document set scores well', () => {
      const result = verify([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.deck })
      ], {
        documents: [
          { document_category: 'financial_statements' },
          { document_category: 'pitch_deck' }
        ]
      });

      truthy(result.score > 0 && result.score <= 100, `bounded: ${result.score}`);
      truthy(result.score >= 70, `a clean set should not be punished: got ${result.score}`);
    });

    test('a single pitch deck can never look investor-ready', () => {
      // The failure mode the naive formula got badly wrong: nothing to contradict it, so it
      // scored 100. Nothing was verified, so it must be capped.
      const result = verify([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2025-26', doc: DOCS.deck })
      ], { documents: [{ document_category: 'pitch_deck' }] });

      truthy(result.score < 65, `one deck scored ${result.score}, must be capped low`);
      eq(result.breakdown.ceiling_applied, true, 'the coverage ceiling bit');
      eq(result.breakdown.coverage.evidence_coverage_ratio, 0, 'nothing was corroborated');
    });

    test('three catastrophic findings hurt more than twelve trivial ones', () => {
      // The linear formula got this backwards. Saturation fixes it.
      const catastrophic = verify([
        ...pnl(DOCS.financials, 'FY2024-25', { revenue: 32000000, cogs: 20000000, gross_profit: 25000000 }),
        ...pnl(DOCS.financials, 'FY2024-25', { total_assets: 50000000, liabilities: 20000000, equity: 40000000 }),
        obs({ metric: 'revenue', value: 90000000, period: 'FY2024-25', doc: DOCS.deck })
      ], { documents: [{ document_category: 'financial_statements' }, { document_category: 'pitch_deck' }] });

      const trivial = verify([
        obs({ metric: 'headcount', value: 42, unit: 'count', period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'headcount', value: 43, unit: 'count', period: 'FY2024-25', doc: DOCS.kpi }),
        obs({ metric: 'customer_base', value: 1200, unit: 'count', period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'customer_base', value: 1215, unit: 'count', period: 'FY2024-25', doc: DOCS.kpi })
      ], { documents: [{ document_category: 'mis' }, { document_category: 'kpi_dashboard' }] });

      truthy(catastrophic.score < trivial.score,
        `catastrophic ${catastrophic.score} must score worse than trivial ${trivial.score}`);
    });

    test('pillars are reported individually', () => {
      const result = verify(
        pnl(DOCS.financials, 'FY2024-25', { revenue: 32000000, cogs: 20000000, gross_profit: 25000000 }),
        { documents: [{ document_category: 'financial_statements' }] }
      );

      eq(typeof result.score, 'number', 'score is a plain number');
      const pillars = result.breakdown.pillars;
      truthy(pillars, 'pillar breakdown exists');
      truthy(pillars.arithmetic_integrity.score < 100, 'the broken identity hit its own pillar');
      eq(pillars.arithmetic_integrity.finding_count > 0, true);
    });

    test('a pillar with nothing to check is marked not applicable', () => {
      const result = verify([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials })
      ], { documents: [{ document_category: 'financial_statements' }] });

      eq(result.breakdown.pillars.ownership_integrity.applicable, false,
        'no cap table was uploaded, so this is not a clean bill of health');
    });

    test('positive confirmations never cost points', () => {
      const result = verify([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.mis })
      ], { documents: [{ document_category: 'financial_statements' }, { document_category: 'mis' }] });

      eq(result.breakdown.counts.VERIFIED_CONSISTENT > 0, true, 'confirmations were produced');
      eq(result.breakdown.pillars.cross_doc_consistency.score, 100, 'and they cost nothing');
    });
  });

  suite('engine: determinism and integration', () => {
    const fixture = [
      ...pnl(DOCS.financials, 'FY2024-25', { revenue: 32000000, cogs: 20000000, gross_profit: 12000000 }),
      obs({ metric: 'revenue', value: 52000000, period: 'FY2024-25', doc: DOCS.deck }),
      obs({ metric: 'customer_base', value: 1200, unit: 'count', period: 'FY2024-25', doc: DOCS.deck }),
      obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.financials }),
      obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.mis })
    ];
    const opts = {
      documents: [
        { document_category: 'financial_statements' },
        { document_category: 'pitch_deck' },
        { document_category: 'mis' }
      ]
    };

    test('the same input produces the same score, twice', () => {
      // This is the claim the whole design exists to support. Run it twice on stage.
      const a = verify(fixture, opts);
      const b = verify(fixture, opts);
      eq(a.score, b.score);
      eq(a.findings.length, b.findings.length);
      eq(
        a.findings.map(f => `${f.ref_code}:${f.severity_score}`).join(),
        b.findings.map(f => `${f.ref_code}:${f.severity_score}`).join(),
        'ref codes and severities are stable'
      );
    });

    test('every finding is stamped with the rulepack version', () => {
      const result = verify(fixture, opts);
      truthy(result.findings.length > 0);
      truthy(result.findings.every(f => f.rulepack_version === result.rulepack_version));
    });

    test('every finding carries citable evidence', () => {
      const result = verify(fixture, opts);
      for (const f of result.findings) {
        truthy(f.evidence.length > 0, `${f.ref_code} has evidence`);
        truthy(f.evidence.every(e => e.quote), `${f.ref_code} evidence is all quoted`);
      }
    });

    test('ref codes are unique and severity-ordered', () => {
      const result = verify(fixture, opts);
      const codes = result.findings.map(f => f.ref_code);
      eq(new Set(codes).size, codes.length, 'unique');
      for (let i = 1; i < result.findings.length; i++) {
        truthy(result.findings[i - 1].severity_score >= result.findings[i].severity_score,
          'ordered worst-first');
      }
    });

    test('problems and confirmations are separable', () => {
      const result = verify(fixture, opts);
      eq(
        problems(result.findings).length + confirmations(result.findings).length,
        result.findings.length
      );
      truthy(problems(result.findings).length > 0, 'the fixture has planted problems');
    });

    test('an empty session degrades quietly instead of crashing', () => {
      const result = verify([], { documents: [] });
      eq(result.findings.length, 0);
      truthy(Number.isFinite(result.score), 'still returns a number');
    });
  });
};
