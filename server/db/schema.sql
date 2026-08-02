-- 0. Users (lightweight JWT session tracking)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token VARCHAR(500) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active TIMESTAMPTZ DEFAULT NOW()
);

-- 1. Analysis Sessions (top-level audit runs)
CREATE TABLE IF NOT EXISTS analysis_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(30) DEFAULT 'processing',
  readiness_score INTEGER DEFAULT 100,
  total_mismatches INTEGER DEFAULT 0,
  total_inconsistencies INTEGER DEFAULT 0,
  total_missing INTEGER DEFAULT 0,
  total_unusual INTEGER DEFAULT 0,
  summary_report JSONB,        -- Full structured report JSON
  follow_up_questions JSONB,   -- Array of generated investor questions
  reasoning_chain TEXT,        -- DeepSeek-R1 raw chain-of-thought (audit trail)
  model_used VARCHAR(50)       -- Which AI model produced the analysis
);

-- 2. Documents (individual uploaded files per session)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES analysis_sessions(id) ON DELETE CASCADE,
  original_filename VARCHAR(255) NOT NULL,
  stored_filename VARCHAR(255) NOT NULL,
  file_type VARCHAR(10) NOT NULL,  -- 'pdf', 'xlsx', 'csv', 'pptx'
  document_category VARCHAR(50) NOT NULL,
  file_size_bytes INTEGER,
  parsed_content TEXT,       -- Raw markdown/text from parsing
  extracted_metrics JSONB,   -- Structured JSON metrics from Gemini
  page_count INTEGER,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Extracted Metrics (normalized, queryable metrics)
CREATE TABLE IF NOT EXISTS extracted_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES analysis_sessions(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  metric_name VARCHAR(100) NOT NULL,
  normalized_name VARCHAR(100) NOT NULL,
  metric_category VARCHAR(50),
  metric_value NUMERIC,
  metric_unit VARCHAR(20),
  period VARCHAR(50),
  normalized_period VARCHAR(20),
  source_page INTEGER,
  source_row_text TEXT,
  source_context TEXT,
  confidence FLOAT DEFAULT 1.0,
  metric_currency VARCHAR(10),    -- Fix P6: 'INR', 'USD', 'EUR', etc.
  period_type VARCHAR(20)         -- Fix P7: 'historical', 'current', 'projected', 'unknown'
);

-- 4. Discrepancies (cross-document findings)
CREATE TABLE IF NOT EXISTS discrepancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES analysis_sessions(id) ON DELETE CASCADE,
  ref_code VARCHAR(50),
  classification VARCHAR(30) NOT NULL,
  severity_weight INTEGER,  -- 15 (mismatch), 10 (missing), 8 (unusual), 5 (inconsistency)
  metric_name VARCHAR(100),
  description TEXT NOT NULL,
  source_a_doc_id UUID REFERENCES documents(id),
  source_a_filename VARCHAR(255),
  source_a_page INTEGER,
  source_a_value VARCHAR(100),
  source_a_context TEXT,
  source_b_doc_id UUID REFERENCES documents(id),
  source_b_filename VARCHAR(255),
  source_b_page INTEGER,
  source_b_value VARCHAR(100),
  source_b_context TEXT,
  variance_pct FLOAT,
  follow_up_question TEXT,
  details JSONB
);

-- Indexes. IF NOT EXISTS has been supported since PostgreSQL 9.5, and without it re-running this
-- file against an existing database aborts on the first index that already exists.
CREATE INDEX IF NOT EXISTS idx_sessions_user ON analysis_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_docs_session ON documents(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_session ON extracted_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_normalized ON extracted_metrics(normalized_name, normalized_period);
CREATE INDEX IF NOT EXISTS idx_discrepancies_session ON discrepancies(session_id);
CREATE INDEX IF NOT EXISTS idx_discrepancies_class ON discrepancies(classification);
