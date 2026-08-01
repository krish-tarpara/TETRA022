/**
 * Fact graph tests.
 *
 * The grouping rules are where false mismatches are born. Each test here corresponds to a
 * pair of numbers that a naive comparison would flag as a discrepancy and that the engine
 * must NOT flag - or the reverse: a genuine conflict that must survive grouping.
 */

const { suite, test, eq, near, truthy, falsy } = require('./harness');
const { buildFactGraph } = require('../factGraph');
const { obs, DOCS } = require('./fixtures/builders');

module.exports = function run() {

  suite('factGraph: what counts as the same claim', () => {
    test('same metric, period and basis from two documents share a node', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.financials })
      ]);
      eq(graph.nodes.length, 1);
      eq(graph.nodes[0].distinct_source_docs, 2);
    });

    test('different periods are different claims, not a conflict', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.financials })
      ]);
      eq(graph.nodes.length, 2, 'growth is not a discrepancy');
    });

    test('actuals and projections never share a node', () => {
      // R4 examines this boundary deliberately. R1 must never see across it, or every
      // company with a growth plan gets flagged for contradicting itself.
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', basis: 'audited', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', basis: 'projected', doc: DOCS.projections })
      ]);
      eq(graph.nodes.length, 2);
      eq(graph.nodes.filter(n => n.basis_class === 'actual').length, 1);
      eq(graph.nodes.filter(n => n.basis_class === 'forward').length, 1);
    });

    test('audited and management both count as actual', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', basis: 'audited', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 32100000, period: 'FY2024-25', basis: 'management', doc: DOCS.mis })
      ]);
      eq(graph.nodes.length, 1, 'both describe what happened, so they are comparable');
    });

    test('different metrics never merge', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'arr', value: 32000000, period: 'FY2024-25', doc: DOCS.deck })
      ]);
      eq(graph.nodes.length, 2, 'revenue and ARR are not the same claim');
    });
  });

  suite('factGraph: consensus and spread', () => {
    test('spread is measured against consensus', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.financials })
      ]);
      const node = graph.nodes[0];
      eq(node.min, 32000000);
      eq(node.max, 52000000);
      eq(node.spread_abs, 20000000);
      truthy(node.spread_pct > 0, 'spread is computed');
    });

    test('a lone outlier does not drag the consensus', () => {
      // Three documents say 3.2 Cr, one says 52 Cr (a scale slip). Consensus must stay at
      // 3.2 Cr - a mean would put it at ~15 Cr and every severity calc downstream would be
      // measured against a number no document ever stated.
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.mis }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', doc: DOCS.kpi }),
        obs({ metric: 'revenue', value: 520000000, period: 'FY2024-25', doc: DOCS.deck })
      ]);
      const node = graph.nodes[0];
      eq(node.consensus_value, 32000000, 'median holds the line');
      eq(node.outliers.length, 1, 'the deck is the outlier');
      eq(node.outliers[0].document_category, 'pitch_deck');
    });

    test('agreement within tolerance produces no outliers', () => {
      const graph = buildFactGraph([
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'cash_position', value: 12050000, period: 'FY2024-25', doc: DOCS.mis })
      ]);
      eq(graph.nodes[0].outliers.length, 0, '0.4% apart, inside the 1% cash tolerance');
    });

    test('percentage metrics are compared in percentage points', () => {
      // 38% vs 40% is 2pp. Treated as a 5% relative variance it would slip under a 2%
      // relative tolerance test in the wrong direction; pp comparison catches it.
      const graph = buildFactGraph([
        obs({ metric: 'gross_margin', value: 38, unit: 'pct', period: 'FY2024-25', doc: DOCS.financials }),
        obs({ metric: 'gross_margin', value: 40, unit: 'pct', period: 'FY2024-25', doc: DOCS.deck })
      ]);
      eq(graph.nodes[0].outliers.length > 0, true, '2pp gap exceeds the 0.2pp margin tolerance');
    });

    test('single-source node has zero spread and one document', () => {
      const graph = buildFactGraph([
        obs({ metric: 'tam', value: 5000000000, period: 'FY2025-26', doc: DOCS.deck })
      ]);
      const node = graph.nodes[0];
      eq(node.distinct_source_docs, 1);
      eq(node.spread_abs, 0);
      eq(node.outliers.length, 0);
    });
  });

  suite('factGraph: currency', () => {
    test('without a rate, USD and INR stay apart and the node is blocked', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 625000, currency: 'USD', period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, currency: 'INR', period: 'FY2025-26', doc: DOCS.financials })
      ], { fxRates: {} });

      eq(graph.nodes.length, 2, 'no rate means no comparison');
      const usdNode = graph.nodes.find(n => n.node_key.endsWith('USD'));
      truthy(usdNode, 'the USD observation is isolated in its own node');
    });

    test('with a rate, USD and INR meet on one node and convert', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 625000, currency: 'USD', period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, currency: 'INR', period: 'FY2025-26', doc: DOCS.financials })
      ], { fxRates: { USD_INR: 83.2, source: 'user', as_of: '2026-08-01' } });

      eq(graph.nodes.length, 1, 'the rate lets them be compared');
      const node = graph.nodes[0];
      truthy(node.crossed_currency, 'flagged as a cross-currency comparison');
      eq(node.fx_applied.length, 1, 'the conversion is recorded');
      eq(node.fx_applied[0].rate, 83.2);
      near(node.max, 52000000, 1, '625k USD at 83.2 is Rs 5.2 Cr');
    });

    test('the shorthand rate form is accepted', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 625000, currency: 'USD', period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, currency: 'INR', period: 'FY2025-26', doc: DOCS.financials })
      ], { fxRates: { USD: 83.2 } });
      eq(graph.nodes.length, 1);
    });

    test('non-currency metrics are never affected by FX', () => {
      const graph = buildFactGraph([
        obs({ metric: 'headcount', value: 42, unit: 'count', period: 'FY2024-25', doc: DOCS.deck }),
        obs({ metric: 'headcount', value: 45, unit: 'count', period: 'FY2024-25', doc: DOCS.mis })
      ], { fxRates: { USD_INR: 83.2 } });
      eq(graph.nodes.length, 1);
      falsy(graph.nodes[0].crossed_currency);
    });
  });

  suite('factGraph: scale anchor', () => {
    test('anchors on the largest actual revenue', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', basis: 'audited', doc: DOCS.financials }),
        obs({ metric: 'revenue', value: 120000000, period: 'FY2027-28', basis: 'projected', doc: DOCS.projections }),
        obs({ metric: 'headcount', value: 42, unit: 'count', period: 'FY2024-25', doc: DOCS.mis })
      ]);
      eq(graph.scale_anchor.value, 32000000, 'projections do not set the scale');
      eq(graph.scale_anchor.basis, 'actual_revenue');
    });

    test('falls back to projected revenue when no actuals exist', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 120000000, period: 'FY2027-28', basis: 'projected', doc: DOCS.projections })
      ]);
      eq(graph.scale_anchor.basis, 'projected_revenue');
      eq(graph.scale_anchor.value, 120000000);
    });

    test('falls back to the largest currency figure with no revenue at all', () => {
      const graph = buildFactGraph([
        obs({ metric: 'cash_position', value: 12000000, period: 'FY2024-25', doc: DOCS.financials })
      ]);
      eq(graph.scale_anchor.basis, 'largest_currency_figure');
      eq(graph.scale_anchor.value, 12000000);
    });

    test('no numbers at all yields no anchor rather than a crash', () => {
      const graph = buildFactGraph([]);
      eq(graph.scale_anchor.value, null);
      eq(graph.scale_anchor.basis, 'none');
    });
  });

  suite('factGraph: index', () => {
    const graph = buildFactGraph([
      obs({ metric: 'revenue', value: 20000000, period: 'FY2023-24', basis: 'audited', doc: DOCS.financials }),
      obs({ metric: 'revenue', value: 32000000, period: 'FY2024-25', basis: 'audited', doc: DOCS.financials }),
      obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', basis: 'projected', doc: DOCS.projections }),
      obs({ metric: 'cogs', value: 11000000, period: 'FY2024-25', basis: 'audited', doc: DOCS.financials })
    ]);

    test('lookup by metric', () => eq(graph.index.metric('revenue').length, 3));
    test('lookup one exact node', () => {
      const node = graph.index.one('revenue', 'FY2024-25', 'actual');
      truthy(node);
      eq(node.consensus_value, 32000000);
    });
    test('lookup a node that does not exist returns null', () =>
      eq(graph.index.one('revenue', 'FY2099-00', 'actual'), null));
    test('lookup by period returns every metric in it', () =>
      eq(graph.index.period('FY2024-25').length, 2));
    test('periods come back in chronological order', () => {
      const periods = graph.index.periods();
      eq(periods[0], 'FY2023-24');
      eq(periods[periods.length - 1], 'FY2025-26');
    });
  });

  suite('factGraph: stats', () => {
    test('multi-source nodes are counted', () => {
      const graph = buildFactGraph([
        obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck }),
        obs({ metric: 'revenue', value: 32000000, period: 'FY2025-26', doc: DOCS.financials }),
        obs({ metric: 'tam', value: 5000000000, period: 'FY2025-26', doc: DOCS.deck })
      ]);
      eq(graph.stats.node_count, 2);
      eq(graph.stats.multi_source_nodes, 1, 'only revenue is corroborated');
      eq(graph.stats.observation_count, 3);
    });
  });
};
