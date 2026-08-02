/**
 * Canonicalization tests.
 *
 * These are the cheapest high-value tests in the project. Every false mismatch the engine
 * could ever produce traces back to one of three mistakes made here: a misparsed scale, a
 * misaligned period, or a metric filed under the wrong key. Each case below is a specific
 * way a real document would break the engine.
 */

const { suite, test, eq, near, truthy, falsy } = require('./harness');
const scale = require('../canonicalize/scale');
const { canonicalizePeriod, fyLabel, monthsOfQuarter } = require('../canonicalize/period');
const { resolveMetric, matchAlias } = require('../canonicalize/taxonomy');
const { canonicalizeObservation, canonicalizeBatch } = require('../canonicalize');

module.exports = function run() {

  suite('scale: Indian and Western notation', () => {
    test('crore', () => near(scale.canonicalizeValue('Rs 5.2 Cr', 52000000, 'currency').value_base, 52000000, 1));
    test('crore spelled out', () => near(scale.canonicalizeValue('5.2 crore', null, 'currency').value_base, 52000000, 1));
    test('lakh', () => near(scale.canonicalizeValue('Rs 45 lakh', null, 'currency').value_base, 4500000, 1));
    test('rupee symbol', () => near(scale.canonicalizeValue('₹3.2 Cr', null, 'currency').value_base, 32000000, 1));
    test('million with dollar', () => near(scale.canonicalizeValue('$1.5M', null, 'currency').value_base, 1500000, 1));
    test('billion', () => near(scale.canonicalizeValue('$2.4bn', null, 'currency').value_base, 2400000000, 1));
    test('thousand k-suffix', () => near(scale.canonicalizeValue('45k', null, 'count').value_base, 45000, 1));

    test('Indian comma grouping', () =>
      near(scale.canonicalizeValue('5,20,00,000', null, 'currency').value_base, 52000000, 1));
    test('Western comma grouping', () =>
      near(scale.canonicalizeValue('52,000,000', null, 'currency').value_base, 52000000, 1));

    test('accounting parentheses are negative', () =>
      near(scale.canonicalizeValue('(3,200)', null, 'currency').value_base, -3200, 1));
    test('leading minus', () =>
      near(scale.canonicalizeValue('-1.2 Cr', null, 'currency').value_base, -12000000, 1));

    test('percentage is not scaled', () => {
      const r = scale.canonicalizeValue('38.5%', 38.5, 'pct');
      near(r.value_base, 38.5, 0.001);
      eq(r.detected_unit, 'pct');
    });

    test('currency detected', () => eq(scale.canonicalizeValue('$1.5M', null, 'currency').currency, 'USD'));
    test('no currency stated leaves it null', () =>
      eq(scale.canonicalizeValue('1500000', null, 'currency').currency, null));
  });

  suite('scale: guarding against the model getting it wrong', () => {
    test('model dropped the scale word -> value from raw wins, confidence drops', () => {
      // The classic failure: document says "5.2 Cr", model returns 5.2.
      const r = scale.canonicalizeValue('Rs 5.2 Cr', 5.2, 'currency');
      near(r.value_base, 52000000, 1, 'raw string is authoritative');
      eq(r.reason, 'model_missed_scale_multiplier');
      truthy(r.scale_conf < 1.0, 'confidence penalised');
    });

    test('model and raw agree -> full confidence', () => {
      const r = scale.canonicalizeValue('Rs 5.2 Cr', 52000000, 'currency');
      eq(r.scale_conf, 1.0);
      eq(r.reason, null);
    });

    test('unparseable raw falls back to model value', () => {
      const r = scale.canonicalizeValue('see note 4', 52000000, 'currency');
      near(r.value_base, 52000000, 1);
      eq(r.reason, 'value_raw_unparseable_used_model_value');
    });

    test('percentage on a currency metric is flagged, not silently accepted', () => {
      const r = scale.canonicalizeValue('38.5%', 38.5, 'currency');
      truthy(r.scale_conf <= 0.5, 'confidence collapses');
      eq(r.reason, 'declared_currency_but_value_is_percentage');
    });

    test('letter multipliers do not fire inside words', () => {
      // 'm' in "management" and 'b' in "EBITDA" must not multiply anything.
      eq(scale.detectMultiplier('management fee 500'), 1);
      eq(scale.detectMultiplier('EBITDA 4200'), 1);
      eq(scale.detectMultiplier('increase of 300'), 1, 'the "cr" in "increase"');
    });
  });

  suite('period: Indian fiscal year', () => {
    test('FY26 means the year ending 2026', () => eq(canonicalizePeriod('FY26').period_key, 'FY2025-26'));
    test('FY2026', () => eq(canonicalizePeriod('FY2026').period_key, 'FY2025-26'));
    test('FY25-26 span', () => eq(canonicalizePeriod('FY25-26').period_key, 'FY2025-26'));
    test('bare 2025-26 span', () => eq(canonicalizePeriod('2025-26').period_key, 'FY2025-26'));
    test('FY2025-2026 long span', () => eq(canonicalizePeriod('FY2025-2026').period_key, 'FY2025-26'));

    test('March 2025 belongs to FY2024-25, not FY2025-26', () => {
      // The fiscal-year boundary. Getting this wrong compares Q4 actuals against next
      // year's opening projections and calls it a discrepancy.
      const r = canonicalizePeriod('Mar-2025');
      eq(r.period_key, 'M03-FY2024-25');
      eq(r.granularity, 'month');
    });
    test('April 2025 belongs to FY2025-26', () =>
      eq(canonicalizePeriod('April 2025').period_key, 'M04-FY2025-26'));
    test('March 2025 sits in fiscal Q4', () => eq(canonicalizePeriod('March 2025').quarter, 4));
    test('October 2025 sits in fiscal Q3', () => eq(canonicalizePeriod('Oct 2025').quarter, 3));

    test('Q3 FY25', () => eq(canonicalizePeriod('Q3 FY25').period_key, 'Q3-FY2024-25'));
    test('Q1 FY2025-26', () => eq(canonicalizePeriod('Q1 FY2025-26').period_key, 'Q1-FY2025-26'));

    test('relative periods are marked, not guessed', () => {
      const r = canonicalizePeriod('Projected Year 1');
      eq(r.period_key, 'REL-Y1');
      eq(r.quality, 'relative');
      truthy(r.period_conf < 1, 'relative periods carry reduced confidence');
    });

    test('bare year is inferred, and says so', () => {
      const r = canonicalizePeriod('2025');
      eq(r.quality, 'inferred');
      truthy(r.period_conf < 1, 'ambiguity is priced in');
    });

    test('unreadable period is UNKNOWN, never a guess', () => {
      const r = canonicalizePeriod('the current financial year');
      eq(r.period_key, 'UNKNOWN');
      eq(r.quality, 'unknown');
    });

    test('document-level hint is used but discounted', () => {
      const r = canonicalizePeriod(null, { documentPeriodHint: 'FY2025-26' });
      eq(r.period_key, 'FY2025-26');
      eq(r.quality, 'inferred_from_document');
      truthy(r.period_conf < 1);
    });

    test('fiscal quarter month expansion', () => {
      eq(monthsOfQuarter(2025, 1).join(','), 'M04-FY2025-26,M05-FY2025-26,M06-FY2025-26');
      eq(monthsOfQuarter(2025, 4).join(','), 'M01-FY2025-26,M02-FY2025-26,M03-FY2025-26');
    });

    test('fyLabel formatting across the century boundary', () => {
      eq(fyLabel(2025), 'FY2025-26');
      eq(fyLabel(1999), 'FY1999-00');
    });
  });

  suite('taxonomy: longest-alias-first matching', () => {
    test('"gross profit margin" is a margin, not gross profit', () => {
      // If this regresses, every margin in every deck becomes a currency amount and the
      // accounting identities start producing nonsense.
      eq(matchAlias('Gross Profit Margin').key, 'gross_margin');
      eq(matchAlias('Gross Profit').key, 'gross_profit');
    });

    test('operating margin is a percentage metric, EBITDA is currency', () => {
      eq(matchAlias('Operating Margin').key, 'ebitda_margin');
      eq(matchAlias('Operating Income').key, 'ebitda');
    });

    test('net margin vs net profit', () => {
      eq(matchAlias('Net Profit Margin').key, 'net_margin');
      eq(matchAlias('Net Profit').key, 'net_profit');
    });

    test('ARR and MRR are distinct from revenue', () => {
      eq(matchAlias('ARR').key, 'arr');
      eq(matchAlias('Monthly Recurring Revenue').key, 'mrr');
      eq(matchAlias('Total Revenue').key, 'revenue');
    });

    test('ebit does not match inside ebitda', () => eq(matchAlias('EBITDA').key, 'ebitda'));

    test('label with a period suffix still resolves', () =>
      eq(matchAlias('Topline (FY26E)').key, 'revenue'));

    test('alias table beats a conflicting model claim', () => {
      const r = resolveMetric('Gross Profit Margin', 'gross_profit');
      eq(r.metric_key, 'gross_margin');
      eq(r.agreement, 'conflict');
      truthy(r.label_conf < 1, 'disagreement is priced in');
    });

    test('agreement gives full label confidence', () => {
      const r = resolveMetric('Total Revenue', 'revenue');
      eq(r.metric_key, 'revenue');
      eq(r.label_conf, 1.0);
    });

    test('unknown label plus valid model claim is accepted at low confidence', () => {
      const r = resolveMetric('Widget Throughput Index', 'revenue');
      eq(r.metric_key, 'revenue');
      eq(r.agreement, 'model_only');
      truthy(r.label_conf < 0.7);
    });

    test('nothing resolvable returns null', () =>
      eq(resolveMetric('Widget Throughput Index', 'not_a_metric').metric_key, null));
  });

  const deck = {
    id: 'doc-deck',
    original_filename: 'Pitch_Deck.pdf',
    document_category: 'pitch_deck',
    file_type: '.pdf'
  };

  suite('canonicalize: the citation gate', () => {
    test('an uncited number is discarded', () => {
      const { observation, dropped } = canonicalizeObservation({
        metric_key: 'revenue',
        raw_label: 'Revenue',
        value_raw: 'Rs 5.2 Cr',
        value: 52000000,
        period: 'FY26',
        source_quote: ''
      }, deck, 'sess-1');
      eq(observation, null);
      eq(dropped, 'missing_source_quote');
    });

    test('a cited number survives', () => {
      const { observation } = canonicalizeObservation({
        metric_key: 'revenue',
        raw_label: 'Topline',
        value_raw: 'Rs 5.2 Cr',
        value: 52000000,
        period: 'FY26',
        source_page: 4,
        source_quote: 'FY26 topline of Rs 5.2 Cr',
        confidence: 0.95
      }, deck, 'sess-1');
      truthy(observation, 'observation kept');
      eq(observation.metric_key, 'revenue');
      near(observation.value_base, 52000000, 1);
      eq(observation.period_key, 'FY2025-26');
      eq(observation.currency, 'INR');
      eq(observation.source.quote, 'FY26 topline of Rs 5.2 Cr');
    });

    test('unresolvable metric is discarded', () => {
      const { observation, dropped } = canonicalizeObservation({
        metric_key: 'nonsense',
        raw_label: 'Vibes Index',
        value_raw: '42',
        source_quote: 'Vibes Index: 42'
      }, deck, 'sess-1');
      eq(observation, null);
      eq(dropped, 'unresolvable_metric');
    });

    test('unparseable value is discarded', () => {
      const { observation, dropped } = canonicalizeObservation({
        metric_key: 'revenue',
        raw_label: 'Revenue',
        value_raw: 'not disclosed',
        value: null,
        source_quote: 'Revenue: not disclosed'
      }, deck, 'sess-1');
      eq(observation, null);
      eq(dropped, 'unparseable_value');
    });
  });

  suite('canonicalize: basis and parse quality', () => {
    test('a pitch deck number is management basis, actual class', () => {
      const { observation } = canonicalizeObservation({
        metric_key: 'revenue', raw_label: 'Revenue', value_raw: 'Rs 3.2 Cr',
        period: 'FY25', period_type: 'historical', source_quote: 'Revenue Rs 3.2 Cr'
      }, deck, 's');
      eq(observation.basis, 'management');
      eq(observation.basis_class, 'actual');
    });

    test('a projected number is forward class regardless of document', () => {
      const { observation } = canonicalizeObservation({
        metric_key: 'revenue', raw_label: 'Revenue', value_raw: 'Rs 12 Cr',
        period: 'FY27', period_type: 'projected', source_quote: 'FY27E revenue Rs 12 Cr'
      }, deck, 's');
      eq(observation.basis, 'projected');
      eq(observation.basis_class, 'forward');
    });

    test('an auditor document is audited basis even if the model disagrees', () => {
      const { observation } = canonicalizeObservation({
        metric_key: 'revenue', raw_label: 'Revenue', value_raw: 'Rs 3.2 Cr',
        basis: 'management', period: 'FY25', source_quote: 'Revenue Rs 3.2 Cr'
      }, { ...deck, document_category: 'auditor_notes' }, 's');
      eq(observation.basis, 'audited');
    });

    test('a spreadsheet cell outranks a prose sentence', () => {
      const fromXlsx = canonicalizeObservation({
        metric_key: 'revenue', raw_label: 'Revenue', value_raw: '32000000',
        period: 'FY25', source_quote: 'Revenue | 32000000'
      }, { ...deck, file_type: '.xlsx' }, 's').observation;

      const fromProse = canonicalizeObservation({
        metric_key: 'revenue', raw_label: 'Revenue', value_raw: 'Rs 3.2 Cr',
        period: 'FY25', source_quote: 'We closed the year at Rs 3.2 Cr in revenue.'
      }, deck, 's').observation;

      truthy(fromXlsx.confidence.parse > fromProse.confidence.parse,
        'xlsx parse confidence beats prose');
    });
  });

  suite('canonicalize: batch reporting', () => {
    test('kept and dropped are both reported', () => {
      const { observations, dropped } = canonicalizeBatch([
        { metric_key: 'revenue', raw_label: 'Revenue', value_raw: 'Rs 3.2 Cr', period: 'FY25', source_quote: 'Revenue Rs 3.2 Cr' },
        { metric_key: 'revenue', raw_label: 'Revenue', value_raw: 'Rs 5.2 Cr', period: 'FY26' },
        { metric_key: 'ebitda', raw_label: 'EBITDA', value_raw: 'Rs 1.1 Cr', period: 'FY25', source_quote: 'EBITDA Rs 1.1 Cr' }
      ], deck, 's');

      eq(observations.length, 2, 'two kept');
      eq(dropped.length, 1, 'one dropped');
      eq(dropped[0].reason, 'missing_source_quote');
    });
  });
};
