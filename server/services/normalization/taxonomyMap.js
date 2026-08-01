/**
 * Metric vocabulary. Maps whatever a document calls something onto a canonical metric_key.
 *
 * `unit` is load-bearing, not documentation. The rule engine's accounting identities do
 * arithmetic across these keys, so a key must hold exactly one kind of quantity:
 *
 *   currency -> absolute money, canonicalized to base units (52000000, not "5.2 Cr")
 *   pct      -> a percentage, stored as the number before the % sign (38.5, not 0.385)
 *   count    -> a headcount / customer count
 *   months   -> a duration
 *   ratio    -> a dimensionless multiple
 *
 * This is why "EBITDA" and "Operating Margin" are separate keys even though humans use
 * them interchangeably: `gross_profit - opex = ebitda` is only true in currency. Mixing a
 * margin percentage into the same key would make the identity check produce garbage.
 */
const TAXONOMY_MAP = {
  // ── REVENUE ──
  revenue: {
    canonical: 'Revenue',
    unit: 'currency',
    aliases: ['revenue', 'topline', 'top line', 'turnover', 'gross revenue', 'net revenue',
              'total revenue', 'sales', 'total sales', 'net sales', 'income from operations',
              'operating revenue', 'service revenue', 'revenue from operations'],
    category: 'revenue'
  },
  arr: {
    canonical: 'ARR',
    unit: 'currency',
    aliases: ['arr', 'annual recurring revenue', 'annualised recurring revenue',
              'annualized recurring revenue', 'annual run rate', 'run rate revenue'],
    category: 'revenue'
  },
  mrr: {
    canonical: 'MRR',
    unit: 'currency',
    aliases: ['mrr', 'monthly recurring revenue', 'monthly run rate'],
    category: 'revenue'
  },
  revenue_growth: {
    canonical: 'Revenue Growth Rate',
    unit: 'pct',
    aliases: ['revenue growth', 'revenue growth rate', 'yoy growth', 'y-o-y growth',
              'year over year growth', 'year-on-year growth', 'topline growth',
              'sales growth', 'arr growth', 'mrr growth rate', 'cagr', 'growth rate'],
    category: 'revenue'
  },

  // ── COST & PROFITABILITY (currency) ──
  cogs: {
    canonical: 'Cost of Goods Sold',
    unit: 'currency',
    aliases: ['cogs', 'cost of goods sold', 'cost of revenue', 'cost of sales',
              'direct costs', 'direct cost', 'cost of services'],
    category: 'profit'
  },
  gross_profit: {
    canonical: 'Gross Profit',
    unit: 'currency',
    aliases: ['gross profit', 'gross income', 'gross earnings', 'contribution'],
    category: 'profit'
  },
  opex: {
    canonical: 'Operating Expenses',
    unit: 'currency',
    aliases: ['opex', 'operating expenses', 'operating expense', 'operating costs',
              'total expenses', 'total operating expenditure', 'sg&a', 'sga',
              'selling general and administrative', 'overheads', 'indirect costs'],
    category: 'profit'
  },
  ebitda: {
    canonical: 'EBITDA',
    unit: 'currency',
    aliases: ['ebitda', 'ebit', 'operating profit', 'operating income',
              'operating earnings', 'earnings before interest', 'profit before tax',
              'pbt', 'profit before interest and tax'],
    category: 'profit'
  },
  depreciation_amortization: {
    canonical: 'Depreciation & Amortization',
    unit: 'currency',
    aliases: ['depreciation and amortization', 'depreciation & amortization',
              'depreciation and amortisation', 'd&a', 'depreciation', 'amortization',
              'amortisation'],
    category: 'profit'
  },
  interest_expense: {
    canonical: 'Interest Expense',
    unit: 'currency',
    aliases: ['interest expense', 'interest cost', 'finance cost', 'finance costs',
              'interest paid', 'interest'],
    category: 'profit'
  },
  tax_expense: {
    canonical: 'Tax Expense',
    unit: 'currency',
    aliases: ['tax expense', 'income tax', 'tax provision', 'provision for tax',
              'taxes', 'current tax'],
    category: 'profit'
  },
  net_profit: {
    canonical: 'Net Profit',
    unit: 'currency',
    aliases: ['net profit', 'net income', 'net earnings', 'pat', 'profit after tax',
              'bottom line', 'profit for the year', 'profit for the period',
              'net profit/(loss)', 'net loss'],
    category: 'profit'
  },

  // ── MARGINS (percentage) ──
  gross_margin: {
    canonical: 'Gross Margin',
    unit: 'pct',
    aliases: ['gross margin', 'gross profit margin', 'gross profit %',
              'gross profit percentage', 'gp margin', 'gp %', 'contribution margin'],
    category: 'profit'
  },
  ebitda_margin: {
    canonical: 'EBITDA Margin',
    unit: 'pct',
    aliases: ['ebitda margin', 'ebitda %', 'operating margin', 'operating profit margin',
              'operating margin %', 'ebit margin'],
    category: 'profit'
  },
  net_margin: {
    canonical: 'Net Margin',
    unit: 'pct',
    aliases: ['net margin', 'net profit margin', 'net profit %', 'pat margin',
              'net income margin'],
    category: 'profit'
  },

  // ── BALANCE SHEET ──
  total_assets: {
    canonical: 'Total Assets',
    unit: 'currency',
    aliases: ['total assets', 'assets', 'total asset'],
    category: 'balance_sheet'
  },
  liabilities: {
    canonical: 'Total Liabilities',
    unit: 'currency',
    aliases: ['total liabilities', 'liabilities', 'total liability'],
    category: 'balance_sheet'
  },
  equity: {
    canonical: 'Total Equity',
    unit: 'currency',
    aliases: ['total equity', 'equity', 'shareholders equity', "shareholder's equity",
              "shareholders' funds", 'net worth', 'total shareholders funds',
              'share capital and reserves'],
    category: 'balance_sheet'
  },

  // ── LIQUIDITY ──
  cash_position: {
    canonical: 'Cash Position',
    unit: 'currency',
    aliases: ['cash position', 'cash at bank', 'cash and equivalents',
              'cash and cash equivalents', 'liquid assets', 'bank balance',
              'cash in hand', 'total cash', 'cash reserves', 'cash balance'],
    category: 'liquidity'
  },
  opening_cash: {
    canonical: 'Opening Cash',
    unit: 'currency',
    aliases: ['opening cash', 'opening cash balance', 'cash at beginning of period',
              'cash at start of period', 'opening balance'],
    category: 'liquidity'
  },
  closing_cash: {
    canonical: 'Closing Cash',
    unit: 'currency',
    aliases: ['closing cash', 'closing cash balance', 'cash at end of period',
              'cash at close of period', 'closing balance', 'ending cash'],
    category: 'liquidity'
  },
  net_cash_flow: {
    canonical: 'Net Cash Flow',
    unit: 'currency',
    aliases: ['net cash flow', 'net change in cash', 'net cash movement',
              'net increase in cash', 'net decrease in cash', 'cash flow'],
    category: 'liquidity'
  },
  burn_rate: {
    canonical: 'Burn Rate',
    unit: 'currency',
    aliases: ['burn rate', 'monthly burn', 'cash burn', 'net burn', 'gross burn',
              'monthly cash outflow', 'operating cash outflow', 'monthly spend',
              'monthly cash burn'],
    category: 'liquidity'
  },
  cash_runway: {
    canonical: 'Cash Runway',
    unit: 'months',
    aliases: ['cash runway', 'runway', 'months of runway', 'runway months',
              'cash runway months', 'survival period', 'time to zero cash'],
    category: 'liquidity'
  },

  // ── GROWTH & CUSTOMERS ──
  customer_base: {
    canonical: 'Customer Base',
    unit: 'count',
    aliases: ['customer base', 'customers', 'customer count', 'total customers',
              'active users', 'paid subscribers', 'paying customers', 'client count',
              'total clients', 'enterprise clients', 'total users', 'registered users',
              'subscriber count', 'subscribers', 'dau', 'mau',
              'daily active users', 'monthly active users'],
    category: 'growth'
  },
  churn_rate: {
    canonical: 'Churn Rate',
    unit: 'pct',
    aliases: ['churn rate', 'churn', 'churn %', 'customer churn', 'monthly churn',
              'annual churn', 'attrition rate', 'attrition', 'logo churn',
              'revenue churn', 'net churn'],
    category: 'growth'
  },
  cac: {
    canonical: 'Customer Acquisition Cost',
    unit: 'currency',
    aliases: ['cac', 'customer acquisition cost', 'acquisition cost',
              'cost per acquisition', 'cost per customer', 'blended cac', 'paid cac'],
    category: 'growth'
  },
  ltv: {
    canonical: 'Lifetime Value',
    unit: 'currency',
    aliases: ['ltv', 'lifetime value', 'customer lifetime value', 'clv', 'cltv',
              'average lifetime value', 'ltv per customer'],
    category: 'growth'
  },
  ltv_cac_ratio: {
    canonical: 'LTV / CAC Ratio',
    unit: 'ratio',
    aliases: ['ltv/cac', 'ltv to cac', 'ltv cac ratio', 'ltv:cac', 'ltv / cac',
              'ltv-cac ratio'],
    category: 'growth'
  },

  // ── OWNERSHIP & CAP TABLE ──
  ownership: {
    canonical: 'Ownership %',
    unit: 'pct',
    aliases: ['ownership', 'ownership %', 'shareholding', 'shareholding %',
              'equity holding', 'holding %', 'stake', 'founder equity',
              'founder holding', 'founder ownership', 'promoter holding',
              'investor stake', 'diluted stake', 'fully diluted', 'cap table share',
              '% held', 'equity %'],
    category: 'ownership'
  },
  esop_pool: {
    canonical: 'ESOP Pool',
    unit: 'pct',
    aliases: ['esop pool', 'esop', 'employee stock option pool', 'option pool',
              'esop %', 'esop reserve'],
    category: 'ownership'
  },
  valuation: {
    canonical: 'Valuation',
    unit: 'currency',
    aliases: ['valuation', 'company valuation', 'enterprise value',
              'implied valuation', 'ev'],
    category: 'ownership'
  },
  pre_money_valuation: {
    canonical: 'Pre-Money Valuation',
    unit: 'currency',
    aliases: ['pre-money valuation', 'pre money valuation', 'pre-money', 'pre money'],
    category: 'ownership'
  },
  post_money_valuation: {
    canonical: 'Post-Money Valuation',
    unit: 'currency',
    aliases: ['post-money valuation', 'post money valuation', 'post-money', 'post money'],
    category: 'ownership'
  },
  round_size: {
    canonical: 'Round Size',
    unit: 'currency',
    aliases: ['round size', 'raise amount', 'amount raised', 'amount being raised',
              'capital raise', 'funding amount', 'investment amount', 'ask',
              'raising', 'total raise'],
    category: 'ownership'
  },

  // ── OPERATIONAL ──
  headcount: {
    canonical: 'Headcount',
    unit: 'count',
    aliases: ['headcount', 'head count', 'team size', 'employee count',
              'total employees', 'number of employees', 'employees', 'fte',
              'fte count', 'staff strength', 'workforce size', 'team strength'],
    category: 'operational'
  },
  revenue_per_employee: {
    canonical: 'Revenue per Employee',
    unit: 'currency',
    aliases: ['revenue per employee', 'revenue/employee', 'revenue per head',
              'sales per employee'],
    category: 'operational'
  },
  tam: {
    canonical: 'Total Addressable Market',
    unit: 'currency',
    aliases: ['tam', 'total addressable market', 'market size', 'addressable market',
              'total market', 'sam', 'som', 'serviceable market',
              'serviceable addressable market', 'market opportunity'],
    category: 'operational'
  }
};

/** Every metric_key the engine knows about. */
const METRIC_KEYS = Object.keys(TAXONOMY_MAP);

/** Declared unit for a metric_key, or null if unknown. */
function unitOf(metricKey) {
  return TAXONOMY_MAP[metricKey] ? TAXONOMY_MAP[metricKey].unit : null;
}

/** Human-facing label for a metric_key. Falls back to the key itself. */
function labelOf(metricKey) {
  return TAXONOMY_MAP[metricKey] ? TAXONOMY_MAP[metricKey].canonical : metricKey;
}

/**
 * Flat alias index, sorted longest-first.
 *
 * Order matters: "gross profit margin" must be tested before "gross profit", or every
 * margin in every document silently becomes a currency amount. Longest-first matching is
 * the whole reason this is precomputed rather than iterated per lookup.
 */
const ALIAS_INDEX = Object.entries(TAXONOMY_MAP)
  .flatMap(([key, def]) => def.aliases.map(alias => ({ alias: alias.toLowerCase(), key })))
  .sort((a, b) => b.alias.length - a.alias.length);

module.exports = { TAXONOMY_MAP, METRIC_KEYS, ALIAS_INDEX, unitOf, labelOf };
