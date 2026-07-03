// tde.js — DRiX Recruit's client for the shared TDE engine.
//
// Recruit no longer decomposes locally. TDE decomposes each URL through its
// native recruit lens, stores the atoms + a url_registry entry, and serves cache
// hits. This module wraps that flow:
//   registry check → HIT: fetch + adapt atoms  |  MISS: create collection, ingest
//   URL (+ uploaded docs), poll, fetch, adapt.
//
// It returns the SAME shape brain.recruitIntel.ingestPartner used to return
// ({ target, summary, atoms, atom_count, source_url }) so scoreFit /
// generateRecruitStrategies / the coach are unchanged. server.js falls back to
// the brain ingest on any throw, so a TDE outage never breaks a run.

const BASE = (process.env.TDE_BASE_URL || 'https://targeteddecomposition-production.up.railway.app').replace(/\/+$/, '');
const KEY  = process.env.TDE_API_KEY || '';
const LENS = 'recruit';
const POLL_INTERVAL_MS = 5000;
// The recruit lens is one big single-shot LLM call per source (~2-3 min), so give
// a cold, multi-source ingest generous headroom before falling back to the brain.
const POLL_MAX_MS = parseInt(process.env.TDE_POLL_MAX_MS || '360000', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`TDE ${method} ${pathname} → ${res.status}: ${String(text).slice(0, 200)}`);
  return data;
}

// Deterministic collection id from a URL (registry dedups by normalized_url anyway).
function slug(url) {
  return 'recruit-' + String(url).toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// TDE atom → the atom shape scoreFit already consumes.
// TDE: { id, text, atom_type, dimensions:{ recruit_category, signal_type,
//        confidence_tier, entity_role, _evidence, _tags } }
function adaptAtom(a) {
  const d = a.dimensions || {};
  return {
    atom_id: a.id,
    type: d.signal_type || a.atom_type || 'general',
    category: d.recruit_category || '',
    claim: a.text,
    evidence: d._evidence || '',
    tags: Array.isArray(d._tags) ? d._tags : [],
    confidence: d.confidence_tier || 'medium',
  };
}

async function fetchAdapted(collectionId, url, role) {
  const atomsRaw = await api('GET', `/atoms/${encodeURIComponent(collectionId)}`);
  const atoms = (Array.isArray(atomsRaw) ? atomsRaw : []).map(adaptAtom);

  // Entity summary/name were stored as recruit_meta intelligence at ingest.
  let summary = '';
  let name = null;
  try {
    const intel = await api('GET', `/intelligence/${encodeURIComponent(collectionId)}`);
    const rec = Array.isArray(intel)
      ? intel.find((x) => x.type === 'recruit_meta')
      : (intel && intel.type === 'recruit_meta' ? intel : null);
    const meta = rec ? rec.data : (intel && intel.data) || null;
    if (meta) { summary = meta.summary || ''; name = (meta.target && meta.target.name) || null; }
  } catch { /* summary is best-effort */ }

  return {
    target: { name: name || url, url, role },
    summary,
    atoms,
    atom_count: atoms.length,
    source_url: url,
  };
}

async function pollReady(collectionId, expectedSources) {
  const start = Date.now();
  while (Date.now() - start < POLL_MAX_MS) {
    await sleep(POLL_INTERVAL_MS);
    const sources = await api('GET', `/sources/${encodeURIComponent(collectionId)}`).catch(() => []);
    const arr = Array.isArray(sources) ? sources : [];
    const done = arr.length >= expectedSources && arr.every((s) => s.status === 'ready' || s.status === 'error');
    if (done) {
      if (arr.some((s) => s.status === 'ready')) return true;
      throw new Error('all TDE sources errored');
    }
  }
  throw new Error('TDE ingest timed out');
}

/**
 * Decompose one entity (vendor|product|partner) via TDE, with registry cache.
 * @returns {Promise<{target,summary,atoms,atom_count,source_url,_cache_hit}>}
 */
async function ingestEntity({ url, role, supplementalDocs = null, refresh = false } = {}) {
  if (!url) throw new Error('tde.ingestEntity: url required');

  // 1) Registry — already decomposed and still fresh?
  if (!refresh) {
    const reg = await api('GET', `/registry?url=${encodeURIComponent(url)}&lens=${LENS}`).catch(() => null);
    if (reg && reg.found && reg.fresh && reg.collection_id) {
      const out = await fetchAdapted(reg.collection_id, url, role);
      if (out.atoms.length) { out._cache_hit = true; return out; }
    }
  }

  // 2) Miss — create collection, ingest URL (+ uploaded docs), poll, fetch.
  const colId = slug(url);
  await api('POST', '/collections', { id: colId, name: url, templateId: 'recruit', entity_role: role });
  await api('POST', '/ingest', { collectionId: colId, type: 'web', input: url });

  let expected = 1;
  if (Array.isArray(supplementalDocs)) {
    for (const doc of supplementalDocs) {
      if (doc && doc.text && doc.text.length > 100) {
        await api('POST', '/ingest', { collectionId: colId, type: 'text', input: doc.text, opts: { title: doc.filename || 'document' } });
        expected++;
      }
    }
  }

  await pollReady(colId, expected);
  const out = await fetchAdapted(colId, url, role);
  out._cache_hit = false;
  return out;
}

module.exports = { ingestEntity, slug, adaptAtom, BASE };
