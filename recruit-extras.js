// recruit-extras.js — DRiX Recruit presentation-layer generators.
//
// These sit on TOP of the shared brain recruit lens (scoreFit / strategies /
// outreach). They surface the extra output the Leads product exposes:
//   generatePains()   → partner pain/opportunity cards (why they'd sell it)
//   analyzeSignals()  → ClearSignals-style recruitment-health read on a reply thread
//
// Local for now (fast iteration, no brain release cycle). Promote into
// drix-brain.recruitIntel once stable. Both call brain.callLLM with a schema so
// the model returns validated JSON.

const brain = require('drix-brain');
const { callLLM } = brain;

// ─── PARTNER PAINS ────────────────────────────────────────────────────────────
const PAINS_PROMPT = `You are the pain-mapping engine of the DRiX partner-recruitment lens.

You are given atoms for three entities: the VENDOR (whose program we recruit into), the PRODUCT we want the partner to sell, and the PARTNER (the reseller). You also get the fit assessment.

TASK: identify the 3-4 business pains or opportunities THIS PARTNER has that adding and actively selling THIS PRODUCT would relieve or capture. This is the recruitment angle — why it is in the PARTNER's own interest to take the line on, NOT the end-customer's pain. Think: margin pressure, a gap in their portfolio, unmet customer demand they currently turn away, competitive displacement risk, services/attach revenue they are leaving on the table, staffing leverage.

For EACH pain:
  - title: short, specific (4-8 words)
  - why: the partner's business impact, grounded in the partner/product atoms (no generic filler)
  - owner_role: the person inside the partner who feels this most (owner/principal, VP Alliances, practice lead, SOC lead, sales lead) — pick from the partner atoms
  - urgency: "high" | "medium" | "low"
  - pull: the positive driver that makes acting attractive (e.g. "recurring margin", "differentiation", "land-and-expand")
  - inertia: what holds them back from acting today (e.g. "training cost", "vendor sprawl", "change fatigue")
  - evidence: one supporting fact paraphrased from the atoms (max 18 words)

Ground every pain in the atoms. Do not invent partner facts. Return the result via the provided schema.`;

const PAINS_SCHEMA = {
  type: 'object',
  required: ['pains'],
  properties: {
    pains: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        type: 'object',
        required: ['title', 'why', 'owner_role', 'urgency', 'pull', 'inertia'],
        properties: {
          title:      { type: 'string' },
          why:        { type: 'string' },
          owner_role: { type: 'string' },
          urgency:    { type: 'string', enum: ['high', 'medium', 'low'] },
          pull:       { type: 'string' },
          inertia:    { type: 'string' },
          evidence:   { type: 'string' },
        },
      },
    },
  },
};

async function generatePains({ vendor, product, partner, score } = {}, opts = {}) {
  const payload = JSON.stringify({
    vendor:  { name: vendor?.target?.name,  summary: vendor?.summary,  atoms: vendor?.atoms },
    product: { name: product?.target?.name, summary: product?.summary, atoms: product?.atoms },
    partner: { name: partner?.target?.name, summary: partner?.summary, atoms: partner?.atoms },
    fit: score ? { fit_score: score.fit_score, verdict: score.verdict, readiness: score.readiness } : null,
  });
  const out = await callLLM(PAINS_PROMPT, payload, {
    maxTokens: opts.maxTokens || 3000,
    temperature: opts.temperature != null ? opts.temperature : 0.3,
    retries: opts.retries != null ? opts.retries : 1,
    responseSchema: PAINS_SCHEMA,
  });
  return { pains: Array.isArray(out && out.pains) ? out.pains : [] };
}

// ─── CLEARSIGNALS (recruitment-health read on a reply thread) ─────────────────
const SIGNALS_PROMPT = `You are ClearSignals for DRiX partner recruitment.

You are given CONTEXT about a recruitment run (the partner, the product, the fit, the chosen strategy) and a raw EMAIL/REPLY THREAD from the partner. Read the thread and judge how the recruitment is actually going.

TASK:
  - health_score: 0-100 — how warm/interested this partner is in joining the program and selling this product, based ONLY on what the thread shows.
  - verdict: one line summarising where this stands.
  - positive_signals: concrete things in the thread that indicate interest/momentum.
  - risks: concerns, cooling signals, or stalls visible in the thread.
  - objections: [{ objection, response }] — objections the partner raised (or clearly implied) and the best response to each, grounded in the run context.
  - next_step: the single best next move to advance the recruitment.

Ground everything in the actual thread. If the thread is thin, say so and score conservatively. Return via the provided schema.`;

const SIGNALS_SCHEMA = {
  type: 'object',
  required: ['health_score', 'verdict', 'next_step'],
  properties: {
    health_score: { type: 'integer', minimum: 0, maximum: 100 },
    verdict:      { type: 'string' },
    positive_signals: { type: 'array', items: { type: 'string' } },
    risks:        { type: 'array', items: { type: 'string' } },
    objections:   { type: 'array', items: { type: 'object', properties: { objection: { type: 'string' }, response: { type: 'string' } } } },
    next_step:    { type: 'string' },
  },
};

async function analyzeSignals({ context, thread } = {}, opts = {}) {
  const payload = JSON.stringify({ context: context || '', thread: String(thread || '').slice(0, 12000) });
  const out = await callLLM(SIGNALS_PROMPT, payload, {
    maxTokens: opts.maxTokens || 2000,
    temperature: opts.temperature != null ? opts.temperature : 0.3,
    retries: opts.retries != null ? opts.retries : 1,
    responseSchema: SIGNALS_SCHEMA,
  });
  return out || { health_score: 0, verdict: 'Could not analyze the thread.', positive_signals: [], risks: [], objections: [], next_step: '' };
}

module.exports = { generatePains, analyzeSignals, PAINS_PROMPT, SIGNALS_PROMPT };
