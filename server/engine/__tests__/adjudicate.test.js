/**
 * Adjudication tests.
 *
 * Adjudication is the only place a user can influence a verdict, so the tests focus on the two
 * ways it could go wrong:
 *
 *   - it fails to be honest: a waived finding disappears, or an override silently rewrites a
 *     number, leaving a score nobody can account for
 *   - it fails to be isolated: an override leaks into the next session, so a score depends on
 *     whoever ran before you
 *
 * The second is the more dangerous one, because tolerance overrides mutate module-level rule pack
 * state that every session in the process shares.
 */

const { suite, test, eq, near, truthy, falsy } = require('./harness');
const { verify } = require('../index');
const { adjudicate, diff } = require('../adjudicate');
const rulepack = require('../rulepack.json');
const { obs, pnl, DOCS } = require('./fixtures/builders');

const CONFLICT = [
  obs({ metric: 'revenue', value: 52000000, period: 'FY2024-25', doc: DOCS.deck }),
  obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.auditor, basis: 'audited' }),
  obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.deck }),
  obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.auditor, basis: 'audited' })
];

const OPTIONS = {
  documents: [
    { document_category: 'pitch_deck' },
    { document_category: 'auditor_notes' }
  ]
};

module.exports = function run() {

  suite('adjudicate: authoritative source', () => {
    test('marking a source authoritative reduces severity without deleting the finding', () => {
      const before = verify(CONFLICT, OPTIONS);
      const after = adjudicate(CONFLICT, OPTIONS, [
        { type: 'authoritative_source', document_id: 'doc-aud', note: 'The deck is out of date.' }
      ]);

      const beforeFinding = before.findings.find(f => f.metric_key === 'revenue');
      const afterFinding = after.findings.find(f => f.metric_key === 'revenue');

      truthy(beforeFinding && afterFinding, 'the finding exists in both runs');
      truthy(afterFinding.severity_score < beforeFinding.severity_score,
        `severity fell from ${beforeFinding.severity_score} to ${afterFinding.severity_score}`);
      truthy(after.score >= before.score, 'and the score improved or held');
    });

    test('the score rises after adjudication', () => {
      const before = verify(CONFLICT, OPTIONS);
      const after = adjudicate(CONFLICT, OPTIONS, [
        { type: 'authoritative_source', document_id: 'doc-aud' }
      ]);
      truthy(after.score > before.score, `${before.score} -> ${after.score}`);
    });

    test('only figures the authority actually covers are superseded', () => {
      // Marking the auditor's notes authoritative says nothing about a customer count they never
      // mention. That claim must be left entirely alone - otherwise "trust this document" would
      // quietly downgrade evidence the document says nothing about.
      const withExtra = [
        ...CONFLICT,
        obs({ metric: 'customer_base', value: 1200, unit: 'count', period: 'FY2024-25', doc: DOCS.deck })
      ];

      const before = verify(withExtra, OPTIONS);
      const after = adjudicate(withExtra, OPTIONS, [
        { type: 'authoritative_source', document_id: 'doc-aud' }
      ]);

      // The auditor covers revenue and cash, so the deck's versions of both are superseded.
      truthy(after.adjudications[0].effect.includes('2 conflicting figure'),
        `revenue and cash should be superseded, got: ${after.adjudications[0].effect}`);

      // The unsupported customer claim is untouched: same finding, same severity.
      const beforeClaim = before.findings.find(f => f.metric_key === 'customer_base');
      const afterClaim = after.findings.find(f => f.metric_key === 'customer_base');
      truthy(beforeClaim && afterClaim, 'the customer claim is reported in both runs');
      eq(afterClaim.severity_score, beforeClaim.severity_score,
        'and its severity is unchanged, because the authority says nothing about it');
    });

    test('the original observations are never mutated', () => {
      // The un-adjudicated result has to stay reachable. If adjudication edited the inputs in
      // place, there would be no way back to what the documents actually said.
      const originals = CONFLICT.map(o => o.confidence.value);
      adjudicate(CONFLICT, OPTIONS, [
        { type: 'authoritative_source', document_id: 'doc-aud' }
      ]);
      eq(CONFLICT.map(o => o.confidence.value).join(), originals.join());
    });

    test('marking a source authoritative never turns a confirmation into a problem', () => {
      // Reducing the other documents' confidence must not flip an already-agreeing figure from a
      // green confirmation to a red finding. An action meant to resolve conflicts creating one is
      // the clearest possible sign the classification order is wrong.
      const agreeing = [
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.auditor, basis: 'audited' })
      ];

      const before = verify(agreeing, OPTIONS);
      const after = adjudicate(agreeing, OPTIONS, [
        { type: 'authoritative_source', document_id: 'doc-aud' }
      ]);

      eq(before.findings[0].classification, 'VERIFIED_CONSISTENT');
      eq(after.findings[0].classification, 'VERIFIED_CONSISTENT', 'still a confirmation afterwards');
    });

    test('an unknown document id is reported, not silently ignored', () => {
      const result = adjudicate(CONFLICT, OPTIONS, [
        { type: 'authoritative_source', document_id: 'does-not-exist' }
      ]);
      truthy(result.adjudications[0].effect.includes('Ignored'));
    });

    test('a missing document id is reported', () => {
      const result = adjudicate(CONFLICT, OPTIONS, [{ type: 'authoritative_source' }]);
      truthy(result.adjudications[0].effect.includes('Ignored'));
    });
  });

  suite('adjudicate: accepting an explanation', () => {
    test('an accepted finding is kept and marked, never deleted', () => {
      const before = verify(CONFLICT, OPTIONS);
      const target = before.findings.find(f => f.classification !== 'VERIFIED_CONSISTENT');

      const after = adjudicate(CONFLICT, OPTIONS, [
        { type: 'accept_explanation', finding_ref: target.ref_code, note: 'Explained on the call.' }
      ]);

      const kept = after.findings.find(f => f.ref_code === target.ref_code);
      truthy(kept, 'the finding is still in the report');
      eq(kept.adjudication.accepted, true);
      eq(kept.adjudication.note, 'Explained on the call.');
      eq(kept.adjudication.original_severity, target.severity_score,
        'the original severity is preserved so the UI can show what was waived');
      eq(kept.severity_score, 0, 'but it no longer counts toward the score');
    });

    test('accepting a finding raises the score', () => {
      const before = verify(CONFLICT, OPTIONS);
      const target = before.findings.find(f => f.classification !== 'VERIFIED_CONSISTENT');
      const after = adjudicate(CONFLICT, OPTIONS, [
        { type: 'accept_explanation', finding_ref: target.ref_code }
      ]);
      truthy(after.score > before.score, `${before.score} -> ${after.score}`);
    });

    test('a missing finding_ref is reported', () => {
      const result = adjudicate(CONFLICT, OPTIONS, [{ type: 'accept_explanation' }]);
      truthy(result.adjudications[0].effect.includes('Ignored'));
    });
  });

  suite('adjudicate: exchange rates', () => {
    const CROSS_CURRENCY = [
      obs({ metric: 'revenue', value: 625000, currency: 'USD', period: 'FY2024-25', doc: DOCS.deck }),
      obs({ metric: 'revenue', value: 32000000, currency: 'INR', period: 'FY2024-25', doc: DOCS.auditor, basis: 'audited' })
    ];

    test('supplying a rate enables a comparison that was blocked', () => {
      const before = verify(CROSS_CURRENCY, OPTIONS);
      const after = adjudicate(CROSS_CURRENCY, OPTIONS, [
        { type: 'fx_rate', fx_rates: { USD_INR: 83.2 } }
      ]);

      eq(before.findings.filter(f => f.rule_class === 'R1').length, 0, 'nothing comparable before');
      truthy(after.findings.some(f => f.rule_class === 'R1'), 'comparable after');
    });

    test('changing the rate changes the verdict, and the rate is recorded', () => {
      const at83 = adjudicate(CROSS_CURRENCY, OPTIONS, [
        { type: 'fx_rate', fx_rates: { USD_INR: 83.2 } }
      ]);
      // At this rate the two figures agree almost exactly, so the mismatch should vanish.
      const at51 = adjudicate(CROSS_CURRENCY, OPTIONS, [
        { type: 'fx_rate', fx_rates: { USD_INR: 51.2 } }
      ]);

      const a = at83.findings.find(f => f.rule_class === 'R1');
      const b = at51.findings.find(f => f.rule_class === 'R1');

      eq(a.classification, 'VERIFIED_MISMATCH');
      eq(b.classification, 'VERIFIED_CONSISTENT');
      truthy(a.computation.substituted.includes('83.2'), 'the rate appears in the working');
    });
  });

  suite('adjudicate: tolerance overrides', () => {
    const MARGINAL = [
      obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
      obs({ metric: 'revenue', value: 33500000, period: 'FY2024-25', doc: DOCS.mis })
    ];
    const MARGINAL_OPTIONS = {
      documents: [{ document_category: 'financial_statements' }, { document_category: 'mis' }]
    };

    test('loosening a tolerance reclassifies a finding', () => {
      const before = verify(MARGINAL, MARGINAL_OPTIONS);
      const after = adjudicate(MARGINAL, MARGINAL_OPTIONS, [
        { type: 'tolerance', metric_key: 'revenue', tolerance_pct: 8 }
      ]);

      const b = before.findings.find(f => f.metric_key === 'revenue');
      const a = after.findings.find(f => f.metric_key === 'revenue');

      truthy(b.classification !== 'VERIFIED_CONSISTENT', 'flagged at the default 2%');
      eq(a.classification, 'VERIFIED_CONSISTENT', 'accepted at 8%');
    });

    test('CRITICAL - a tolerance override does not leak into the next session', () => {
      // The rule pack is module-level state shared by every session in the process. A leaked
      // override would make one user's score depend on what another user did moments earlier -
      // which would destroy the reproducibility the whole engine is built on.
      const originalTolerance = rulepack.tolerances.by_metric.revenue;

      adjudicate(MARGINAL, MARGINAL_OPTIONS, [
        { type: 'tolerance', metric_key: 'revenue', tolerance_pct: 40 }
      ]);

      eq(rulepack.tolerances.by_metric.revenue, originalTolerance, 'rule pack restored');

      const fresh = verify(MARGINAL, MARGINAL_OPTIONS);
      truthy(
        fresh.findings.find(f => f.metric_key === 'revenue').classification !== 'VERIFIED_CONSISTENT',
        'a later session still sees the default tolerance'
      );
    });

    test('an override for a metric with no default tolerance is also cleaned up', () => {
      falsy(Object.prototype.hasOwnProperty.call(rulepack.tolerances.by_metric, 'ltv'),
        'precondition: ltv has no by_metric entry');

      adjudicate(MARGINAL, MARGINAL_OPTIONS, [
        { type: 'tolerance', metric_key: 'ltv', tolerance_pct: 25 }
      ]);

      falsy(Object.prototype.hasOwnProperty.call(rulepack.tolerances.by_metric, 'ltv'),
        'the key was removed again, not left behind as 25');
    });

    test('a malformed tolerance is reported', () => {
      const result = adjudicate(MARGINAL, MARGINAL_OPTIONS, [
        { type: 'tolerance', metric_key: 'revenue', tolerance_pct: 'loose' }
      ]);
      truthy(result.adjudications[0].effect.includes('Ignored'));
    });
  });

  suite('adjudicate: robustness', () => {
    test('an unknown adjudication type is reported and the run still completes', () => {
      const result = adjudicate(CONFLICT, OPTIONS, [{ type: 'make_it_all_green' }]);
      truthy(result.adjudications[0].effect.includes('unknown adjudication type'));
      truthy(Number.isFinite(result.score));
    });

    test('an empty adjudication list is the same as a plain verification', () => {
      const plain = verify(CONFLICT, OPTIONS);
      const empty = adjudicate(CONFLICT, OPTIONS, []);
      eq(empty.score, plain.score);
      eq(empty.adjudicated, false);
    });

    test('several adjudications combine', () => {
      const before = verify(CONFLICT, OPTIONS);
      const after = adjudicate(CONFLICT, OPTIONS, [
        { type: 'authoritative_source', document_id: 'doc-aud' },
        { type: 'tolerance', metric_key: 'revenue', tolerance_pct: 5 }
      ]);
      eq(after.adjudications.length, 2);
      truthy(after.score >= before.score);
    });

    test('adjudication stays deterministic', () => {
      const adjustments = [{ type: 'authoritative_source', document_id: 'doc-aud' }];
      const a = adjudicate(CONFLICT, OPTIONS, adjustments);
      const b = adjudicate(CONFLICT, OPTIONS, adjustments);
      eq(a.score, b.score);
      eq(
        a.findings.map(f => `${f.ref_code}:${f.severity_score}`).join(),
        b.findings.map(f => `${f.ref_code}:${f.severity_score}`).join()
      );
    });
  });

  suite('adjudicate: the diff for the UI', () => {
    test('the diff reports the score change and which pillars moved', () => {
      const before = verify(CONFLICT, OPTIONS);
      const after = adjudicate(CONFLICT, OPTIONS, [
        { type: 'authoritative_source', document_id: 'doc-aud' }
      ]);
      const d = diff(before, after);

      eq(d.score.before, before.score);
      eq(d.score.after, after.score);
      truthy(d.score.change > 0);
      truthy(d.pillars_changed.length > 0, 'at least one pillar moved');
      truthy(d.pillars.cross_doc_consistency, 'every pillar is present in the diff');
    });

    test('reclassified findings are listed', () => {
      const MARGINAL = [
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 33500000, period: 'FY2024-25', doc: DOCS.mis })
      ];
      const opts = {
        documents: [{ document_category: 'financial_statements' }, { document_category: 'mis' }]
      };

      const before = verify(MARGINAL, opts);
      const after = adjudicate(MARGINAL, opts, [
        { type: 'tolerance', metric_key: 'revenue', tolerance_pct: 8 }
      ]);
      const d = diff(before, after);

      truthy(d.reclassified.length > 0, 'the reclassification is reported');
      eq(d.reclassified[0].to, 'VERIFIED_CONSISTENT');
    });
  });
};
