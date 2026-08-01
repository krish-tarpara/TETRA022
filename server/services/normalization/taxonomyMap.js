const TAXONOMY_MAP = {
  // ── REVENUE METRICS ──
  revenue: {
    canonical: 'Revenue',
    aliases: ['topline', 'turnover', 'gross revenue', 'sales', 'arr', 'annual recurring revenue',
              'mrr', 'monthly recurring revenue', 'net revenue', 'total revenue', 'top line',
              'total sales', 'income from operations', 'service revenue'],
    category: 'revenue'
  },
  revenue_growth: {
    canonical: 'Revenue Growth Rate',
    aliases: ['revenue growth', 'yoy growth', 'year over year growth', 'topline growth',
              'sales growth', 'arr growth', 'mrr growth rate', 'cagr'],
    category: 'revenue'
  },

  // ── PROFITABILITY METRICS ──
  ebitda: {
    canonical: 'EBITDA',
    aliases: ['operating margin', 'operating income', 'operating profit', 'ebit',
              'earnings before interest', 'profit before tax', 'pbt', 'operating earnings'],
    category: 'profit'
  },
  gross_margin: {
    canonical: 'Gross Margin',
    aliases: ['gross profit margin', 'gross profit %', 'gross profit percentage',
              'contribution margin', 'gp margin', 'gp %'],
    category: 'profit'
  },
  net_profit: {
    canonical: 'Net Profit',
    aliases: ['net income', 'net earnings', 'pat', 'profit after tax', 'bottom line',
              'net margin', 'net profit margin'],
    category: 'profit'
  },

  // ── LIQUIDITY METRICS ──
  cash_position: {
    canonical: 'Cash Position',
    aliases: ['cash at bank', 'liquid assets', 'closing cash balance', 'cash and equivalents',
              'bank balance', 'cash in hand', 'total cash', 'cash reserves'],
    category: 'liquidity'
  },
  burn_rate: {
    canonical: 'Burn Rate',
    aliases: ['monthly burn', 'cash burn', 'net burn', 'gross burn', 'monthly cash outflow',
              'operating cash outflow', 'monthly spend'],
    category: 'liquidity'
  },
  cash_runway: {
    canonical: 'Cash Runway',
    aliases: ['runway', 'months of runway', 'cash runway months', 'survival period',
              'time to zero cash'],
    category: 'liquidity'
  },

  // ── GROWTH & CUSTOMER METRICS ──
  customer_base: {
    canonical: 'Customer Base',
    aliases: ['active users', 'paid subscribers', 'client count', 'customer count',
              'total users', 'paying customers', 'enterprise clients', 'dau', 'mau',
              'registered users', 'subscriber count'],
    category: 'growth'
  },
  churn_rate: {
    canonical: 'Churn Rate',
    aliases: ['customer churn', 'monthly churn', 'annual churn', 'attrition rate',
              'churn %', 'logo churn', 'revenue churn', 'net churn'],
    category: 'growth'
  },
  cac: {
    canonical: 'Customer Acquisition Cost',
    aliases: ['cac', 'acquisition cost', 'cost per acquisition', 'cost per customer',
              'customer acquisition', 'blended cac', 'paid cac'],
    category: 'growth'
  },
  ltv: {
    canonical: 'Lifetime Value',
    aliases: ['ltv', 'customer lifetime value', 'clv', 'cltv', 'average lifetime value',
              'ltv per customer'],
    category: 'growth'
  },

  // ── OWNERSHIP & CAP TABLE ──
  ownership: {
    canonical: 'Ownership %',
    aliases: ['founder equity', 'diluted stake', 'esop pool', 'cap table share',
              'equity holding', 'shareholding', 'fully diluted', 'founder holding',
              'promoter holding', 'investor stake'],
    category: 'ownership'
  },
  valuation: {
    canonical: 'Valuation',
    aliases: ['pre-money valuation', 'post-money valuation', 'enterprise value',
              'company valuation', 'implied valuation', 'pre-money', 'post-money'],
    category: 'ownership'
  },

  // ── OPERATIONAL METRICS ──
  headcount: {
    canonical: 'Headcount',
    aliases: ['team size', 'employee count', 'total employees', 'fte count',
              'staff strength', 'number of employees', 'workforce size'],
    category: 'operational'
  },
  tam: {
    canonical: 'Total Addressable Market',
    aliases: ['tam', 'market size', 'addressable market', 'total market',
              'sam', 'som', 'serviceable market'],
    category: 'operational'
  }
};

module.exports = { TAXONOMY_MAP };
