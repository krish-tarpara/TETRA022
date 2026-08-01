-- Migration 002: deterministic engine tables.
--
-- Adds `observations` and `findings` alongside the existing `extracted_metrics` and
-- `discrepancies` rather than replacing them. The old tables are left in place deliberately:
-- sessions already in the database were produced by the old pipeline, and dropping their data
-- would break the history screen for anything analysed before this migration.
--
-- Idempotent throughout, so it is safe to run more than once.

-- ── Observations: what a document says, with a mandatory citation ───────────────────────────
--
-- Replaces extracted_metrics for new sessions. Two structural differences matter:
--
--   source_quote is NOT NULL. The engine discards any number it cannot quote, so an uncited
--   observation must be impossible to store as well - otherwise a future code path could
--   reintroduce exactly the hallucination risk the rule exists to prevent.
--
--   confidence is split into four components rather than one score, because severity needs to
--   know WHY confidence is low. A number misread off a blurry slide and a number with an
--   ambiguous date are both "0.7", and they need different handling.
CREATE TABLE IF NOT EXISTS observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES analysis_sessions(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,

  metric_key VARCHAR(50) NOT NULL,
  raw_label TEXT,

  value_raw TEXT,
  value_base NUMERIC,
  currency VARCHAR(10),
  unit VARCHAR(20),

  period_raw TEXT,
  period_key VARCHAR(30),
  period_granularity VARCHAR(20),
  period_type VARCHAR(20),
  basis VARCHAR(20),
  basis_class VARCHAR(10),

  -- Who the number is about, for metrics that repeat per entity (one row per shareholder).
  subject VARCHAR(200),

  source_page INTEGER,
  source_cell VARCHAR(30),
  source_quote TEXT NOT NULL,

  conf_value REAL,
  conf_label REAL,
  conf_period REAL,
  conf_parse REAL,

  node_key VARCHAR(300),
  diagnostics JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_node ON observations(session_id, node_key);
CREATE INDEX IF NOT EXISTS idx_obs_document ON observations(document_id);
CREATE INDEX IF NOT EXISTS idx_obs_metric ON observations(session_id, metric_key, period_key);

-- ── Findings: what the engine concluded ─────────────────────────────────────────────────────
--
-- Replaces discrepancies. The important change is `evidence`, a JSONB array, rather than the old
-- fixed source_a/source_b columns. A finding can cite one document (a self-contradicting deck)
-- or fifteen (twelve months against a quarterly and an annual total), and two columns could
-- represent neither.
--
-- `computation` and `factors` are stored so a finding can be explained without re-running the
-- engine, and `rulepack_version` is stored so a score can always be traced to the exact
-- configuration that produced it.
CREATE TABLE IF NOT EXISTS findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES analysis_sessions(id) ON DELETE CASCADE,

  ref_code VARCHAR(40),
  rule_id VARCHAR(80) NOT NULL,
  rule_class VARCHAR(10) NOT NULL,
  rulepack_version VARCHAR(20) NOT NULL,

  classification VARCHAR(40) NOT NULL,
  classification_reason VARCHAR(60),
  severity_score NUMERIC NOT NULL,
  severity_band VARCHAR(12),
  pillar VARCHAR(40),

  metric_key VARCHAR(50),
  metric_label VARCHAR(100),
  period_key VARCHAR(30),
  node_key VARCHAR(300),

  computation JSONB NOT NULL,
  factors JSONB NOT NULL,
  evidence JSONB NOT NULL,
  details JSONB,

  narrative TEXT,
  narrative_source VARCHAR(20),
  follow_up_question TEXT,
  adjudication JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_findings_session ON findings(session_id);
CREATE INDEX IF NOT EXISTS idx_findings_class ON findings(session_id, classification);
CREATE INDEX IF NOT EXISTS idx_findings_pillar ON findings(session_id, pillar);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(session_id, severity_score DESC);

-- ── Session columns for the new scoring model ───────────────────────────────────────────────
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS pillar_scores JSONB;
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS coverage JSONB;
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS score_breakdown JSONB;
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS rulepack_version VARCHAR(20);
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS executive_summary TEXT;

-- User-supplied exchange rates. Stored because any finding that used one is only valid under
-- that assumption, and a report has to be reproducible including its assumptions.
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS fx_rates JSONB;

-- The AI second opinion, kept strictly separate from anything that feeds the score.
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS ai_notes JSONB;

-- Adjudication audit trail: what the user overrode, and why.
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS adjudications JSONB;

-- Which pipeline produced this session. Lets the API serve old and new sessions from the same
-- endpoint without guessing at the shape of what it finds.
ALTER TABLE analysis_sessions ADD COLUMN IF NOT EXISTS engine_version VARCHAR(20) DEFAULT 'legacy';

-- Extraction quality per document: how many numbers were read, and how many were discarded for
-- lacking a citation. Surfaced as a warning rather than hidden, because silent extraction
-- failure looks identical to a clean document.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_stats JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS company_name VARCHAR(200);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parse_error TEXT;
