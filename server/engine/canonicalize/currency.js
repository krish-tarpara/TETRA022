/**
 * Currency handling.
 *
 * Design rule: an observation's native currency and value are never mutated. Conversion is
 * a compare-time operation that produces a separate `value_anchor`, and every finding that
 * relied on a conversion records the rate it used.
 *
 * The reason is accountability. An FX rate is an assumption we own, not a fact from the
 * document. If a mismatch only exists because of the rate we picked, the report has to say
 * so - otherwise we are inventing findings and blaming the company for them.
 *
 * When a rate is missing, comparison is blocked rather than guessed. That downgrades the
 * finding to UNRESOLVED_INCONSISTENCY, which is the honest answer.
 */

const rulepack = require('../rulepack.json');

const BASE_CURRENCY = rulepack.fiscal.base_currency;

/**
 * Normalize a session's FX config into a lookup keyed "USD_INR".
 *
 * @param {object} fxRates  e.g. { USD_INR: 83.2, EUR: 90.1, source: 'user', as_of: '2026-08-01' }
 * @returns {{rates: Object<string,number>, source: string, as_of: string|null}}
 */
function buildFxTable(fxRates = {}) {
  const rates = {};
  const meta = { source: fxRates.source || 'user', as_of: fxRates.as_of || null };

  for (const [key, value] of Object.entries(fxRates)) {
    if (key === 'source' || key === 'as_of' || key === 'note') continue;
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) continue;

    // Accept both "USD_INR" and the shorthand "USD".
    const pair = key.includes('_') ? key.toUpperCase() : `${key.toUpperCase()}_${BASE_CURRENCY}`;
    rates[pair] = rate;
  }

  rates[`${BASE_CURRENCY}_${BASE_CURRENCY}`] = 1;
  return { rates, ...meta };
}

/**
 * Convert one value into the anchor currency.
 *
 * @returns {{ok:boolean, value_anchor:number|null, fx:{pair:string,rate:number,source:string,as_of:string|null}|null, blocked_reason:string|null}}
 */
function toAnchor(value, currency, fxTable) {
  if (value === null || value === undefined) {
    return { ok: false, value_anchor: null, fx: null, blocked_reason: 'no_value' };
  }

  // No currency stated: treat as already in the anchor. Non-currency metrics (percentages,
  // counts, months) land here too, which is correct - they need no conversion.
  const cur = (currency || BASE_CURRENCY).toUpperCase();

  if (cur === BASE_CURRENCY) {
    return { ok: true, value_anchor: value, fx: null, blocked_reason: null };
  }

  const pair = `${cur}_${BASE_CURRENCY}`;
  const rate = fxTable.rates[pair];

  if (!rate) {
    return { ok: false, value_anchor: null, fx: null, blocked_reason: 'currency_mismatch' };
  }

  return {
    ok: true,
    value_anchor: value * rate,
    fx: { pair, rate, source: fxTable.source, as_of: fxTable.as_of },
    blocked_reason: null
  };
}

/**
 * Resolve a whole set of observations onto the anchor currency.
 *
 * Either all of them convert, or none do. A partial conversion would mean comparing two
 * numbers where one crossed a currency and one didn't, without any way to say which - so
 * the whole node blocks instead.
 *
 * @returns {{ok:boolean, values:Array<{observation_id:string,value_anchor:number}>, fx_applied:Array, crossed_currency:boolean, blocked_reason:string|null, currencies:string[]}}
 */
function resolveNodeCurrency(observations, fxTable) {
  const currencies = [...new Set(
    observations.map(o => (o.currency || BASE_CURRENCY).toUpperCase())
  )];

  const values = [];
  const fxApplied = [];

  for (const obs of observations) {
    const result = toAnchor(obs.value_base, obs.currency, fxTable);
    if (!result.ok) {
      return {
        ok: false,
        values: [],
        fx_applied: [],
        crossed_currency: currencies.length > 1,
        blocked_reason: result.blocked_reason,
        currencies
      };
    }
    values.push({ observation_id: obs.observation_id, value_anchor: result.value_anchor });
    if (result.fx) {
      fxApplied.push({ ...result.fx, observation_id: obs.observation_id });
    }
  }

  return {
    ok: true,
    values,
    fx_applied: fxApplied,
    crossed_currency: currencies.length > 1,
    blocked_reason: null,
    currencies
  };
}

/** Render a converted value for display in a finding's substitution string. */
function formatConversion(value, currency, fx) {
  if (!fx) return formatAmount(value, currency);
  return `${formatAmount(value, currency)} x ${fx.rate} = ${formatAmount(value * fx.rate, BASE_CURRENCY)}`;
}

const SYMBOLS = { INR: 'Rs ', USD: '$', EUR: '€', GBP: '£' };

function formatAmount(value, currency) {
  if (value === null || value === undefined) return '-';
  const symbol = SYMBOLS[(currency || BASE_CURRENCY).toUpperCase()] || `${currency} `;
  return `${symbol}${Math.round(value).toLocaleString('en-IN')}`;
}

module.exports = {
  buildFxTable,
  toAnchor,
  resolveNodeCurrency,
  formatConversion,
  formatAmount,
  BASE_CURRENCY
};
