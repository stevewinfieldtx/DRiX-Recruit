// server.js — DRiX Recruit
// 3-URL ingest (vendor / product / partner) → fit score (0-100) → 60 gate
// (override-able) → 5 defended strategies → (on-select) outreach kit
// (entry point + 3-level questions + 5-email drip + phone scripts) → chat + voice
// coach that share ONE memory.
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const unzipper = require('unzipper');

const db = require('./db');
const brain = require('drix-brain'); // shared core — scoring/strategies/outreach/coach
const { recruitIntel, callLLMText } = brain;
const tde = require('./tde'); // TDE-first ingest (decompose once, cache forever); brain is the fallback

const app = express();
const PORT = process.env.PORT || 3002; // 3001 is DRiX Ready Leads

const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID;

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || '';
const RECRUIT_VOICE_ID    = process.env.RECRUIT_VOICE_ID || process.env.COACH_VOICE_ID || '';
const ELEVEN_AGENT_LLM    = process.env.ELEVEN_AGENT_LLM || 'gpt-4o';
const ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || '';
const GATE_THRESHOLD      = parseInt(process.env.GATE_THRESHOLD || '60', 10);

// The ElevenLabs post-call webhook needs the RAW body for signature verification.
app.use((req, res, next) =>
  req.path === '/api/recruit-voice/webhook'
    ? express.raw({ type: '*/*', limit: '2mb' })(req, res, next)
    : express.json({ limit: '2mb' })(req, res, next)
);

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Auth wall + metering (central DRiX Auth). Installs the request-level session
// resolver, so it must run before our routes.
require('./auth').install(app, { db });

// ─── IN-MEMORY RUN STORE ─────────────────────────────────────────────────────
const runStore = new Map();      // run_id → full run object
const voiceAgentStore = new Map(); // run_id → { agent_id }
const agentToRun = new Map();      // agent_id → run_id (for the post-call webhook)

async function getRunOrRehydrate(run_id) {
  let run = runStore.get(run_id);
  if (run) return run;
  try {
    const full = await db.getRunFull(run_id);
    if (full) { runStore.set(run_id, full); return full; }
  } catch (e) { console.error('[rehydrate] failed', run_id, e.message); }
  return null;
}

function newRunId() {
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

// ─── INGEST (in-mem + Postgres cache around the shared brain ingest) ──────────
// The fetch+atomize lives in brain.recruitIntel.ingestPartner (pure); caching is
// the product's concern, so it stays here.
const ingestCache = new Map(); // `${url}::${role}` → result
function ingestMemSet(key, val) {
  ingestCache.set(key, val);
  if (ingestCache.size > 100) ingestCache.delete(ingestCache.keys().next().value);
}
async function ingestCached({ url, role, hint_name = null, supplementalDocs = null, refresh = false }) {
  const key = `${url}::${role}`;
  if (!refresh && ingestCache.has(key)) return { ...ingestCache.get(key), source: 'cache_mem' };

  // TDE-first: decompose once through TDE's recruit lens; serve registry cache hits forever.
  try {
    const result = await tde.ingestEntity({ url, role, supplementalDocs, refresh });
    if (!result.atoms || !result.atoms.length) throw new Error('TDE returned no atoms');
    ingestMemSet(key, result);
    return { ...result, source: result._cache_hit ? 'tde_cache' : 'tde_fresh' };
  } catch (e) {
    // Fail-soft: a TDE outage must never break a run — fall back to the brain path.
    console.error('[tde] ingest fell back to brain:', e.message);
    if (!refresh) {
      const dbCached = await db.getCachedIngest(url, role).catch(() => null);
      if (dbCached) { ingestMemSet(key, dbCached); return { ...dbCached, source: 'cache_db' }; }
    }
    const result = await recruitIntel.ingestPartner({ url, role, hint_name, supplementalDocs });
    ingestMemSet(key, result);
    db.setCachedIngest(url, role, result).catch(err => console.error('[db] cache write:', err.message));
    return { ...result, source: 'fresh_fallback' };
  }
}

// ─── COACH CONTEXT (grounds chat + voice in the run) ─────────────────────────
function entityLine(e, label) {
  if (!e) return `${label}: (not available)`;
  const name = e.target?.name || e.source_url || label;
  const atoms = (e.atoms || []).slice(0, 12).map(a => `• ${a.claim}`).join('\n');
  return `${label}: ${name}\n${e.summary || ''}\n${atoms}`;
}

function buildCoachContext(run) {
  const parts = [];
  parts.push(entityLine(run.vendor, 'VENDOR (program we recruit into)'));
  parts.push(entityLine(run.product, 'PRODUCT (what we want them to sell)'));
  parts.push(entityLine(run.partner, 'PARTNER (the reseller we are recruiting)'));

  const sc = run.score;
  if (sc) {
    parts.push(`FIT SCORE: ${sc.fit_score}/100 — ${sc.verdict}\n${sc.summary || ''}`);
    if (Array.isArray(sc.subscores)) {
      parts.push('SUB-SCORES:\n' + sc.subscores.map(s => `  ${s.name}: ${s.score} (w=${s.weight}) — ${s.rationale}`).join('\n'));
    }
    if (sc.readiness_score != null) {
      const sig = sc.readiness?.signals?.length ? ` — signals: ${sc.readiness.signals.join('; ')}` : '';
      parts.push(`READINESS (timing): ${sc.readiness_score}/100${sig}`);
    }
    if (sc.channel_conflict?.direct_competitor) {
      parts.push(`CHANNEL CONFLICT: direct competitor${sc.channel_conflict.competitor_named ? ` (${sc.channel_conflict.competitor_named})` : ''} — ${sc.channel_conflict.rationale || ''} (fit ${sc.fit_raw}→${sc.fit_score})`);
    }
    if (sc.green_flags?.length) parts.push('GREEN FLAGS:\n' + sc.green_flags.map(f => `  + ${f}`).join('\n'));
    if (sc.red_flags?.length)   parts.push('RED FLAGS:\n' + sc.red_flags.map(f => `  - ${f}`).join('\n'));
  }

  const strats = run.strategies?.strategies || [];
  if (strats.length) {
    parts.push('STRATEGIES:\n' + strats.map(s => `  [${s.id}] ${s.title} (conf ${s.confidence}) → ${s.approach}`).join('\n'));
  }
  if (run.chosen_strategy) parts.push(`CHOSEN STRATEGY: [${run.chosen_strategy.id}] ${run.chosen_strategy.title}`);

  const o = run.outreach;
  if (o) {
    if (o.entry_point) parts.push(`ENTRY POINT: approach=${o.entry_point.how_to_approach}; who=${o.entry_point.who_to_approach?.role}; tone=${o.entry_point.tone}`);
    if (Array.isArray(o.questions)) parts.push('DISCOVERY QUESTIONS:\n' + o.questions.map(q => `  L${q.level} ${q.question} (purpose: ${q.purpose})`).join('\n'));
    if (Array.isArray(o.email_drip)) parts.push(`EMAIL DRIP: ${o.email_drip.length} emails (goal: earn the meeting)`);
  }
  return parts.join('\n\n');
}

function memoryTranscript(rows) {
  if (!rows || !rows.length) return '';
  return rows.map(r => {
    const who = r.role === 'user' ? 'USER' : 'COACH';
    return `${who} [${r.channel}]: ${r.content}`;
  }).join('\n');
}

// ─── FILE UPLOAD (PDF / DOCX / PPTX / TXT) ───────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

async function extractPptxText(buffer) {
  const texts = [];
  const directory = await unzipper.Open.buffer(buffer);
  const slideFiles = directory.files
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f.path))
    .sort((a, b) => (parseInt(a.path.match(/slide(\d+)/)?.[1] || '0') - parseInt(b.path.match(/slide(\d+)/)?.[1] || '0')));
  for (const file of slideFiles) {
    const content = (await file.buffer()).toString('utf-8');
    const matches = content.match(/<a:t>([^<]*)<\/a:t>/g) || [];
    const slideText = matches.map(m => m.replace(/<\/?a:t>/g, '')).join(' ').trim();
    if (slideText) texts.push(slideText);
  }
  return texts.join('\n\n');
}

app.post('/api/upload-doc', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    let text = '';
    if (ext === '.txt') text = req.file.buffer.toString('utf-8');
    else if (ext === '.pdf') text = (await pdfParse(req.file.buffer)).text || '';
    else if (ext === '.docx') text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value || '';
    else if (ext === '.pptx') text = await extractPptxText(req.file.buffer);
    else return res.status(400).json({ error: `Cannot extract text from ${ext} files` });
    text = text.trim().slice(0, 100000);
    res.json({ ok: true, filename: req.file.originalname, size: req.file.size, chars: text.length, text });
  } catch (err) {
    console.error('[upload-doc]', err.message);
    res.status(500).json({ error: `Failed to extract text: ${err.message}` });
  }
});

// ─── THE RECRUIT FLOW (SSE) ──────────────────────────────────────────────────
app.post('/api/recruit-flow', async (req, res) => {
  const {
    email,
    vendor_url, product_url, partner_url,
    docs_vendor, docs_partner,
    override, // if true, generate strategies even when the score is below the gate
  } = req.body || {};

  if (!vendor_url)  return res.status(400).json({ error: 'Require vendor_url' });
  if (!product_url) return res.status(400).json({ error: 'Require product_url' });
  if (!partner_url) return res.status(400).json({ error: 'Require partner_url' });
  if (!OPENROUTER_API_KEY || !OPENROUTER_MODEL_ID) {
    return res.status(500).json({ error: 'Server not configured — set OPENROUTER_API_KEY and OPENROUTER_MODEL_ID' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const keepAlive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch {} }, 15000);
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };

  const run_id = newRunId();
  const inputs = { email: email || req.userEmail || null, vendor_url, product_url, partner_url };

  try {
    // 1) Ingest the three entities.
    send('phase', { phase: 'ingest_vendor', label: 'Reading the vendor…' });
    const vendor = await ingestCached({ url: vendor_url, role: 'vendor', supplementalDocs: docs_vendor });
    send('atoms', { role: 'vendor', name: vendor.target?.name, count: vendor.atoms.length, summary: vendor.summary });

    send('phase', { phase: 'ingest_product', label: 'Reading the product…' });
    const product = await ingestCached({ url: product_url, role: 'product' });
    send('atoms', { role: 'product', name: product.target?.name, count: product.atoms.length, summary: product.summary });

    send('phase', { phase: 'ingest_partner', label: 'Reading the partner…' });
    const partner = await ingestCached({ url: partner_url, role: 'partner', supplementalDocs: docs_partner });
    send('atoms', { role: 'partner', name: partner.target?.name, count: partner.atoms.length, summary: partner.summary });

    // 2) Fit score.
    send('phase', { phase: 'score', label: 'Scoring partner fit…' });
    const scoreEntities = {
      vendor:  { name: vendor.target?.name,  summary: vendor.summary,  atoms: vendor.atoms },
      product: { name: product.target?.name, summary: product.summary, atoms: product.atoms },
      partner: { name: partner.target?.name, summary: partner.summary, atoms: partner.atoms },
    };
    // Shared brain lens: 8 weighted FIT dims + separate READINESS axis + code-side
    // channel-conflict adjustment. fit_score comes back already clamped/computed.
    const score = await brain.recruitIntel.scoreFit(scoreEntities, {
      conflictMode: process.env.RECRUIT_CONFLICT_MODE || 'penalty',
    });
    // Enrich each subscore with its display label + canonical weight (held in the
    // brain's FIT_DIMENSIONS) so the UI + coach can render name/weight unchanged.
    const dimByKey = Object.fromEntries(brain.recruitIntel.FIT_DIMENSIONS.map(d => [d.key, d]));
    score.subscores = (score.subscores || []).map(s => ({
      ...s, name: dimByKey[s.key]?.label || s.key, weight: dimByKey[s.key]?.weight ?? null,
    }));
    send('score', score);

    // 3) The gate.
    const passed = score.fit_score >= GATE_THRESHOLD;
    let strategies = null;

    if (!passed && !override) {
      send('gate', { passed: false, threshold: GATE_THRESHOLD, fit_score: score.fit_score, verdict: score.verdict, red_flags: score.red_flags || [] });
      const results = { run_id, ...inputs, vendor, product, partner, score, gate_passed: false, strategies: null };
      runStore.set(run_id, results);
      db.saveRun(run_id, inputs, results).catch(e => console.error('[db] saveRun:', e.message));
      send('done', { run_id, fit_score: score.fit_score, gate_passed: false });
      clearInterval(keepAlive); return res.end();
    }

    // 4) Five defended strategies (score passed, or user overrode).
    send('gate', { passed: true, threshold: GATE_THRESHOLD, fit_score: score.fit_score, overridden: !passed && !!override });
    send('phase', { phase: 'strategies', label: 'Building recruitment strategies…' });
    strategies = await brain.recruitIntel.generateRecruitStrategies({
      vendor:  { name: vendor.target?.name,  summary: vendor.summary,  atoms: vendor.atoms },
      product: { name: product.target?.name, summary: product.summary, atoms: product.atoms },
      partner: { name: partner.target?.name, summary: partner.summary, atoms: partner.atoms },
      fit: score,
    });
    send('strategies', strategies);

    const results = { run_id, ...inputs, vendor, product, partner, score, gate_passed: true, strategies };
    runStore.set(run_id, results);
    db.saveRun(run_id, inputs, results).catch(e => console.error('[db] saveRun:', e.message));

    send('done', { run_id, fit_score: score.fit_score, gate_passed: true });
    clearInterval(keepAlive); res.end();
  } catch (err) {
    console.error('[recruit-flow]', err.message);
    send('error', { error: err.message });
    clearInterval(keepAlive); res.end();
  }
});

// ─── OUTREACH KIT (on strategy selection) ────────────────────────────────────
app.post('/api/recruit-outreach', async (req, res) => {
  const { run_id, strategy_id } = req.body || {};
  if (!run_id) return res.status(400).json({ error: 'Require run_id' });
  const run = await getRunOrRehydrate(run_id);
  if (!run) return res.status(404).json({ error: 'run_id not found or expired' });

  const chosen = (run.strategies?.strategies || []).find(s => s.id === strategy_id);
  if (!chosen) return res.status(400).json({ error: 'Require a valid strategy_id' });

  try {
    const input = JSON.stringify({
      vendor:  { name: run.vendor?.target?.name,  summary: run.vendor?.summary,  atoms: run.vendor?.atoms },
      product: { name: run.product?.target?.name, summary: run.product?.summary, atoms: run.product?.atoms },
      partner: { name: run.partner?.target?.name, summary: run.partner?.summary, atoms: run.partner?.atoms },
      fit: run.score,
      chosen_strategy: chosen,
    });
    const outreach = await recruitIntel.generateOutreach(input, { maxTokens: 6000, temperature: 0.5 });

    run.chosen_strategy = chosen;
    run.outreach = outreach;
    runStore.set(run_id, run);
    db.saveOutreach(run_id, chosen.id, chosen.title || '', outreach).catch(e => console.error('[db] saveOutreach:', e.message));

    res.json({ run_id, chosen_strategy: chosen, outreach });
  } catch (err) {
    console.error('[recruit-outreach]', err.message);
    res.status(500).json({ error: `Outreach generation failed: ${err.message}` });
  }
});

// ─── CHAT COACH (shares memory with voice) ───────────────────────────────────
app.post('/api/recruit-chat', async (req, res) => {
  const { run_id, message } = req.body || {};
  if (!run_id)  return res.status(400).json({ error: 'Require run_id' });
  if (!message) return res.status(400).json({ error: 'Require message' });

  const run = await getRunOrRehydrate(run_id);
  if (!run) return res.status(404).json({ error: 'run_id not found or expired' });

  // Server is the single source of truth: pull the FULL memory (chat + voice).
  const mem = await db.getMemory(run_id).catch(() => []);
  const context = buildCoachContext(run);
  const transcript = memoryTranscript(mem);
  const systemPrompt = recruitIntel.RECRUIT_COACH_PROMPT
    + `\n---\nPARTNER-RECRUITMENT INTELLIGENCE:\n${context}\n---`
    + (transcript ? `\n\nCONVERSATION SO FAR (across chat AND voice — treat as one shared memory):\n${transcript}\n---` : '');

  try {
    const reply = await callLLMText(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }],
      { temperature: 0.5, maxTokens: 2000 }
    );
    // Persist BOTH turns to the shared memory so voice sees them next session.
    db.appendMemory(run_id, 'chat', 'user', message).catch(() => {});
    db.appendMemory(run_id, 'chat', 'assistant', reply).catch(() => {});
    res.json({ reply });
  } catch (err) {
    console.error('[recruit-chat]', err.message);
    res.status(502).json({ error: `Coach failed: ${err.message}` });
  }
});

// ─── VOICE COACH — provision an ElevenLabs agent seeded with shared memory ────
app.post('/api/recruit-voice/provision', async (req, res) => {
  const { run_id } = req.body || {};
  if (!run_id) return res.status(400).json({ error: 'Require run_id' });
  if (!ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });

  const run = await getRunOrRehydrate(run_id);
  if (!run) return res.status(404).json({ error: 'run_id not found or expired' });

  try {
    // Seed the voice agent with the run context AND the shared memory so it knows
    // everything discussed in chat (and prior voice calls) up to this moment.
    const mem = await db.getMemory(run_id).catch(() => []);
    const context = buildCoachContext(run);
    const transcript = memoryTranscript(mem);
    const partnerName = run.partner?.target?.name || 'this partner';
    const voicePrompt = recruitIntel.RECRUIT_COACH_PROMPT
      + `\n---\nPARTNER-RECRUITMENT INTELLIGENCE:\n${context}\n---`
      + (transcript ? `\n\nCONVERSATION SO FAR (across chat AND voice — one shared memory):\n${transcript}\n---` : '')
      + `\n\nVOICE RULES:\n- You are on a voice call. Keep turns spoken-length (2-3 sentences unless asked for more).\n- Leave room for back-and-forth; don't monologue.\n- When giving a script, say "Here's what I'd say:" then deliver it naturally.\n`;

    const payload = {
      name: `DRiX Recruit Coach — ${partnerName} (${run_id})`,
      conversation_config: {
        agent: {
          prompt: { prompt: voicePrompt, llm: ELEVEN_AGENT_LLM, temperature: 0.6 },
          first_message: `Hey — I've studied the recruit analysis on ${partnerName}: the fit score, the strategies, and everything we've talked about so far. What do you want to work on?`,
          language: 'en',
        },
        ...(RECRUIT_VOICE_ID ? { tts: { voice_id: RECRUIT_VOICE_ID } } : {}),
      },
    };

    // Re-provision each time so the freshest memory is baked in. Clean up the old
    // agent for this run if one exists.
    const prev = voiceAgentStore.get(run_id);
    if (prev?.agent_id) {
      fetch(`https://api.elevenlabs.io/v1/convai/agents/${prev.agent_id}`, { method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_API_KEY } }).catch(() => {});
      agentToRun.delete(prev.agent_id);
    }

    const elRes = await fetch('https://api.elevenlabs.io/v1/convai/agents/create', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!elRes.ok) { const txt = await elRes.text(); throw new Error(`ElevenLabs ${elRes.status}: ${txt.slice(0, 300)}`); }
    const result = await elRes.json();
    const agent_id = result.agent_id;

    voiceAgentStore.set(run_id, { agent_id, created_at: Date.now() });
    agentToRun.set(agent_id, run_id);

    console.log(`[recruit-voice] Provisioned ${agent_id} for ${run_id} (${partnerName})`);
    res.json({ agent_id });
  } catch (err) {
    console.error('[recruit-voice]', err.message);
    res.status(502).json({ error: `Voice provisioning failed: ${err.message}` });
  }
});

// ─── VOICE POST-CALL WEBHOOK — ingest the transcript into shared memory ───────
// Configure this URL as the ElevenLabs post-call webhook. When a voice call ends,
// ElevenLabs POSTs the transcript here; we append those turns to recruit_memory so
// the chat coach (and the next voice call) know what was said. This is the
// session-boundary sync that keeps chat ↔ voice memory shared.
app.post('/api/recruit-voice/webhook', async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

    // Optional HMAC verification (ElevenLabs signs with your webhook secret).
    if (ELEVENLABS_WEBHOOK_SECRET) {
      const sig = req.headers['elevenlabs-signature'] || req.headers['x-elevenlabs-signature'] || '';
      const ok = verifyElevenSig(raw, String(sig));
      if (!ok) { console.warn('[voice-webhook] signature mismatch — rejecting'); return res.status(401).json({ error: 'bad signature' }); }
    }

    const payload = JSON.parse(raw || '{}');
    const data = payload.data || payload;
    const agent_id = data.agent_id;
    const conversation_id = data.conversation_id || data.conversation?.conversation_id || 'conv';
    const run_id = agentToRun.get(agent_id)
      || data.conversation_initiation_client_data?.dynamic_variables?.run_id
      || null;

    if (!run_id) { console.warn('[voice-webhook] no run mapping for agent', agent_id); return res.json({ ok: true, ignored: true }); }

    const turns = data.transcript || data.turns || [];
    let n = 0;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const content = t.message || t.text || '';
      if (!content) continue;
      const role = (t.role === 'agent' || t.role === 'assistant') ? 'assistant' : 'user';
      await db.appendMemory(run_id, 'voice', role, content, `${conversation_id}:${i}`);
      n++;
    }
    console.log(`[voice-webhook] ingested ${n} voice turns into run ${run_id}`);
    res.json({ ok: true, ingested: n });
  } catch (err) {
    console.error('[voice-webhook]', err.message);
    res.status(200).json({ ok: false, error: err.message }); // 200 so ElevenLabs doesn't hammer retries
  }
});

function verifyElevenSig(rawBody, sigHeader) {
  try {
    // ElevenLabs header format: "t=<ts>,v0=<hex hmac of `${t}.${body}`>"
    const parts = Object.fromEntries(String(sigHeader).split(',').map(s => s.split('=')));
    const t = parts.t;
    const provided = parts.v0 || parts.v1 || '';
    const expected = crypto.createHmac('sha256', ELEVENLABS_WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch { return false; }
}

// ─── FETCH A SAVED RUN ───────────────────────────────────────────────────────
app.get('/api/recruit/:run_id', async (req, res) => {
  const run = await getRunOrRehydrate(req.params.run_id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json(run);
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    app: 'drix-recruit',
    model: OPENROUTER_MODEL_ID || null,
    gate_threshold: GATE_THRESHOLD,
    database_configured: db.isConfigured(),
    voice_configured: !!ELEVENLABS_API_KEY,
    runs_in_memory: runStore.size,
    dev_open: String(process.env.RECRUIT_DEV_OPEN || '').toLowerCase() === 'true',
  });
});

// ─── SPA FALLBACK ────────────────────────────────────────────────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.initSchema().catch(() => {});
app.listen(PORT, () => {
  console.log(`\n  DRiX Recruit listening on http://localhost:${PORT}`);
  console.log(`  model=${OPENROUTER_MODEL_ID || '(unset)'} gate=${GATE_THRESHOLD} db=${db.isConfigured() ? 'on' : 'off'} voice=${ELEVENLABS_API_KEY ? 'on' : 'off'} dev_open=${String(process.env.RECRUIT_DEV_OPEN || '').toLowerCase() === 'true'}\n`);
});
