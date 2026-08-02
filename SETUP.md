# FinVerify — Setup & Run

Everything needed to get this running on a fresh machine.

---

## 1. What you need installed

| Requirement | Notes |
|---|---|
| **Node.js 18 or newer** | Tested on Node 22. `node --version` to check. |
| **A PostgreSQL database** | Already provisioned on Neon (cloud). Nothing to install locally. |
| Nothing else | No `psql`, no Docker, no Python. Migrations run through Node. |

---

## 2. API keys

Three keys. Two are **required**, one is optional.

| Key | Required? | What breaks without it | Where to get it |
|---|---|---|---|
| `GROQ_API_KEY` | **Yes** | Reading figures out of documents. Uploads fail. | [console.groq.com/keys](https://console.groq.com/keys) — free |
| `LLAMA_CLOUD_API_KEY` | **Yes, for PDF/PPTX** | PDF and PowerPoint parsing. Excel and CSV still work. | [cloud.llamaindex.ai](https://cloud.llamaindex.ai) — 10,000 free credits/month |
| `GOOGLE_API_KEY` | No | Nothing. Not currently used — extraction runs on Groq. | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `DATABASE_URL` | **Yes** | Everything. | Already set (Neon). |
| `JWT_SECRET` | **Yes** | Sessions won't survive a server restart. Any random 32+ char string. | Make one up. |

**Free tier limits worth knowing:**
- Groq: 30 requests/minute. One document = one request per ~45,000 characters. A 4-document analysis is about 4–6 requests, so you'd need ~6 simultaneous users to hit the limit.
- LlamaParse: 10,000 pages/month, ~1 credit per page. Budget roughly 200 pages for testing.

---

## 3. The `.env` file

**Your `.env` currently lives in the wrong place** — it's at `D:\Tetrathon\.env`, one level above the project. The code now checks the parent directory as a fallback, so it works, but the correct location is inside the project folder:

```
D:\Tetrathon\Tetrathon\.env
```

Contents:

```env
# AI
GROQ_API_KEY=gsk_...
LLAMA_CLOUD_API_KEY=llx-...
GOOGLE_API_KEY=              # optional, unused

# Database
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require

# Auth — any random string, 32+ characters
JWT_SECRET=change_this_to_something_random_and_long

# Server
PORT=5000
NODE_ENV=development
```

`.env` is git-ignored. Never commit it.

---

## 4. Run it

```bash
npm install
```

```bash
npm run migrate
```

```bash
npm run dev
```

Then open **http://localhost:5000**

### What each command does

**`npm run migrate`** — creates the database tables. Safe to run repeatedly; it tracks what it has already applied. Run it once now, and again any time you pull changes that add a migration.

Expected output:

```
Connected to neondb
  skip    schema.sql (already applied)
  skip    002_engine.sql (already applied)
All migrations applied. Tables verified.
```

**`npm run dev`** — starts the server. Expected output:

```
Database connected: neondb
FinVerify listening on http://localhost:5000  (rule pack v1.0.0)
```

If a key is missing you'll get an explicit warning at startup rather than a confusing failure later.

---

## 5. Check it's working

```bash
curl http://localhost:5000/health
```

Healthy response:

```json
{
  "status": "ok",
  "database": "neondb",
  "rulepack_version": "1.0.0",
  "ai_keys": { "groq": true, "llamacloud": true }
}
```

`"status": "degraded"` means the database is unreachable — the `database` field will say why.

---

## 6. Test it

Two test suites, for different purposes.

```bash
npm test
```

**206 unit tests. No database, no network, no API keys, runs in about a second.** This is the engine's regression suite — every rule, every severity factor, every edge case. If this passes, the verification logic is sound. Run it after any change.

```bash
npm run test:e2e
```

**62 end-to-end checks. Needs the database.** Runs the real pipeline — writes to Postgres, generates a real PDF and CSV, exercises the route handlers and adjudication. The document parser and AI extractor are stubbed so it's deterministic and spends no API credits. Run this before a demo.

---

## 7. Try a real analysis

Three sample files with planted problems are in `sample-docs/`:

| File | Planted issue |
|---|---|
| `Financial_Statements.xlsx` | Revenue 3.2 Cr, COGS 2.0 Cr, gross profit 1.2 Cr — internally correct |
| `Pitch_Deck_Metrics.csv` | Claims revenue of 5.2 Cr, and 1,200 customers nothing else mentions |
| `Cap_Table.xlsx` | Shareholdings total 93%, not 100% |

Upload all three through the UI (or the curl below), assigning types **Financial Statements**, **Pitch Deck** and **Cap Table**.

Expected result: **score around 68/100, "Material Gaps Identified"**, with these findings:

```
REV-R1-001   CRITICAL  37.6  VERIFIED_MISMATCH
  Pitch_Deck_Metrics.csv: Rs 5,20,00,000 vs Financial_Statements.xlsx: Rs 3,20,00,000  ->  gap 62.5%

GM-R2-001    HIGH      20.4  UNRESOLVED_INCONSISTENCY
  Rs 1,20,00,000 / Rs 3,20,00,000 x 100 = 37.5%   [document states 62%]

CUST-R5-001  MEDIUM    12.2  MISSING_INFORMATION
  Pitch_Deck_Metrics.csv states 1,200. No supporting figure found in the other documents.

OWN-R7-001   MEDIUM    10.4  UNRESOLVED_INCONSISTENCY
  founder 52% + co-founder 25% + seed investor 16% = 93%   [should total 100%]

GP-R2-001    NONE          0  VERIFIED_CONSISTENT
  Rs 3,20,00,000 - Rs 2,00,00,000 = Rs 1,20,00,000   [document states Rs 1,20,00,000]
```

Takes 10–20 seconds. Progress arrives over the websocket.

### Via curl

```bash
TOKEN=$(curl -s -X POST http://localhost:5000/api/v1/auth/session | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
curl -s -X POST http://localhost:5000/api/v1/analyze -H "Authorization: Bearer $TOKEN" -F "files=@sample-docs/Financial_Statements.xlsx" -F "files=@sample-docs/Pitch_Deck_Metrics.csv" -F "files=@sample-docs/Cap_Table.xlsx" -F "documentTypes=financial_statements" -F "documentTypes=pitch_deck" -F "documentTypes=cap_table"
```

---

## 8. Upload rules

The backend enforces these and rejects clearly:

- **Minimum 2 files**, of **at least 2 different types**. You cannot cross-check a document against itself.
- Maximum 8 files, 25 MB each.
- Accepted: `.pdf` `.xlsx` `.csv` `.pptx`
- `documentTypes[]` must have exactly one entry per file.

---

## 9. Troubleshooting

**`Connection terminated due to connection timeout`**
The Neon database sleeps when idle and takes 5–10 seconds to wake. The first request after a break is slow; the timeout is set to 30 seconds to allow for it. If it persists, check `DATABASE_URL`.

**`relation "findings" does not exist`**
Run `npm run migrate`.

**`Something went wrong` on upload, nothing in the logs**
`GROQ_API_KEY` is missing or invalid. Check `curl http://localhost:5000/health` — `ai_keys.groq` should be `true`.

**PDFs produce no findings but Excel files work**
`LLAMA_CLOUD_API_KEY` is missing or out of credits.

**Port 5000 already in use**
An earlier server is still running. On Windows:
```bash
netstat -ano | findstr :5000
```
then `Stop-Process -Id <pid> -Force`. Or set `PORT=5001` in `.env`.

**Groq 429 rate limit**
30 requests/minute on the free tier. Wait a minute. Extraction retries automatically with backoff.

**Want to see the SQL**
```bash
DEBUG_SQL=1 npm run dev
```

---

## 10. What runs where

```
server/
├── index.js              Express + Socket.io entry point
├── db/
│   ├── pool.js           Postgres connection
│   ├── migrate.js        npm run migrate
│   ├── schema.sql        base tables
│   └── migrations/       incremental changes
├── engine/               THE VERIFICATION ENGINE — no network, no AI, pure arithmetic
│   ├── rulepack.json     every weight, tolerance and threshold
│   ├── canonicalize/     "Rs 5.2 Cr" -> 52000000, FY26 -> FY2025-26
│   ├── factGraph.js      groups figures into comparable buckets
│   ├── rules/            R1-R7, the seven checks
│   ├── severity.js       the 5-factor weighting model
│   ├── classify.js       the four classification tiers
│   ├── scoring.js        5 pillars + coverage ceiling
│   ├── explain.js        plain-English templates (no AI)
│   ├── adjudicate.js     user overrides + recompute
│   └── __tests__/        206 unit tests + the e2e check
├── services/
│   ├── parser/           PDF via LlamaParse, Excel/CSV locally
│   ├── ai/               extractor (reads) + narrator (writes prose)
│   ├── export/           PDF and CSV generation
│   └── reportBuilder.js  pipeline orchestrator
└── routes/               auth, analyze, sessions
```

**The engine never touches the network.** If both AI keys were revoked, `npm test` would still pass — only document reading and prose polish depend on them. Scores do not.

---

## 11. Notes for the demo

- **Run the same documents twice.** Identical score, identical findings. The engine is deterministic, and this is worth showing.
- **Delete `GROQ_API_KEY` and re-run** an already-analysed session's export. The report is complete with templated prose. Verification doesn't depend on an LLM being awake.
- **Adjudication is instant.** Mark the financial statements authoritative and the score recomputes in milliseconds, because it's arithmetic and not an AI call.
- **Uncalibrated thresholds.** The projection-credibility rules (R4) and the plausibility bands (R6) use reasoned defaults, not values tuned against a real dataset — no reference documents were available. They're listed in `deterministic_engine_plan.md` §12.3. Say so if asked; it's a limitation, not a flaw.
