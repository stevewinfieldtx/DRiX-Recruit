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
const recruitExtras = require('./recruit-extras'); // pains + ClearSignals-style thread analysis

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

// Parse an .xlsx as a TABLE and pull PARTNER website URLs: find the website/domain
// column by its header (never the social columns), normalize bare domains to
// https://, and drop social + email + schema noise. Falls back to domain-like
// cells only if no website header is found. Returns newline-joined URLs.
const SOCIAL_HOST = /(?:^|\.)(?:twitter\.com|x\.com|facebook\.com|fb\.com|linkedin\.com|instagram\.com|youtube\.com|tiktok\.com|pinterest\.com|t\.co)(?:[\/:?]|$)/i;
function xlsxDecode(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#3?9;|&apos;/g, "'");
}
function colIdx(ref) { const m = /^([A-Z]+)/.exec(ref); let n = 0; for (const ch of (m ? m[1] : 'A')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function normSite(v) {
  let s = String(v || '').trim().replace(/^https?:\/\//i, '').replace(/^\/+/, '');
  if (!s || s.includes('@') || /\s/.test(s)) return null;   // skip emails / multi-word junk
  if (!/^[\w-]+(\.[\w-]+)+/.test(s)) return null;           // must look like a domain
  if (SOCIAL_HOST.test(s)) return null;                     // drop social hosts
  return 'https://' + s.replace(/\/+$/, '');
}
async function extractXlsxText(buffer) {
  const dir = await unzipper.Open.buffer(buffer);
  // shared strings table
  const ss = [];
  const ssFile = dir.files.find(f => /xl\/sharedStrings\.xml$/i.test(f.path));
  if (ssFile) {
    const c = (await ssFile.buffer()).toString('utf-8');
    for (const si of (c.match(/<si>[\s\S]*?<\/si>/g) || [])) {
      const runs = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
      ss.push(xlsxDecode(runs.map(t => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  // first worksheet → rows of { colIndex: value }
  const sheetFile = dir.files.filter(f => /xl\/worksheets\/sheet\d+\.xml$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))[0];
  if (!sheetFile) return '';
  const sheet = (await sheetFile.buffer()).toString('utf-8');
  const rows = [];
  for (const rowXml of (sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [])) {
    const cells = {};
    for (const c of (rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [])) {
      const ref = (/r="([A-Z]+)\d+"/.exec(c) || [])[1];
      if (!ref) continue;
      const t = (/t="([^"]+)"/.exec(c) || [])[1] || 'n';
      let val = '';
      if (t === 's') { const vi = (/<v>(\d+)<\/v>/.exec(c) || [])[1]; val = ss[parseInt(vi, 10)] || ''; }
      else if (t === 'inlineStr') { val = xlsxDecode((/<t[^>]*>([\s\S]*?)<\/t>/.exec(c) || [])[1] || ''); }
      else { val = xlsxDecode((/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1] || ''); }
      cells[colIdx(ref)] = val;
    }
    rows.push(cells);
  }
  if (!rows.length) return '';
  // header row → website column(s): match web/site/domain/url, never social columns
  const header = rows[0];
  const siteCols = Object.keys(header).map(Number).filter(ci => {
    const h = String(header[ci] || '');
    return /web\s*site|homepage|domain|\burl\b|\bwww\b|\bsite\b/i.test(h) && !/social|twitter|facebook|linked|instagram|youtube|tiktok/i.test(h);
  });
  const urls = [];
  const source = siteCols.length ? rows.slice(1).flatMap(r => siteCols.map(ci => r[ci])) : rows.slice(1).flatMap(r => Object.values(r));
  for (const v of source) { const u = normSite(v); if (u) urls.push(u); }
  return [...new Set(urls)].join('\n');
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
    else if (ext === '.xlsx') text = await extractXlsxText(req.file.buffer);
    else if (ext === '.csv')  text = req.file.buffer.toString('utf-8');
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
    send('atoms', { role: 'vendor', name: vendor.target?.name, count: vendor.atoms.length, summary: vendor.summary, atoms: vendor.atoms });

    send('phase', { phase: 'ingest_product', label: 'Reading the product…' });
    const product = await ingestCached({ url: product_url, role: 'product' });
    send('atoms', { role: 'product', name: product.target?.name, count: product.atoms.length, summary: product.summary, atoms: product.atoms });

    send('phase', { phase: 'ingest_partner', label: 'Reading the partner…' });
    const partner = await ingestCached({ url: partner_url, role: 'partner', supplementalDocs: docs_partner });
    send('atoms', { role: 'partner', name: partner.target?.name, count: partner.atoms.length, summary: partner.summary, atoms: partner.atoms });

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

    // 2b) Partner pains — why it is in THIS partner's interest to take the line on.
    send('phase', { phase: 'pains', label: 'Mapping partner pains…' });
    const painsOut = await recruitExtras.generatePains({ vendor, product, partner, score })
      .catch((e) => { console.error('[pains]', e.message); return { pains: [] }; });
    send('pains', painsOut);

    // 3) The gate.
    const passed = score.fit_score >= GATE_THRESHOLD;
    let strategies = null;

    if (!passed && !override) {
      send('gate', { passed: false, threshold: GATE_THRESHOLD, fit_score: score.fit_score, verdict: score.verdict, red_flags: score.red_flags || [] });
      const results = { run_id, ...inputs, vendor, product, partner, score, pains: painsOut.pains, gate_passed: false, strategies: null };
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

    const results = { run_id, ...inputs, vendor, product, partner, score, pains: painsOut.pains, gate_passed: true, strategies };
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

// ─── CLEARSIGNALS (recruitment-health read on a partner reply thread) ─────────
app.post('/api/recruit-signals', async (req, res) => {
  const { run_id, thread } = req.body || {};
  if (!run_id || !thread || !String(thread).trim()) return res.status(400).json({ error: 'run_id and thread are required' });
  try {
    const run = await getRunOrRehydrate(run_id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const context = buildCoachContext(run); // same grounding the coach uses
    const signals = await recruitExtras.analyzeSignals({ context, thread });
    res.json({ ok: true, signals });
  } catch (e) { console.error('[recruit-signals]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── FULL REPORT (opens in Word or any browser) ──────────────────────────────
app.get('/api/recruit-report/:run_id', async (req, res) => {
  try {
    const run = await getRunOrRehydrate(req.params.run_id);
    if (!run) return res.status(404).send('Run not found');
    const partner = (run.partner?.target?.name || 'partner').replace(/[^a-z0-9]+/gi, '-');
    res.set('Content-Type', 'application/msword');
    res.set('Content-Disposition', `attachment; filename="DRiX-Recruit-${partner}.doc"`);
    res.send(buildReportHtml(run));
  } catch (e) { console.error('[recruit-report]', e.message); res.status(500).send(e.message); }
});

// Combined report for a set of runs (the triage winners): /api/recruit-report-batch?ids=r1,r2,…
app.get('/api/recruit-report-batch', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
  if (!ids.length) return res.status(400).send('Require ?ids=run1,run2,…');
  try {
    const runs = [];
    for (const id of ids) { const r = await getRunOrRehydrate(id); if (r) runs.push(r); }
    if (!runs.length) return res.status(404).send('No runs found');
    res.set('Content-Type', 'application/msword');
    res.set('Content-Disposition', `attachment; filename="DRiX-Recruit-${runs.length}-partners.doc"`);
    res.send(buildCombinedReportHtml(runs));
  } catch (e) { console.error('[recruit-report-batch]', e.message); res.status(500).send(e.message); }
});

function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// One partner's report content (no <html> wrapper) — reused by single + combined.
function buildReportSection(run) {
  const p = run.partner || {}, pr = run.product || {}, v = run.vendor || {}, s = run.score || {};
  const strategies = (run.strategies && run.strategies.strategies) || [];
  const pains = run.pains || [];
  const entityAtoms = (e, label) => {
    const atoms = (e && e.atoms) || [];
    if (!atoms.length) return '';
    const groups = {};
    for (const a of atoms) { const c = a.category || 'other'; (groups[c] = groups[c] || []).push(a); }
    return `<h3>${esc(label)} — ${esc(e.target?.name || '')} (${atoms.length} atoms)</h3>` +
      Object.entries(groups).map(([cat, as]) => `<p><b>${esc(cat.replace(/_/g, ' '))}</b></p><ul>` +
        as.map((a) => `<li>${esc(a.claim)} <i>[${esc(a.type || '')}${a.confidence ? ', ' + esc(a.confidence) : ''}]</i></li>`).join('') + `</ul>`).join('');
  };
  const subs = (s.subscores || []).map((ss) => `<li>${esc(ss.name || ss.key)}: ${ss.score}/100 (w ${ss.weight}) — ${esc(ss.rationale || '')}</li>`).join('');
  const painRows = pains.map((pn) => `<tr><td><b>${esc(pn.title)}</b><br>${esc(pn.why || '')}</td><td>${esc(pn.owner_role || '')}</td><td>urgency: ${esc(pn.urgency || '')}<br>pull: ${esc(pn.pull || '')}<br>inertia: ${esc(pn.inertia || '')}</td></tr>`).join('');
  const stratBlocks = strategies.map((st) => `<h3>${esc(st.title || '')} (confidence ${st.confidence})</h3><p>${esc(st.approach || '')}</p><p><i>Why this partner:</i> ${esc(st.rationale || '')}</p><p><i>Aim at:</i> ${esc(st.target_role || '')}</p>`).join('');
  return `<h1>DRiX Recruit — Partner Fit Report</h1>
<p><b>Vendor:</b> ${esc(v.target?.name || run.vendor_url || '')} &nbsp;·&nbsp; <b>Product:</b> ${esc(pr.target?.name || run.product_url || '')} &nbsp;·&nbsp; <b>Partner:</b> ${esc(p.target?.name || run.partner_url || '')}</p>
<h2>Fit score: ${s.fit_score || 0}/100 — ${esc(s.verdict || '')}</h2>
<p>${esc(s.summary || '')}</p>
<ul>${subs}</ul>
${s.readiness_score != null ? `<p><b>Readiness (timing):</b> ${s.readiness_score}/100${s.readiness && s.readiness.signals && s.readiness.signals.length ? ' — ' + esc(s.readiness.signals.join('; ')) : ''}</p>` : ''}
${pains.length ? `<h2>Partner pains</h2><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%"><tr><th align="left">Pain</th><th align="left">Owner</th><th align="left">Forces</th></tr>${painRows}</table>` : ''}
${strategies.length ? `<h2>Recruitment strategies</h2>${stratBlocks}` : ''}
<h2>Discovered intelligence</h2>
${entityAtoms(p, 'PARTNER')}
${entityAtoms(pr, 'PRODUCT')}
${entityAtoms(v, 'VENDOR')}`;
}

function reportShell(title, inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:Calibri,Arial,sans-serif;max-width:800px;margin:auto;color:#111;line-height:1.5">
${inner}
<hr><p style="color:#888;font-size:12px">Generated by DRiX Recruit.</p>
</body></html>`;
}

function buildReportHtml(run) { return reportShell('DRiX Recruit Report', buildReportSection(run)); }

// Combined report: every winner stacked into one document (page-break between).
function buildCombinedReportHtml(runs) {
  const inner = `<h1 style="font-size:26px">DRiX Recruit — ${runs.length}-partner report</h1>`
    + runs.map((r, i) => (i ? '<div style="page-break-before:always"></div>' : '') + buildReportSection(r)).join('\n<hr>\n');
  return reportShell(`DRiX Recruit — ${runs.length} partners`, inner);
}

// ─── BATCH QUICK-PULL (SSE) — score many partners vs ONE vendor+product ──────
// Triage a list: ingest vendor+product once, then ingest+score each partner and
// stream a ranked row per partner. No strategies/outreach — that's the deep-dive
// you run on the winners (single flow, which reuses the cached ingest).
app.post('/api/recruit-batch', async (req, res) => {
  const { vendor_url, product_url, partner_urls, docs_vendor } = req.body || {};
  if (!vendor_url)  return res.status(400).json({ error: 'Require vendor_url' });
  if (!product_url) return res.status(400).json({ error: 'Require product_url' });
  const cleaned = Array.isArray(partner_urls)
    ? [...new Set(partner_urls.map(u => String(u || '').trim()).filter(Boolean))]
    : [];
  if (!cleaned.length) return res.status(400).json({ error: 'Require at least one partner URL' });
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

  send('start', { total: cleaned.length });
  try {
    // Vendor + product are ingested ONCE and reused for every partner.
    send('phase', { label: 'Reading vendor + product…' });
    const [vendor, product] = await Promise.all([
      ingestCached({ url: vendor_url, role: 'vendor', supplementalDocs: docs_vendor }),
      ingestCached({ url: product_url, role: 'product' }),
    ]);
    const vBlock = { name: vendor.target?.name, summary: vendor.summary, atoms: vendor.atoms };
    const pBlock = { name: product.target?.name, summary: product.summary, atoms: product.atoms };

    let done = 0, next = 0;
    const CONCURRENCY = 3;
    async function worker() {
      while (next < cleaned.length) {
        const url = cleaned[next++];
        try {
          const partner = await ingestCached({ url, role: 'partner' });
          const score = await recruitIntel.scoreFit(
            { vendor: vBlock, product: pBlock, partner: { name: partner.target?.name, summary: partner.summary, atoms: partner.atoms } },
            { conflictMode: process.env.RECRUIT_CONFLICT_MODE || 'penalty' }
          );
          send('row', {
            url,
            name: partner.target?.name || url,
            fit_score: score.fit_score,
            verdict: score.verdict,
            readiness_score: score.readiness_score ?? null,
            gate_passed: score.fit_score >= GATE_THRESHOLD,
            conflict: !!(score.channel_conflict && score.channel_conflict.direct_competitor),
            top_green: (score.green_flags || [])[0] || null,
            top_red: (score.red_flags || [])[0] || null,
          });
        } catch (err) {
          send('row', { url, name: url, error: err.message });
        }
        send('progress', { done: ++done, total: cleaned.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cleaned.length) }, worker));
    send('done', { total: cleaned.length, gate_threshold: GATE_THRESHOLD });
    clearInterval(keepAlive); res.end();
  } catch (err) {
    console.error('[recruit-batch]', err.message);
    send('error', { error: err.message });
    clearInterval(keepAlive); res.end();
  }
});

// ─── TRIAGE FUNNEL (SSE) — XLSX/list → cheap 1-10 → auto-run the winners ─────
// Pass 1 (all): light-scrape + batched 1-10. Cut the bottom, promote the top,
// re-triage the middle (pass 2, fuller signal) and promote its upper half. Then
// auto-run the promoted set through the FULL flow → each a saved run + live link.
async function lightFetch(url, cache) {
  if (cache.has(url)) return cache.get(url);
  let v;
  try { v = await brain.fetchAndStrip(url); }
  catch (e) { v = { url, title: null, description: null, text: '', error: e.message }; }
  cache.set(url, v);
  return v;
}
async function mapPool(items, size, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) || 1 }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// Run ONE partner through the full flow using already-ingested vendor+product.
// Auto-picks the top strategy and generates its outreach so the live link is complete.
async function runWinnerFullPass({ vendor, product, vendor_url, product_url, partner_url }) {
  const run_id = newRunId();
  const partner = await ingestCached({ url: partner_url, role: 'partner' });
  const scoreEntities = {
    vendor:  { name: vendor.target?.name,  summary: vendor.summary,  atoms: vendor.atoms },
    product: { name: product.target?.name, summary: product.summary, atoms: product.atoms },
    partner: { name: partner.target?.name, summary: partner.summary, atoms: partner.atoms },
  };
  const score = await recruitIntel.scoreFit(scoreEntities, { conflictMode: process.env.RECRUIT_CONFLICT_MODE || 'penalty' });
  const dimByKey = Object.fromEntries(recruitIntel.FIT_DIMENSIONS.map(d => [d.key, d]));
  score.subscores = (score.subscores || []).map(s => ({ ...s, name: dimByKey[s.key]?.label || s.key, weight: dimByKey[s.key]?.weight ?? null }));
  const painsOut = await recruitExtras.generatePains({ vendor, product, partner, score }).catch(() => ({ pains: [] }));
  const strategies = await recruitIntel.generateRecruitStrategies({ ...scoreEntities, fit: score });
  const chosen = (strategies?.strategies || []).find(s => s.id === strategies.top_pick_id) || (strategies?.strategies || [])[0] || null;
  let outreach = null;
  if (chosen) outreach = await recruitIntel.generateOutreach({ ...scoreEntities, fit: score, chosen_strategy: chosen })
    .catch((e) => { console.error('[winner outreach]', e.message); return null; });
  const inputs = { vendor_url, product_url, partner_url };
  const results = { run_id, ...inputs, vendor, product, partner, score, pains: painsOut.pains, gate_passed: score.fit_score >= GATE_THRESHOLD, strategies, chosen_strategy: chosen, outreach };
  runStore.set(run_id, results);
  db.saveRun(run_id, inputs, results).catch(e => console.error('[db] saveRun:', e.message));
  if (chosen && outreach) db.saveOutreach(run_id, chosen.id, chosen.title || '', outreach).catch(e => console.error('[db] saveOutreach:', e.message));
  return { run_id, fit_score: score.fit_score, name: partner.target?.name || partner_url };
}

app.post('/api/recruit-triage', async (req, res) => {
  const {
    vendor_url, product_url, partner_urls, docs_vendor,
    cut_below = 4, promote_at = 8,
    max_full_pass = parseInt(process.env.TRIAGE_MAX_FULL_PASS || '25', 10),
  } = req.body || {};
  if (!vendor_url)  return res.status(400).json({ error: 'Require vendor_url' });
  if (!product_url) return res.status(400).json({ error: 'Require product_url' });
  const urls = Array.isArray(partner_urls) ? [...new Set(partner_urls.map(u => String(u || '').trim()).filter(Boolean))] : [];
  if (!urls.length) return res.status(400).json({ error: 'Require at least one partner URL' });
  if (!OPENROUTER_API_KEY || !OPENROUTER_MODEL_ID) return res.status(500).json({ error: 'Server not configured' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const keepAlive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch {} }, 15000);
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };

  const fetchCache = new Map();
  try {
    send('phase', { label: 'Reading vendor + product…' });
    const [vendor, product] = await Promise.all([
      ingestCached({ url: vendor_url, role: 'vendor', supplementalDocs: docs_vendor }),
      ingestCached({ url: product_url, role: 'product' }),
    ]);
    const vP = { name: vendor.target?.name, summary: vendor.summary };
    const pP = { name: product.target?.name, summary: product.summary };

    // Light-scrape every partner (concurrency 5) — homepage signal only, no LLM decompose.
    send('phase', { label: `Scanning ${urls.length} partner sites…` });
    const scraped = await mapPool(urls, 5, async (url) => {
      const f = await lightFetch(url, fetchCache);
      return { url, name: f.title || null, snippet: `${f.title || ''} — ${f.description || ''} ${String(f.text || '').slice(0, 400)}` };
    });

    // PASS 1 — batched 1-10 over everything.
    send('phase', { label: 'Triage pass 1 (1-10)…' });
    const pass1 = [];
    for (const grp of chunk(scraped, 18)) {
      const scored = await recruitIntel.triageBatch({ vendor: vP, product: pP, partners: grp });
      for (const s of scored) { pass1.push(s); send('triage', { pass: 1, ...s }); }
    }
    const winners = pass1.filter(r => r.score >= promote_at);
    const middle  = pass1.filter(r => r.score < promote_at && r.score >= cut_below);
    const cut     = pass1.filter(r => r.score < cut_below);
    send('partition', { pass: 1, promoted: winners.length, middle: middle.length, cut: cut.length });

    // PASS 2 — re-triage the middle with a fuller snippet; promote the upper half.
    if (middle.length) {
      send('phase', { label: `Triage pass 2 on the ${middle.length} middle…` });
      const midInput = middle.map(m => {
        const f = fetchCache.get(m.url) || {};
        return { url: m.url, name: m.name, snippet: `${f.title || ''} — ${f.description || ''} ${String(f.text || '').slice(0, 1500)}` };
      });
      const pass2 = [];
      for (const grp of chunk(midInput, 18)) {
        const scored = await recruitIntel.triageBatch({ vendor: vP, product: pP, partners: grp });
        for (const s of scored) { pass2.push(s); send('triage', { pass: 2, ...s }); }
      }
      pass2.sort((a, b) => b.score - a.score);
      const half = Math.ceil(pass2.length / 2);
      pass2.slice(0, half).forEach(r => winners.push(r));
      send('partition', { pass: 2, promoted_from_middle: half, cut_from_middle: pass2.length - half });
    }

    // Rank + cap the promoted set, then auto-run each through the FULL flow (concurrency 2).
    winners.sort((a, b) => b.score - a.score);
    const toRun = winners.slice(0, max_full_pass);
    send('winners_start', { total: toRun.length, promoted_total: winners.length });

    let done = 0;
    await mapPool(toRun, 2, async (w) => {
      try {
        const r = await runWinnerFullPass({ vendor, product, vendor_url, product_url, partner_url: w.url });
        send('winner', { url: w.url, name: r.name, triage_score: w.score, run_id: r.run_id, fit_score: r.fit_score });
      } catch (err) {
        send('winner', { url: w.url, name: w.name || w.url, triage_score: w.score, error: err.message });
      }
      send('winner_progress', { done: ++done, total: toRun.length });
    });

    send('done', { triaged: urls.length, promoted: winners.length, ran: toRun.length });
    clearInterval(keepAlive); res.end();
  } catch (err) {
    console.error('[recruit-triage]', err.message);
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

    // Singular slots stay (last-write) for back-compat; the maps accumulate one
    // entry per strategy so multi-select outreach kits coexist (up to 5).
    run.chosen_strategy = chosen;
    run.outreach = outreach;
    run.chosen_strategies = { ...(run.chosen_strategies || {}), [chosen.id]: chosen };
    run.outreaches        = { ...(run.outreaches || {}),        [chosen.id]: outreach };
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
