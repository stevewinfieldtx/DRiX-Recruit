// db.js — PostgreSQL persistence for DRiX Recruit.
// Its OWN database (separate DATABASE_URL from DRiX Ready Leads). Stores each
// recruit run (full JSON blob + normalized atoms/strategies), the outreach kit,
// a shared chat↔voice memory timeline, and an ingest cache.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

function getPool() {
  if (!pool && DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => console.error('[db] Pool error:', err.message));
  }
  return pool;
}

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
async function initSchema() {
  const p = getPool();
  if (!p) { console.warn('[db] No DATABASE_URL — running without persistence (in-memory only).'); return; }
  try {
    await p.query(`
      -- Master run record with the full JSON blob for quick retrieval
      CREATE TABLE IF NOT EXISTS recruit_runs (
        id            TEXT PRIMARY KEY,
        email         TEXT,
        vendor_url    TEXT,
        product_url   TEXT,
        partner_url   TEXT,
        fit_score     INTEGER,
        verdict       TEXT,
        gate_passed   BOOLEAN,
        full_result   JSONB,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- Atoms extracted from each entity (vendor / product / partner)
      CREATE TABLE IF NOT EXISTS recruit_atoms (
        id          SERIAL PRIMARY KEY,
        run_id      TEXT REFERENCES recruit_runs(id) ON DELETE CASCADE,
        source_role TEXT NOT NULL,           -- 'vendor' | 'product' | 'partner'
        atom_id     TEXT,
        claim       TEXT,
        type        TEXT,
        dimensions  JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- The five defended recruitment strategies
      CREATE TABLE IF NOT EXISTS recruit_strategies (
        id            SERIAL PRIMARY KEY,
        run_id        TEXT REFERENCES recruit_runs(id) ON DELETE CASCADE,
        strategy_id   TEXT,
        title         TEXT,
        approach      TEXT,
        rationale     TEXT,
        evidence      JSONB,
        target_role   TEXT,
        confidence    INTEGER,
        chosen        BOOLEAN DEFAULT FALSE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- The outreach kit generated for the chosen strategy
      CREATE TABLE IF NOT EXISTS recruit_outreach (
        id            SERIAL PRIMARY KEY,
        run_id        TEXT REFERENCES recruit_runs(id) ON DELETE CASCADE,
        strategy_id   TEXT,
        outreach      JSONB,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- Unified chat ↔ voice memory (one row per turn, both channels).
      -- This is the single source of truth so each agent knows what the other said.
      CREATE TABLE IF NOT EXISTS recruit_memory (
        id          SERIAL PRIMARY KEY,
        run_id      TEXT REFERENCES recruit_runs(id) ON DELETE CASCADE,
        channel     TEXT NOT NULL,           -- 'chat' | 'voice'
        role        TEXT NOT NULL,           -- 'user' | 'assistant'
        content     TEXT,
        source_id   TEXT,                    -- optional dedupe key (e.g. ElevenLabs conversation id + turn index)
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- Ingest cache: persists atom payloads across deploys (30-day TTL)
      CREATE TABLE IF NOT EXISTS ingest_cache (
        url         TEXT NOT NULL,
        role        TEXT NOT NULL,
        payload     JSONB NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (url, role)
      );

      CREATE INDEX IF NOT EXISTS idx_recruit_atoms_run    ON recruit_atoms(run_id);
      CREATE INDEX IF NOT EXISTS idx_recruit_strats_run   ON recruit_strategies(run_id);
      CREATE INDEX IF NOT EXISTS idx_recruit_outreach_run ON recruit_outreach(run_id);
      CREATE INDEX IF NOT EXISTS idx_recruit_memory_run   ON recruit_memory(run_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recruit_memory_src ON recruit_memory(run_id, source_id) WHERE source_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_ingest_cache_ttl     ON ingest_cache(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_recruit_runs_email   ON recruit_runs(email);
      CREATE INDEX IF NOT EXISTS idx_recruit_runs_created ON recruit_runs(created_at DESC);
    `);
    console.log('[db] Schema initialized');
  } catch (err) {
    console.error('[db] Schema init failed:', err.message);
  }
}

// ─── SAVE HELPERS ────────────────────────────────────────────────────────────

// Save after recruit-flow completes (run + atoms + strategies).
async function saveRun(runId, inputs, results) {
  const p = getPool();
  if (!p) return;
  const client = await p.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO recruit_runs (id, email, vendor_url, product_url, partner_url, fit_score, verdict, gate_passed, full_result)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET full_result = EXCLUDED.full_result,
        fit_score = EXCLUDED.fit_score, verdict = EXCLUDED.verdict, gate_passed = EXCLUDED.gate_passed
    `, [
      runId,
      inputs.email || null,
      inputs.vendor_url || null,
      inputs.product_url || null,
      inputs.partner_url || null,
      results.score?.fit_score ?? null,
      results.score?.verdict || null,
      results.gate_passed ?? null,
      JSON.stringify(results),
    ]);

    for (const role of ['vendor', 'product', 'partner']) {
      const entry = results[role];
      if (!entry?.atoms?.length) continue;
      const values = [];
      const params = [];
      let idx = 1;
      for (const atom of entry.atoms) {
        values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
        params.push(
          runId, role,
          atom.atom_id || null,
          atom.claim || null,
          atom.type || null,
          JSON.stringify({ category: atom.category, tags: atom.tags, confidence: atom.confidence })
        );
      }
      if (values.length) {
        await client.query(
          `INSERT INTO recruit_atoms (run_id, source_role, atom_id, claim, type, dimensions) VALUES ${values.join(',')}`,
          params
        );
      }
    }

    const strats = results.strategies?.strategies || [];
    for (const s of strats) {
      await client.query(`
        INSERT INTO recruit_strategies (run_id, strategy_id, title, approach, rationale, evidence, target_role, confidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        runId,
        s.id || null,
        s.title || null,
        s.approach || null,
        s.rationale || null,
        s.evidence ? JSON.stringify(s.evidence) : null,
        s.target_role || null,
        s.confidence ?? null,
      ]);
    }

    await client.query('COMMIT');
    console.log(`[db] Run ${runId} saved (score ${results.score?.fit_score ?? '—'}, ${strats.length} strategies)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[db] saveRun failed:`, err.message);
  } finally {
    client.release();
  }
}

// Save after outreach generation (entry point + questions + drip + phone scripts).
async function saveOutreach(runId, strategyId, strategyTitle, outreach) {
  const p = getPool();
  if (!p) return;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE recruit_strategies SET chosen = TRUE WHERE run_id = $1 AND strategy_id = $2`, [runId, strategyId]);
    await client.query(`
      INSERT INTO recruit_outreach (run_id, strategy_id, outreach) VALUES ($1,$2,$3)
    `, [runId, strategyId, JSON.stringify(outreach)]);
    await client.query(`
      UPDATE recruit_runs SET full_result = full_result || $1::jsonb WHERE id = $2
    `, [JSON.stringify({ outreach, chosen_strategy: { id: strategyId, title: strategyTitle } }), runId]);
    await client.query('COMMIT');
    console.log(`[db] Outreach saved for run ${runId} (strategy ${strategyId})`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[db] saveOutreach failed:`, err.message);
  } finally {
    client.release();
  }
}

// ─── UNIFIED CHAT ↔ VOICE MEMORY ─────────────────────────────────────────────
// Append one turn. `sourceId` (optional) dedupes voice turns ingested via the
// ElevenLabs webhook so replays don't double-insert.
async function appendMemory(runId, channel, role, content, sourceId = null) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO recruit_memory (run_id, channel, role, content, source_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (run_id, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
      [runId, channel, role, content, sourceId]
    );
  } catch (err) {
    // The partial-index ON CONFLICT target isn't universally supported on older PG;
    // fall back to a plain insert if the upsert clause errors.
    try { await p.query(`INSERT INTO recruit_memory (run_id, channel, role, content, source_id) VALUES ($1,$2,$3,$4,$5)`, [runId, channel, role, content, sourceId]); }
    catch (e2) { console.error('[db] appendMemory failed:', e2.message); }
  }
}

// Full ordered timeline for a run (both channels), oldest → newest.
async function getMemory(runId, limit = 200) {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT channel, role, content, created_at FROM recruit_memory
       WHERE run_id = $1 ORDER BY id ASC LIMIT $2`,
      [runId, limit]
    );
    return r.rows;
  } catch (err) { console.error('[db] getMemory failed:', err.message); return []; }
}

// ─── INGEST CACHE (30-day TTL) ───────────────────────────────────────────────
const CACHE_TTL_DAYS = 30;
async function getCachedIngest(url, role) {
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query(
      `SELECT payload FROM ingest_cache
       WHERE url = $1 AND role = $2 AND created_at > NOW() - INTERVAL '${CACHE_TTL_DAYS} days'
       ORDER BY created_at DESC LIMIT 1`,
      [url, role]
    );
    return res.rows.length ? res.rows[0].payload : null;
  } catch (err) { console.error('[db] getCachedIngest error:', err.message); return null; }
}
async function setCachedIngest(url, role, payload) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO ingest_cache (url, role, payload) VALUES ($1,$2,$3)
       ON CONFLICT (url, role) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
      [url, role, JSON.stringify(payload)]
    );
  } catch (err) { console.error('[db] setCachedIngest error:', err.message); }
}

// ─── QUERY HELPERS ───────────────────────────────────────────────────────────
async function getRunFull(runId) {
  const p = getPool();
  if (!p) return null;
  const res = await p.query(`SELECT * FROM recruit_runs WHERE id = $1`, [runId]);
  const row = res.rows[0];
  if (!row) return null;
  const { full_result, ...rest } = row;
  const fr = typeof full_result === 'string' ? (JSON.parse(full_result) || {}) : (full_result || {});
  return { ...rest, ...fr, run_id: row.id, created_at: row.created_at };
}

function isConfigured() { return Boolean(DATABASE_URL); }

module.exports = {
  initSchema,
  saveRun,
  saveOutreach,
  appendMemory,
  getMemory,
  getCachedIngest,
  setCachedIngest,
  getRunFull,
  isConfigured,
  getPool,
};
