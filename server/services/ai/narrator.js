/**
 * AI narration - optional, non-authoritative, and structurally unable to change a verdict.
 *
 * The engine has already produced every finding, severity and score, and explain.js has already
 * written readable prose for all of them. This module only tries to write BETTER prose. That is
 * the entire scope.
 *
 * Three guarantees enforced in code, not just intended:
 *
 *   1. It only ever writes to `narrative` and `follow_up_question`. Values, severities,
 *      classifications and scores are copied through untouched.
 *   2. Every failure is caught. Rate limits, timeouts, malformed JSON, a dead API key - all
 *      leave the templated text in place and the report fully intact.
 *   3. It is never awaited on the critical path. The caller fires it alongside everything else
 *      and takes what arrives.
 *
 * If this file were deleted, the product would lose polish and nothing else. That is deliberate:
 * it is why killing the Groq key mid-demo changes nothing important.
 */

const OpenAI = require('openai');

const MODEL = process.env.NARRATOR_MODEL || 'llama-3.3-70b-versatile';
const TIMEOUT_MS = 25000;
const MAX_FINDINGS_TO_NARRATE = 12;

function getClient() {
  if (!process.env.GROQ_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  });
}

const SYSTEM_PROMPT = `You are writing the readable layer of a financial verification report for
an investor.

A deterministic engine has already done the analysis. Every number, every verdict, every
severity score is settled and NOT up for discussion. Your only job is to express each finding in
clear professional English and to write the question an investor would send the founder.

Rules:
- Never dispute, soften, re-rank or re-interpret a finding. The arithmetic is not your concern.
- Never introduce a number that is not in the input. Do not compute anything.
- Never speculate about intent. "The deck overstates revenue" is fine; "the founder is hiding
  losses" is not.
- Two or three sentences per narrative. No preamble, no headings, no markdown.
- The question must be specific enough to answer directly: name the documents, the figures and
  the period.
- Neutral professional register. You are writing for a fund's investment committee, not selling
  anything.

Return JSON in exactly this shape:
{ "items": [ { "ref_code": "...", "narrative": "...", "follow_up_question": "..." } ] }`;

/**
 * Improve the prose on a set of findings.
 *
 * Always resolves. On any failure, returns the findings unchanged with a reason recorded.
 *
 * @param {Array} findings   findings that already carry templated narratives
 * @param {object} context   { executiveSummary, score, band }
 * @returns {Promise<{findings:Array, narrated:boolean, reason:string|null, model:string|null}>}
 */
async function narrate(findings, context = {}) {
  const client = getClient();
  if (!client) {
    return { findings, narrated: false, reason: 'no_api_key', model: null };
  }

  // Only the findings a reader will actually reach. Narrating the fiftieth MINOR item burns
  // rate limit for something nobody opens.
  const targets = findings
    .filter(f => f.classification !== 'VERIFIED_CONSISTENT')
    .slice(0, MAX_FINDINGS_TO_NARRATE);

  if (targets.length === 0) {
    return { findings, narrated: false, reason: 'nothing_to_narrate', model: null };
  }

  try {
    const payload = targets.map(toPayload);

    const completion = await withTimeout(
      client.chat.completions.create({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              readiness_score: context.score ?? null,
              assessment: context.band ?? null,
              findings: payload
            })
          }
        ],
        model: MODEL,
        temperature: 0.3,
        response_format: { type: 'json_object' }
      }),
      TIMEOUT_MS
    );

    const parsed = JSON.parse(completion.choices[0].message.content);
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    const applied = applyNarratives(findings, items);

    return {
      findings: applied.findings,
      narrated: applied.count > 0,
      reason: applied.count === 0 ? 'no_usable_items_returned' : null,
      model: MODEL,
      narrated_count: applied.count
    };
  } catch (err) {
    // Deliberately swallowed. The templated narratives are already in place and the report is
    // complete without this step.
    console.warn('Narrator unavailable, keeping templated prose:', err.message);
    return { findings, narrated: false, reason: err.message, model: MODEL };
  }
}

/**
 * What the model is allowed to see.
 *
 * Only the facts needed to write a sentence. It never receives the severity multipliers or the
 * pillar weights, because it has no business reasoning about how the score was reached.
 */
function toPayload(f) {
  return {
    ref_code: f.ref_code,
    what_kind_of_problem: f.classification,
    how_serious: f.severity_band,
    metric: f.metric_label,
    period: f.period_key,
    the_check: f.computation.expression,
    the_arithmetic: f.computation.substituted,
    percentage_gap: f.computation.delta_pct,
    could_not_compare_because: f.computation.blocked_reason,
    within_a_single_document: f.computation.single_document,
    documents: (f.evidence || []).map(e => ({
      filename: e.filename,
      kind: e.document_category,
      page: e.page,
      states: e.value_raw,
      quote: e.quote
    })),
    current_draft: f.narrative
  };
}

/**
 * Overwrite prose where the model produced something usable.
 *
 * Every item is validated before it is accepted. A model that returns an unknown ref_code, an
 * empty string, or something suspiciously long is ignored rather than trusted - the templated
 * text is a perfectly good fallback, so there is no reason to accept doubtful output.
 */
const MIN_NARRATIVE_LENGTH = 20;
const MAX_NARRATIVE_LENGTH = 1200;

function applyNarratives(findings, items) {
  const byRef = new Map(findings.map(f => [f.ref_code, f]));
  let count = 0;

  for (const item of items) {
    if (!item || typeof item.ref_code !== 'string') continue;

    const finding = byRef.get(item.ref_code);
    if (!finding) continue; // hallucinated reference

    if (usable(item.narrative)) {
      finding.narrative = item.narrative.trim();
      finding.narrative_source = 'ai';
      count++;
    }

    if (usable(item.follow_up_question)) {
      finding.follow_up_question = item.follow_up_question.trim();
    }
  }

  return { findings, count };
}

function usable(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.length >= MIN_NARRATIVE_LENGTH && trimmed.length <= MAX_NARRATIVE_LENGTH;
}

/**
 * A second opinion from a reasoning model, for the "AI Analyst Notes" tab.
 *
 * Explicitly outside the scoring path. It sees the findings and comments freely; nothing it says
 * can alter a verdict. Its value is twofold: it reads well in a demo, and anything it raises
 * that the engine MISSED is free feedback on where the rule pack has a gap.
 *
 * Returns null on any failure. The tab then shows "unavailable", which is fine.
 */
const SECOND_OPINION_MODEL = process.env.REASONER_MODEL || 'deepseek-r1-distill-llama-70b';

async function secondOpinion(findings, breakdown) {
  const client = getClient();
  if (!client) return null;

  const prompt = `You are a senior investment analyst reviewing a startup's fundraising documents.

A deterministic verification engine has produced the findings below. Comment on them as an
analyst would: what concerns you most, what you would want to see next, and - importantly -
anything you think the engine may have MISSED.

Your commentary is presented separately from the engine's output and does not affect its score.
Do not restate the findings. Add judgement.

Readiness score: ${breakdown.score}/100 (${breakdown.label})

Findings:
${findings
  .filter(f => f.classification !== 'VERIFIED_CONSISTENT')
  .slice(0, 15)
  .map(f => `- [${f.ref_code}] ${f.severity_band} ${f.classification}: ${f.narrative}`)
  .join('\n')}`;

  try {
    const completion = await withTimeout(
      client.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: SECOND_OPINION_MODEL,
        temperature: 0.6,
        max_tokens: 1200
      }),
      TIMEOUT_MS
    );

    const raw = completion.choices[0].message.content || '';

    // Reasoning models emit their chain of thought in <think> tags. Useful for debugging, not
    // for a reader, so it is stored separately rather than shown.
    const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
    const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    if (!text) return null;

    return {
      text,
      reasoning_chain: thinkMatch ? thinkMatch[1].trim() : null,
      model: SECOND_OPINION_MODEL,
      // Carried through to the UI, which must display this alongside the text.
      disclaimer: 'Generative analysis. Not part of the score. Not verified.'
    };
  } catch (err) {
    console.warn('Second opinion unavailable:', err.message);
    return null;
  }
}

/**
 * Hard timeout around a promise.
 *
 * The SDK has its own retry behaviour that can stretch well past any reasonable wait. Since this
 * whole module is optional, a slow response is worth abandoning rather than making the user wait.
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`narrator timed out after ${ms}ms`)), ms)
    )
  ]);
}

module.exports = { narrate, secondOpinion };
