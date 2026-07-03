// DRiX Recruit — front-end controller (vanilla, no build step).
const $ = (id) => document.getElementById(id);
const state = { runId: null, docs: { vendor: [], partner: [] }, lastInputs: null, chatHistory: [] };

// ─── AUTH BADGE ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (r.status === 401) { location.href = '/login.html'; return; }
    const me = await r.json();
    $('runsBadge').textContent = me.unlimited ? 'Unlimited' : `${me.remaining ?? 0} runs left`;
    $('logoutBtn').hidden = false;
  } catch { /* leave badge blank */ }
}
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

// ─── DOC UPLOADS ─────────────────────────────────────────────────────────────
document.querySelectorAll('.uploads').forEach((box) => {
  const bucket = box.dataset.bucket;
  const btn = box.querySelector('.upload-btn');
  const input = box.querySelector('input[type=file]');
  const list = box.querySelector('.doclist');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    for (const file of input.files) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="spin"></span> ${file.name}`;
      list.appendChild(li);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch('/api/upload-doc', { method: 'POST', body: fd, credentials: 'include' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'upload failed');
        state.docs[bucket].push({ filename: d.filename, text: d.text });
        li.innerHTML = `${d.filename} · ${(d.chars / 1000).toFixed(1)}k chars`;
      } catch (e) {
        li.className = 'err';
        li.textContent = `${file.name} — ${e.message}`;
      }
    }
    input.value = '';
  });
});

// ─── RUN THE FLOW (SSE over fetch) ───────────────────────────────────────────
$('runBtn').addEventListener('click', () => runFlow(false));

async function runFlow(override) {
  const vendor_url = $('vendorUrl').value.trim();
  const product_url = $('productUrl').value.trim();
  const partner_url = $('partnerUrl').value.trim();
  if (!vendor_url || !product_url || !partner_url) { alert('Enter all three URLs.'); return; }

  state.lastInputs = { vendor_url, product_url, partner_url };
  // Reset downstream cards
  ['scoreCard', 'painsCard', 'atomsCard', 'stratCard', 'outreachCard', 'coachCard'].forEach((id) => { $(id).hidden = true; $(id).innerHTML = id === 'stratCard' ? $(id).innerHTML : ''; });
  $('toolsCard').hidden = true;
  if ($('signalsResult')) $('signalsResult').innerHTML = '';
  if ($('threadInput')) $('threadInput').value = '';
  $('stratList') && ($('stratList').innerHTML = '');
  $('progressCard').hidden = false;
  $('logList').innerHTML = '';
  $('phaseLabel').innerHTML = '<span class="spin"></span> Starting…';
  $('runBtn').disabled = true;

  const body = {
    vendor_url, product_url, partner_url,
    docs_vendor: state.docs.vendor,
    docs_partner: state.docs.partner,
    override: !!override,
  };

  try {
    const res = await fetch('/api/recruit-flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    await readSSE(res.body, handleEvent);
  } catch (e) {
    $('phaseLabel').innerHTML = `<span style="color:var(--bad)">Error: ${escapeHtml(e.message)}</span>`;
  } finally {
    $('runBtn').disabled = false;
  }
}

async function readSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop();
    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      let event = 'message', data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) { try { onEvent(event, JSON.parse(data)); } catch { /* keepalive/comment */ } }
    }
  }
}

function handleEvent(event, data) {
  switch (event) {
    case 'phase':
      $('phaseLabel').innerHTML = `<span class="spin"></span> ${escapeHtml(data.label || data.phase)}`;
      break;
    case 'atoms': {
      const li = document.createElement('li');
      li.textContent = `${cap(data.role)}: ${data.name || '—'} — ${data.count} facts extracted`;
      $('logList').appendChild(li);
      renderEntityAtoms(data);
      break;
    }
    case 'score':
      renderScore(data);
      break;
    case 'gate':
      renderGate(data);
      break;
    case 'strategies':
      renderStrategies(data);
      break;
    case 'pains':
      renderPains(data);
      break;
    case 'done':
      state.runId = data.run_id;
      $('phaseLabel').innerHTML = `Done · fit ${data.fit_score}/100`;
      $('toolsCard').hidden = false;
      wireTools();
      break;
    case 'error':
      $('phaseLabel').innerHTML = `<span style="color:var(--bad)">Error: ${escapeHtml(data.error)}</span>`;
      break;
  }
}

// ─── RENDER: SCORE ───────────────────────────────────────────────────────────
function scoreColor(n) { return n >= 75 ? 'var(--good)' : n >= 60 ? 'var(--brand)' : n >= 40 ? 'var(--warn)' : 'var(--bad)'; }

function renderScore(s) {
  const card = $('scoreCard');
  card.hidden = false;
  const subs = (s.subscores || []).map((ss) => `
    <div class="subscore">
      <div class="subscore-head"><span>${escapeHtml(prettyName(ss.name))}</span><span>${ss.score}/100 · w ${ss.weight}</span></div>
      <div class="bar"><i style="width:${Math.max(0, Math.min(100, ss.score))}%"></i></div>
      <div class="rationale">${escapeHtml(ss.rationale || '')}</div>
      ${(ss.evidence || []).map((e) => `<div class="evi">${escapeHtml(e.source || '')}: ${escapeHtml(e.claim || '')}</div>`).join('')}
    </div>`).join('');
  card.innerHTML = `
    <div class="scorehead">
      <div class="scorering" style="border:6px solid ${scoreColor(s.fit_score)}; color:${scoreColor(s.fit_score)}">${s.fit_score}</div>
      <div><div class="verdict">${escapeHtml(s.verdict || '')}</div><div class="sub" style="margin:6px 0 0">${escapeHtml(s.summary || '')}</div></div>
    </div>
    ${s.readiness_score != null ? `
    <div class="subscore">
      <div class="subscore-head"><span>Readiness (timing)</span><span>${s.readiness_score}/100</span></div>
      <div class="bar"><i style="width:${Math.max(0, Math.min(100, s.readiness_score))}%"></i></div>
      ${(s.readiness && s.readiness.signals && s.readiness.signals.length) ? `<div class="rationale">Signals: ${escapeHtml(s.readiness.signals.join('; '))}</div>` : ''}
    </div>` : ''}
    ${(s.channel_conflict && s.channel_conflict.direct_competitor) ? `<div class="rationale" style="color:var(--bad)">⚠ Channel conflict: direct competitor${s.channel_conflict.competitor_named ? ` (${escapeHtml(s.channel_conflict.competitor_named)})` : ''} — fit adjusted ${s.fit_raw}→${s.fit_score}.</div>` : ''}
    ${subs}
    <div class="flags">
      <div class="col flag-good"><h4>Green flags</h4><ul>${(s.green_flags || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('') || '<li>—</li>'}</ul></div>
      <div class="col flag-bad"><h4>Red flags</h4><ul>${(s.red_flags || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('') || '<li>—</li>'}</ul></div>
    </div>`;
}

// ─── RENDER: DISCOVERED ATOMS (tagged) ───────────────────────────────────────
function prettyCat(s) { return String(s || 'other').replace(/_/g, ' '); }

function renderEntityAtoms(data) {
  if (!data.atoms || !data.atoms.length) return;
  const card = $('atomsCard');
  if (card.hidden || !$('atomsBody')) {
    card.hidden = false;
    card.innerHTML = `
      <h2>Discovered intelligence</h2>
      <p class="sub">Every fact DRiX pulled from the three entities, tagged by the recruit lens. The score, strategies, and outreach are all built on these atoms.</p>
      <div id="atomsBody"></div>`;
  }
  const groups = {};
  for (const a of data.atoms) { const c = a.category || 'other'; (groups[c] = groups[c] || []).push(a); }
  const roleLabel = ({ vendor: 'VENDOR', product: 'PRODUCT', partner: 'PARTNER' })[data.role] || cap(data.role);
  const det = document.createElement('details');
  det.className = 'entity';
  if (data.role === 'partner') det.open = true;
  det.innerHTML = `
    <summary><span class="erole">${roleLabel}</span> <b>${escapeHtml(data.name || '—')}</b> <span class="ecount">${data.atoms.length} atoms</span></summary>
    ${data.summary ? `<p class="esum">${escapeHtml(data.summary)}</p>` : ''}
    ${Object.entries(groups).map(([cat, atoms]) => `
      <div class="catgroup">
        <div class="catlabel">${escapeHtml(prettyCat(cat))} <span class="ccount">${atoms.length}</span></div>
        ${atoms.map((a) => `
          <div class="atom">
            <div class="atom-claim">${escapeHtml(a.claim || '')}</div>
            <div class="atom-tags">
              <span class="chip type">${escapeHtml(a.type || 'atom')}</span>
              ${a.confidence ? `<span class="chip conf ${escapeHtml(String(a.confidence).toLowerCase())}">${escapeHtml(a.confidence)}</span>` : ''}
              ${(a.tags || []).slice(0, 4).map((t) => `<span class="chip tag">${escapeHtml(t)}</span>`).join('')}
            </div>
            ${a.evidence ? `<div class="atom-evi">${escapeHtml(a.evidence)}</div>` : ''}
          </div>`).join('')}
      </div>`).join('')}`;
  $('atomsBody').appendChild(det);
}

// ─── RENDER: GATE ────────────────────────────────────────────────────────────
function renderGate(g) {
  if (g.passed) return; // score passed (or overridden) → strategies stream next
  const card = $('scoreCard');
  const box = document.createElement('div');
  box.className = 'gatebox';
  box.innerHTML = `
    <p><b>Below the ${g.threshold} fit threshold (${g.fit_score}/100).</b> ${escapeHtml(g.verdict || '')}
    We stopped here — this partner looks like a poor fit for this product. You can override and generate strategies anyway.</p>
    <button class="secondary" id="overrideBtn">Generate strategies anyway →</button>`;
  card.appendChild(box);
  $('overrideBtn').addEventListener('click', () => runFlow(true));
}

// ─── RENDER: STRATEGIES ──────────────────────────────────────────────────────
function renderStrategies(data) {
  $('stratCard').hidden = false;
  const list = $('stratList');
  list.innerHTML = '';
  const top = data.top_pick_id;
  for (const s of (data.strategies || [])) {
    const el = document.createElement('div');
    el.className = 'strat' + (s.id === top ? ' top' : '');
    el.innerHTML = `
      <h3>${escapeHtml(s.title || '')} ${s.id === top ? '<span class="pill">Top pick</span>' : `<span class="pill">conf ${s.confidence}</span>`}</h3>
      <div class="approach">${escapeHtml(s.approach || '')}</div>
      <div class="why"><b>Why this partner:</b> ${escapeHtml(s.rationale || '')}</div>
      <ul class="evilist">${(s.evidence || []).map((e) => `<li>${escapeHtml(e.source || '')}: ${escapeHtml(e.claim || '')}</li>`).join('')}</ul>
      <div class="meta">Aim at: <b>${escapeHtml(s.target_role || '—')}</b> · Confidence ${s.confidence}</div>
      <button class="primary" data-sid="${s.id}">Select this strategy →</button>`;
    el.querySelector('button').addEventListener('click', () => selectStrategy(s.id));
    list.appendChild(el);
  }
}

// ─── RENDER: PAINS ───────────────────────────────────────────────────────────
function renderPains(data) {
  const pains = (data && data.pains) || [];
  if (!pains.length) return;
  const card = $('painsCard');
  card.hidden = false;
  const urg = (u) => ({ high: 'urg-bad', medium: 'urg-warn', low: 'urg-muted' }[String(u || '').toLowerCase()] || 'urg-muted');
  card.innerHTML = `
    <h2>Partner pains</h2>
    <p class="sub">Why it's in this partner's own interest to take the line on — the recruitment angle.</p>
    <div class="pain-grid">
      ${pains.map((p) => `
        <div class="pain">
          <div class="pain-title">${escapeHtml(p.title || '')}</div>
          <div class="pain-why">${escapeHtml(p.why || '')}</div>
          ${p.evidence ? `<div class="atom-evi">${escapeHtml(p.evidence)}</div>` : ''}
          <div class="pain-owner">${escapeHtml(p.owner_role || '')}</div>
          <div class="pain-forces">
            <span class="chip ${urg(p.urgency)}">urgency: ${escapeHtml(p.urgency || '')}</span>
            <span class="chip">pull: ${escapeHtml(p.pull || '')}</span>
            <span class="chip">inertia: ${escapeHtml(p.inertia || '')}</span>
          </div>
        </div>`).join('')}
    </div>`;
}

// ─── SIGNALS + REPORT TOOLS ──────────────────────────────────────────────────
function wireTools() {
  const ab = $('analyzeBtn');
  if (ab && !ab.dataset.wired) { ab.dataset.wired = '1'; ab.addEventListener('click', analyzeThread); }
  const rb = $('reportBtn');
  if (rb && !rb.dataset.wired) { rb.dataset.wired = '1'; rb.addEventListener('click', () => { if (state.runId) window.open(`/api/recruit-report/${state.runId}`, '_blank'); }); }
}
async function analyzeThread() {
  const thread = $('threadInput').value.trim();
  if (!thread || !state.runId) { alert('Paste the reply thread first.'); return; }
  const btn = $('analyzeBtn'); btn.disabled = true; btn.textContent = 'Analyzing…';
  $('signalsResult').innerHTML = '<div class="phase"><span class="spin"></span> Reading the thread…</div>';
  try {
    const r = await fetch('/api/recruit-signals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ run_id: state.runId, thread }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    renderSignals(d.signals);
  } catch (e) { $('signalsResult').innerHTML = `<div class="err-banner">${escapeHtml(e.message)}</div>`; }
  finally { btn.disabled = false; btn.textContent = 'Analyze thread'; }
}
function renderSignals(sg) {
  sg = sg || {};
  const col = scoreColor(sg.health_score || 0);
  $('signalsResult').innerHTML = `
    <div class="scorehead" style="margin-top:14px">
      <div class="scorering" style="width:64px;height:64px;font-size:20px;border:5px solid ${col};color:${col}">${sg.health_score || 0}</div>
      <div class="verdict" style="font-size:15px">${escapeHtml(sg.verdict || '')}</div>
    </div>
    ${(sg.positive_signals || []).length ? `<div class="kv"><b>Positive signals</b><ul>${sg.positive_signals.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}
    ${(sg.risks || []).length ? `<div class="kv"><b>Risks</b><ul>${sg.risks.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}
    ${(sg.objections || []).length ? `<div class="kv"><b>Objections</b>${sg.objections.map((o) => `<div class="evi">"${escapeHtml(o.objection || '')}" → ${escapeHtml(o.response || '')}</div>`).join('')}</div>` : ''}
    <div class="kv" style="margin-top:8px"><b>Next step:</b> ${escapeHtml(sg.next_step || '')}</div>`;
}

// ─── SELECT STRATEGY → OUTREACH ──────────────────────────────────────────────
async function selectStrategy(strategy_id) {
  if (!state.runId) { alert('Run not ready yet.'); return; }
  const card = $('outreachCard');
  card.hidden = false;
  card.innerHTML = '<div class="phase"><span class="spin"></span> Building the outreach kit…</div>';
  try {
    const r = await fetch('/api/recruit-outreach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ run_id: state.runId, strategy_id }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    renderOutreach(d.outreach, d.chosen_strategy);
    $('coachCard').hidden = false;
  } catch (e) {
    card.innerHTML = `<div class="err-banner">Outreach failed: ${escapeHtml(e.message)}</div>`;
  }
}

function renderOutreach(o, chosen) {
  const ep = o.entry_point || {};
  const q = o.questions || [];
  const emails = o.email_drip || [];
  const calls = o.phone_scripts || [];
  $('outreachCard').innerHTML = `
    <h2>Outreach kit</h2>
    <p class="sub">Strategy: <b>${escapeHtml(chosen?.title || '')}</b></p>

    <div class="blk">
      <h3>Entry point</h3>
      <div class="kv"><b>How to approach:</b> ${escapeHtml(ep.how_to_approach || '')}</div>
      <div class="kv"><b>Who to approach:</b> ${escapeHtml(ep.who_to_approach?.role || '')}${ep.who_to_approach?.name ? ' — ' + escapeHtml(ep.who_to_approach.name) : ''} <span class="rationale">(${escapeHtml(ep.who_to_approach?.why || '')})</span></div>
      <div class="kv"><b>Tone:</b> ${escapeHtml(ep.tone || '')}</div>
    </div>

    <div class="blk">
      <h3>Discovery questions (3 levels)</h3>
      ${q.map((x) => `
        <div class="qcard">
          <div class="lvl">Level ${x.level} · ${escapeHtml(x.label || '')}</div>
          <div class="q">${escapeHtml(x.question || '')}</div>
          <div class="kv"><b>Why:</b> ${escapeHtml(x.purpose || '')}</div>
          <div class="kv"><b>Expected:</b> ${escapeHtml(x.expected_response || '')}</div>
          <div class="kv"><b>If they push back:</b> ${escapeHtml(x.contrary_response || '')}</div>
          <div class="kv"><b>Pivot:</b> ${escapeHtml(x.pivot || '')}</div>
        </div>`).join('')}
    </div>

    <div class="blk">
      <h3>5-email drip <span class="sub" style="display:inline">— goal: earn the meeting</span></h3>
      ${emails.map((e) => `
        <div class="email">
          <button class="copybtn" data-copy="${encodeURIComponent((e.subject || '') + '\n\n' + (e.body || ''))}">Copy</button>
          <span class="day">${escapeHtml(e.send_day || ('Email ' + e.step))}</span>
          <div class="subject">${escapeHtml(e.subject || '')}</div>
          <div class="body">${escapeHtml(e.body || '')}</div>
          <div class="rationale" style="margin-top:6px">Goal: ${escapeHtml(e.goal || '')}</div>
        </div>`).join('')}
    </div>

    <div class="blk">
      <h3>Phone scripts</h3>
      ${calls.map((c) => `
        <div class="call">
          <div class="q">${escapeHtml(c.label || 'Call')}</div>
          <div class="kv"><b>Opener:</b> ${escapeHtml(c.opener || '')}</div>
          <div class="kv"><b>Talking points:</b><ul>${(c.talking_points || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>
          <div class="kv"><b>Objections:</b>${(c.objection_handling || []).map((h) => `<div class="evi">"${escapeHtml(h.objection || '')}" → ${escapeHtml(h.response || '')}</div>`).join('')}</div>
          <div class="kv"><b>Voicemail:</b> ${escapeHtml(c.voicemail || '')}</div>
        </div>`).join('')}
    </div>`;

  $('outreachCard').querySelectorAll('.copybtn').forEach((b) => {
    b.addEventListener('click', () => { navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy)); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); });
  });
}

// ─── CHAT COACH ──────────────────────────────────────────────────────────────
$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const msg = input.value.trim();
  if (!msg || !state.runId) return;
  input.value = '';
  addMsg('user', msg);
  const thinking = addMsg('bot', '…');
  try {
    const r = await fetch('/api/recruit-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ run_id: state.runId, message: msg }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    thinking.textContent = d.reply;
  } catch (err) {
    thinking.textContent = `Error: ${err.message}`;
  }
});

function addMsg(who, text) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  $('chatLog').appendChild(el);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return el;
}

// ─── VOICE COACH ─────────────────────────────────────────────────────────────
$('voiceBtn').addEventListener('click', async () => {
  if (!state.runId) return;
  const btn = $('voiceBtn');
  btn.disabled = true; btn.textContent = 'Provisioning…';
  try {
    const r = await fetch('/api/recruit-voice/provision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ run_id: state.runId }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    mountVoiceWidget(d.agent_id);
    btn.textContent = '🎙 Voice coach ready ↓';
  } catch (e) {
    btn.disabled = false; btn.textContent = '🎙 Start voice coach';
    alert('Voice: ' + e.message);
  }
});

function mountVoiceWidget(agentId) {
  const mount = $('voiceMount');
  mount.innerHTML = '';
  if (!document.querySelector('script[data-convai]')) {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@elevenlabs/convai-widget-embed';
    s.async = true; s.type = 'text/javascript'; s.setAttribute('data-convai', '1');
    document.body.appendChild(s);
  }
  const el = document.createElement('elevenlabs-convai');
  el.setAttribute('agent-id', agentId);
  mount.appendChild(el);
}

// ─── UTIL ────────────────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }
function prettyName(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

boot();
