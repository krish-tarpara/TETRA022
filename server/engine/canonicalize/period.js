/**
 * Period canonicalization on an Indian fiscal calendar (April - March).
 *
 * Everything reduces to one of four canonical key shapes:
 *   FY2025-26          full fiscal year
 *   Q3-FY2024-25       fiscal quarter (Q1 = Apr-Jun, Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar)
 *   M03-FY2024-25      single month (March 2025 falls in FY2024-25)
 *   REL-Y1             relative, unresolvable without context ("Year 1", "Projected Year 2")
 *
 * The fiscal start month comes from rulepack.json, so moving to a Jan-Dec calendar is a
 * config change rather than a code change.
 *
 * Confidence matters as much as the key here. A period we merely guessed is the single most
 * common cause of a false mismatch - comparing FY25 revenue against FY26 revenue and calling
 * it a discrepancy. So every result carries a confidence that flows into severity, and a
 * guessed period can never produce a full-severity accusation.
 */

const rulepack = require('../rulepack.json');

const FISCAL_START_MONTH = rulepack.fiscal.start_month; // 4 = April

const MONTHS = [
  { names: ['january', 'jan'], num: 1 },
  { names: ['february', 'feb'], num: 2 },
  { names: ['march', 'mar'], num: 3 },
  { names: ['april', 'apr'], num: 4 },
  { names: ['may'], num: 5 },
  { names: ['june', 'jun'], num: 6 },
  { names: ['july', 'jul'], num: 7 },
  { names: ['august', 'aug'], num: 8 },
  { names: ['september', 'sept', 'sep'], num: 9 },
  { names: ['october', 'oct'], num: 10 },
  { names: ['november', 'nov'], num: 11 },
  { names: ['december', 'dec'], num: 12 }
];

/** FY label from its starting calendar year. 2025 -> "FY2025-26". */
function fyLabel(startYear) {
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `FY${startYear}-${endShort}`;
}

/** Which fiscal year does a given calendar month+year fall into? Returns the start year. */
function fyStartYearFor(month, calendarYear) {
  return month >= FISCAL_START_MONTH ? calendarYear : calendarYear - 1;
}

/** Fiscal quarter for a calendar month. April -> 1, March -> 4. */
function fiscalQuarterFor(month) {
  const offset = (month - FISCAL_START_MONTH + 12) % 12;
  return Math.floor(offset / 3) + 1;
}

/** Expand a 2-digit year to 4 digits. 26 -> 2026, 99 -> 1999. */
function expandYear(twoDigit) {
  const n = parseInt(twoDigit, 10);
  if (n >= 100) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

/**
 * @param {string} raw            period as stated in the document
 * @param {object} [ctx]          { documentPeriodHint, periodType }
 * @returns {{period_key:string, period_conf:number, granularity:string, quality:string, fy_start_year:number|null, month:number|null, quarter:number|null}}
 */
function canonicalizePeriod(raw, ctx = {}) {
  if (!raw || !String(raw).trim()) {
    return unresolved(ctx);
  }

  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');

  // ── Relative periods: "Year 1", "Y2", "Projected Year 3" ──
  const rel = s.match(/\b(?:projected\s+)?(?:year|yr|y)\s*[-. ]?\s*([1-9])\b/);
  if (rel && !/\b(19|20)\d{2}\b/.test(s)) {
    return {
      period_key: `REL-Y${rel[1]}`,
      period_conf: rulepack.severity.confidence.period_quality.relative,
      granularity: 'fy',
      quality: 'relative',
      fy_start_year: null,
      month: null,
      quarter: null
    };
  }

  // ── Explicit month + year: "Mar-2025", "March 2025", "Mar 25", "03/2025" ──
  const monthHit = MONTHS.find(m => m.names.some(n => new RegExp(`\\b${n}\\b`).test(s)));
  if (monthHit) {
    const yearMatch = s.match(/\b(19|20)(\d{2})\b/) || s.match(/[-' ](\d{2})\b/);
    if (yearMatch) {
      const calYear = yearMatch[0].length >= 4
        ? parseInt(yearMatch[0].replace(/\D/g, ''), 10)
        : expandYear(yearMatch[1]);
      const startYear = fyStartYearFor(monthHit.num, calYear);
      return {
        period_key: `M${String(monthHit.num).padStart(2, '0')}-${fyLabel(startYear)}`,
        period_conf: rulepack.severity.confidence.period_quality.exact,
        granularity: 'month',
        quality: 'exact',
        fy_start_year: startYear,
        month: monthHit.num,
        quarter: fiscalQuarterFor(monthHit.num)
      };
    }
  }

  // ── Fiscal quarter: "Q3 FY25", "Q3 FY2024-25", "Q3 2025", "3Q25" ──
  const qMatch = s.match(/\bq\s*([1-4])\b/) || s.match(/\b([1-4])\s*q\b/);
  if (qMatch) {
    const quarter = parseInt(qMatch[1], 10);
    const fy = extractFy(s);
    if (fy) {
      return {
        period_key: `Q${quarter}-${fyLabel(fy.startYear)}`,
        period_conf: fy.quality === 'exact'
          ? rulepack.severity.confidence.period_quality.exact
          : rulepack.severity.confidence.period_quality.inferred,
        granularity: 'quarter',
        quality: fy.quality,
        fy_start_year: fy.startYear,
        month: null,
        quarter
      };
    }
  }

  // ── Fiscal year: "FY26", "FY2026", "FY25-26", "2025-26", "FY2025-26" ──
  const fy = extractFy(s);
  if (fy) {
    return {
      period_key: fyLabel(fy.startYear),
      period_conf: fy.quality === 'exact'
        ? rulepack.severity.confidence.period_quality.exact
        : rulepack.severity.confidence.period_quality.inferred,
      granularity: 'fy',
      quality: fy.quality,
      fy_start_year: fy.startYear,
      month: null,
      quarter: null
    };
  }

  return unresolved(ctx);
}

/**
 * Pull a fiscal year out of a string.
 *
 * The ambiguous case is a bare 4-digit year like "2025". In Indian usage that nearly always
 * means FY2024-25 when it appears with "FY" and the calendar year 2025 otherwise - but it is
 * genuinely ambiguous, so it is marked `inferred` and takes a confidence penalty.
 */
function extractFy(s) {
  // "FY25-26" / "2025-26" / "FY2025-2026" - an explicit span, unambiguous.
  const span = s.match(/\b(?:fy\s*)?(\d{4}|\d{2})\s*[-/–]\s*(\d{4}|\d{2})\b/);
  if (span) {
    const start = expandYear(span[1]);
    return { startYear: start, quality: 'exact' };
  }

  // "FY26" / "FY2026" - single year, means the year the FY *ends*.
  const single = s.match(/\bfy\s*'?\s*(\d{4}|\d{2})\b/);
  if (single) {
    const endYear = expandYear(single[1]);
    return { startYear: endYear - 1, quality: 'exact' };
  }

  // Bare "2025" with no FY marker. Treat as the FY ending that year, but mark inferred.
  const bare = s.match(/\b(19|20)(\d{2})\b/);
  if (bare) {
    const year = parseInt(bare[0], 10);
    return { startYear: year - 1, quality: 'inferred' };
  }

  return null;
}

function unresolved(ctx) {
  // A document-level hint (e.g. an MIS titled "FY2025-26") is better than nothing, but it
  // is a guess about this particular row, so confidence drops to the 'relative' tier.
  if (ctx.documentPeriodHint) {
    const hinted = canonicalizePeriod(ctx.documentPeriodHint, {});
    if (hinted.quality !== 'unknown') {
      return {
        ...hinted,
        period_conf: rulepack.severity.confidence.period_quality.relative,
        quality: 'inferred_from_document'
      };
    }
  }
  return {
    period_key: 'UNKNOWN',
    period_conf: rulepack.severity.confidence.period_quality.unknown,
    granularity: 'unknown',
    quality: 'unknown',
    fy_start_year: null,
    month: null,
    quarter: null
  };
}

/** Is this period key resolved enough to compare against another? */
function isComparable(periodKey) {
  return Boolean(periodKey) && periodKey !== 'UNKNOWN';
}

/**
 * Chronological sort key. Lets R4 order historical periods without parsing keys again.
 * Returns null for relative/unknown periods, which cannot be placed on a timeline.
 */
function sortKey(parsed) {
  if (!parsed || parsed.fy_start_year === null) return null;
  const base = parsed.fy_start_year * 100;
  if (parsed.granularity === 'month') {
    const offset = (parsed.month - FISCAL_START_MONTH + 12) % 12;
    return base + offset + 1;
  }
  if (parsed.granularity === 'quarter') return base + (parsed.quarter - 1) * 3 + 1;
  return base;
}

/** All month keys belonging to a fiscal year, in fiscal order. */
function monthsOfFy(fyStartYear) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const month = ((FISCAL_START_MONTH - 1 + i) % 12) + 1;
    out.push(`M${String(month).padStart(2, '0')}-${fyLabel(fyStartYear)}`);
  }
  return out;
}

/** All quarter keys belonging to a fiscal year, in fiscal order. */
function quartersOfFy(fyStartYear) {
  return [1, 2, 3, 4].map(q => `Q${q}-${fyLabel(fyStartYear)}`);
}

/** The three month keys inside a given fiscal quarter. */
function monthsOfQuarter(fyStartYear, quarter) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const month = ((FISCAL_START_MONTH - 1 + (quarter - 1) * 3 + i) % 12) + 1;
    out.push(`M${String(month).padStart(2, '0')}-${fyLabel(fyStartYear)}`);
  }
  return out;
}

module.exports = {
  canonicalizePeriod,
  isComparable,
  sortKey,
  fyLabel,
  fyStartYearFor,
  fiscalQuarterFor,
  monthsOfFy,
  quartersOfFy,
  monthsOfQuarter,
  FISCAL_START_MONTH
};
