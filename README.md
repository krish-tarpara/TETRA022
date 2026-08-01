<p align="center">
  <img src="https://img.shields.io/badge/FinVerify-AI-blueviolet?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTV6Ii8+PHBhdGggZD0iTTIgMTdsMTAgNSAxMC01Ii8+PHBhdGggZD0iTTIgMTJsMTAgNSAxMC01Ii8+PC9zdmc+" alt="FinVerify AI"/>
</p>

<h1 align="center">FinVerify AI</h1>

<p align="center">
  <strong>AI-Powered Fundraising Document Cross-Verification & Due Diligence Engine</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/PostgreSQL-15+-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/Socket.IO-4.7-010101?style=flat-square&logo=socket.io&logoColor=white" alt="Socket.IO"/>
  <img src="https://img.shields.io/badge/Gemini_AI-Powered-4285F4?style=flat-square&logo=google&logoColor=white" alt="Gemini AI"/>
  <img src="https://img.shields.io/badge/Groq-DeepSeek_R1-FF6600?style=flat-square" alt="Groq"/>
  <img src="https://img.shields.io/badge/LlamaCloud-Parsing-7C3AED?style=flat-square" alt="LlamaCloud"/>
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License"/>
</p>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Architecture](#️-architecture)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Prerequisites](#-prerequisites)
- [Installation & Setup](#️-installation--setup)
- [Environment Variables](#-environment-variables)
- [Database Setup](#️-database-setup)
- [Running the Application](#-running-the-application)
- [API Reference](#-api-reference)
- [Database Schema](#-database-schema)
- [Frontend Pages](#-frontend-pages)
- [Real-Time Pipeline](#-real-time-pipeline)
- [Screenshots](#-screenshots)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Overview

**FinVerify AI** is an intelligent due diligence platform that cross-verifies fundraising documents — such as **Pitch Decks**, **Financial Models**, **Cap Tables**, and **Certified P&L statements** — to detect numerical mismatches, inconsistencies, missing data, and unusual patterns.

It leverages a **multi-model AI pipeline** (Google Gemini for metric extraction, Groq/DeepSeek-R1 for chain-of-thought reasoning, and LlamaCloud for document parsing) to produce a comprehensive **Fundraising Readiness Report** with a quantified readiness score.

### The Problem

Investors and VCs spend hours manually cross-referencing numbers between pitch decks and financial spreadsheets. Founders unknowingly submit documents with conflicting claims — a revenue figure in Slide 12 that doesn't match Row 47 in their financial model — leading to lost credibility and failed fundraising rounds.

### The Solution

FinVerify AI automates this entire process:

1. **Upload** your pitch deck (PDF/PPTX) and financial model (XLSX/CSV)
2. **AI parses** each document, extracting every financial metric with its source context
3. **Cross-verification engine** compares metrics across documents, flagging discrepancies
4. **Readiness Report** is generated with a score, executive summary, and investor-ready questions

---

## ✨ Key Features

| Feature | Description |
|---|---|
| 🔍 **Multi-Document Cross-Verification** | Compares metrics across Pitch Decks, Financial Models, Cap Tables, and P&L statements |
| 🧠 **Chain-of-Thought Reasoning** | DeepSeek-R1 via Groq provides transparent audit trails for every finding |
| 📊 **Readiness Score** | Quantified 0-100 score indicating fundraising readiness (>85 = Ready for Review) |
| 📄 **Multi-Format Support** | Upload PDF, XLSX, CSV, and PPTX files (up to 25MB each, max 8 files) |
| ⚡ **Real-Time Progress** | Socket.IO-powered live pipeline updates (Parsing → Extracting → Validating → Analyzing) |
| 📋 **Executive Summary** | AI-generated markdown summary of document consistency |
| 🔎 **Discrepancy Deep Dive** | Split-view modal showing conflicting quotes from source documents side-by-side |
| ❓ **Investor Question Generator** | Auto-generates the tough questions investors would ask about each discrepancy |
| 📥 **Export Reports** | Download analysis as PDF or CSV |
| 📜 **Session History** | Browse and revisit past analyses linked to your browser session |
| 💸 **Interactive Landing Page** | Three.js-powered falling currency animation with mouse-reactive physics |
| 🔐 **Bank-Grade Security** | Documents processed in-memory, never used for AI training, purged on session delete |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Vanilla HTML/CSS/JS)            │
│                                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Landing   │  │ Upload Hub   │  │ Analysis │  │ History          │ │
│  │ Page      │  │ (Drag&Drop)  │  │ Dashboard│  │ (Past Sessions)  │ │
│  └──────────┘  └──────┬───────┘  └────┬─────┘  └──────────────────┘ │
│                       │               │                              │
│                  Socket.IO        Socket.IO                          │
│                       │               │                              │
└───────────────────────┼───────────────┼──────────────────────────────┘
                        │               │
                        ▼               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        BACKEND (Node.js + Express)                   │
│                                                                      │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ Auth Route │  │ Analyze Route│  │ Sessions     │                 │
│  │ /api/v1/   │  │ /api/v1/     │  │ Route        │                 │
│  │ auth/      │  │ analyze      │  │ /api/v1/     │                 │
│  │            │  │              │  │ sessions/    │                 │
│  └────────────┘  └──────┬───────┘  └──────────────┘                 │
│                         │                                            │
│              ┌──────────┼──────────┐                                 │
│              ▼          ▼          ▼                                  │
│        ┌──────────┐ ┌────────┐ ┌────────────┐                       │
│        │LlamaCloud│ │Gemini  │ │Groq        │                       │
│        │(Parse)   │ │(Extract│ │(DeepSeek-R1│                       │
│        │          │ │Metrics)│ │Reasoning)  │                       │
│        └──────────┘ └────────┘ └────────────┘                       │
│                         │                                            │
│                         ▼                                            │
│              ┌────────────────────┐                                  │
│              │   PostgreSQL DB    │                                  │
│              │  (5 tables, UUID   │                                  │
│              │   primary keys)    │                                  │
│              └────────────────────┘                                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 🛠 Tech Stack

### Backend
| Technology | Purpose |
|---|---|
| **Node.js** + **Express** | REST API server |
| **Socket.IO** | Real-time bidirectional communication for pipeline progress |
| **PostgreSQL** (`pg`) | Relational database for sessions, documents, metrics, discrepancies |
| **JWT** (`jsonwebtoken`) | Lightweight anonymous session authentication |
| **Multer** | Multipart file upload handling |
| **dotenv** | Environment variable management |

### AI / ML Services
| Service | Purpose |
|---|---|
| **LlamaCloud API** | Document parsing (PDF, PPTX → structured markdown/text) |
| **Google Gemini API** | Financial metric extraction with structured JSON output |
| **Groq API (DeepSeek-R1)** | Chain-of-thought cross-verification reasoning & discrepancy analysis |

### Frontend
| Technology | Purpose |
|---|---|
| **Vanilla HTML5 / CSS3 / JS** | No framework — lightweight, fast-loading pages |
| **Three.js** | 3D falling currency animation on the landing page |
| **Socket.IO Client** | Real-time pipeline progress tracking |
| **Lucide Icons** | Modern icon set |
| **Marked.js** | Markdown → HTML rendering for AI summaries |
| **Google Fonts (Inter)** | Clean, modern typography |

---

## 📁 Project Structure

```
TETRA022/
├── .env.example               # Environment variable template
├── .gitignore                 # Git ignore rules
├── README.md                  # This file
├── vite.config.js             # Vite dev server config (proxy to backend)
├── postcss.config.js          # PostCSS + TailwindCSS config
│
├── Frontend/                  # Client-side application
│   ├── index.html             # Landing page (with Three.js money shower)
│   ├── upload.html            # Secure Ingestion Hub (drag & drop file upload)
│   ├── analysis.html          # Analytics Dashboard (readiness report)
│   ├── history.html           # Past analysis sessions browser
│   │
│   ├── css/                   # Stylesheets (modular architecture)
│   │   ├── style.css          # Global variables & base styles
│   │   ├── layout.css         # Layout utilities
│   │   ├── components/        # Reusable component styles
│   │   │   ├── typography.css
│   │   │   ├── button.css
│   │   │   ├── card.css
│   │   │   └── overlay.css
│   │   └── pages/             # Page-specific styles
│   │       ├── upload.css
│   │       ├── dashboard.css
│   │       └── history.css
│   │
│   └── js/                    # Client-side JavaScript
│       ├── api.js             # API client with JWT auth (GET/POST helpers)
│       ├── upload.js          # File upload logic (drag-drop, validation, FormData)
│       ├── dashboard.js       # Dashboard renderer (gauge, metrics, discrepancies)
│       ├── history.js         # Session history loader
│       ├── socket.js          # SocketClient class (real-time pipeline tracking)
│       └── moneyShower.js     # Three.js falling currency effect
│
└── server/                    # Backend application
    ├── index.js               # Express server entry point (routes, middleware, Socket.IO)
    ├── socket.js              # Socket.IO namespace setup & event handlers
    │
    ├── routes/                # API route handlers
    │   ├── auth.js            # POST /api/v1/auth/session — JWT session creation
    │   ├── analyze.js         # POST /api/v1/analyze — File upload + trigger pipeline
    │   └── sessions.js        # GET /api/v1/sessions — History & session detail
    │
    └── db/                    # Database layer
        ├── pool.js            # PostgreSQL connection pool (pg)
        ├── queries.js         # All SQL query functions (CRUD for all 5 tables)
        └── schema.sql         # Database schema (DDL for tables & indexes)
```

---

## 📝 Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** v18 or later — [Download](https://nodejs.org/)
- **PostgreSQL** v15 or later — [Download](https://www.postgresql.org/download/)
- **npm** v9+ (comes with Node.js)
- **Git** — [Download](https://git-scm.com/)

You will also need API keys for:
- [Google Gemini API](https://aistudio.google.com/app/apikey)
- [Groq API](https://console.groq.com/keys)
- [LlamaCloud API](https://cloud.llamaindex.ai/)

---

## ⚙️ Installation & Setup

### 1. Clone the Repository

```bash
git clone https://github.com/krish-tarpara/TETRA022.git
cd TETRA022
```

### 2. Install Dependencies

```bash
# Install server dependencies
cd server
npm install

# Return to root (if needed for frontend dev server)
cd ..
npm install
```

### 3. Configure Environment Variables

```bash
# Copy the example env file
cp .env.example .env
```

Edit `.env` with your actual credentials (see [Environment Variables](#-environment-variables) section below).

### 4. Set Up the Database

```bash
# Create the database
psql -U postgres -c "CREATE DATABASE finverify;"

# Run the schema
psql -U postgres -d finverify -f server/db/schema.sql
```

### 5. Start the Application

```bash
# Terminal 1: Start the backend server
cd server
node index.js

# Terminal 2: Start the frontend dev server (with Vite proxy)
npm run dev
```

The application will be available at:
- **Frontend**: `http://localhost:5173`
- **Backend API**: `http://localhost:5000`
- **Health Check**: `http://localhost:5000/health`

---

## 🔑 Environment Variables

Create a `.env` file in the project root with the following variables:

| Variable | Description | Example |
|---|---|---|
| `LLAMA_CLOUD_API_KEY` | LlamaCloud API key for document parsing | `llx-...` |
| `GOOGLE_API_KEY` | Google Gemini API key for metric extraction | `AIza...` |
| `GROQ_API_KEY` | Groq API key for DeepSeek-R1 reasoning | `gsk_...` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:password@localhost:5432/finverify` |
| `JWT_SECRET` | Secret for JWT session tokens (min 32 chars) | `your_random_jwt_secret_at_least_32_chars` |
| `PORT` | Server port | `5000` |
| `NODE_ENV` | Environment mode | `development` |

---

## 🗄️ Database Setup

The application uses **PostgreSQL** with 5 relational tables. Run the schema file to create them:

```bash
psql -U postgres -d finverify -f server/db/schema.sql
```

---

## ▶ Running the Application

### Development Mode

```bash
# Start backend (auto-restarts with nodemon if installed)
cd server
node index.js

# In a separate terminal, start Vite dev server
npm run dev
```

### Production Mode

```bash
# Build frontend assets
npm run build

# Start server with production env
NODE_ENV=production node server/index.js
```

---

## 📡 API Reference

### Authentication

#### `POST /api/v1/auth/session`
Creates an anonymous JWT session token.

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

> All subsequent requests require the `Authorization: Bearer <token>` header.

---

### Analysis

#### `POST /api/v1/analyze`
Upload files and trigger the AI analysis pipeline.

**Headers:**
```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Form Data:**
| Field | Type | Description |
|---|---|---|
| `files` | File[] | 2-8 document files (PDF, XLSX, CSV, PPTX) |
| `documentTypes` | String[] | Category for each file: `pitch_deck`, `financial_model`, `cap_table`, `certified_pnl`, `unknown` |

**Response:**
```json
{
  "sessionId": "a1b2c3d4-e5f6-..."
}
```

---

### Sessions

#### `GET /api/v1/sessions`
List all analysis sessions for the authenticated user.

**Response:**
```json
[
  {
    "id": "uuid",
    "status": "complete",
    "readiness_score": 78,
    "total_mismatches": 3,
    "created_at": "2025-01-15T10:30:00Z"
  }
]
```

#### `GET /api/v1/sessions/:sessionId`
Get full analysis report for a specific session.

**Response:**
```json
{
  "session": {
    "id": "uuid",
    "status": "complete",
    "readiness_score": 78,
    "summary_report": { "summary": "..." },
    "reasoning_chain": "...",
    "model_used": "deepseek-r1"
  },
  "documents": [...],
  "discrepancies": [...]
}
```

#### `GET /api/v1/sessions/:sessionId/export/pdf`
Download the analysis report as a PDF.

#### `GET /api/v1/sessions/:sessionId/export/csv`
Download discrepancies as a CSV file.

---

### Health Check

#### `GET /health`
```json
{ "status": "ok" }
```

---

## 🗃 Database Schema

### ERD (Entity Relationship)

```
┌──────────┐       ┌──────────────────┐       ┌────────────┐
│  users   │──1:N──│ analysis_sessions │──1:N──│ documents  │
└──────────┘       └────────┬─────────┘       └──────┬─────┘
                            │                        │
                            │ 1:N                    │ 1:N
                            ▼                        ▼
                   ┌────────────────┐      ┌──────────────────┐
                   │ discrepancies  │      │ extracted_metrics │
                   └────────────────┘      └──────────────────┘
```

### Tables

#### `users`
| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `session_token` | VARCHAR(500) | JWT token (unique) |
| `created_at` | TIMESTAMPTZ | Account creation time |
| `last_active` | TIMESTAMPTZ | Last activity time |

#### `analysis_sessions`
| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `user_id` | UUID (FK → users) | Session owner |
| `status` | VARCHAR(30) | `processing`, `complete`, `failed`, `insufficient_documents` |
| `readiness_score` | INTEGER | 0-100 fundraising readiness score |
| `total_mismatches` | INTEGER | Count of numerical mismatches |
| `total_inconsistencies` | INTEGER | Count of logical inconsistencies |
| `total_missing` | INTEGER | Count of missing data points |
| `total_unusual` | INTEGER | Count of unusual patterns |
| `summary_report` | JSONB | Full structured AI report |
| `follow_up_questions` | JSONB | Generated investor questions |
| `reasoning_chain` | TEXT | DeepSeek-R1 raw chain-of-thought |
| `model_used` | VARCHAR(50) | AI model identifier |

#### `documents`
| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `session_id` | UUID (FK) | Parent analysis session |
| `original_filename` | VARCHAR(255) | User's original filename |
| `file_type` | VARCHAR(10) | `pdf`, `xlsx`, `csv`, `pptx` |
| `document_category` | VARCHAR(50) | `pitch_deck`, `financial_model`, etc. |
| `parsed_content` | TEXT | Raw markdown/text from parsing |
| `extracted_metrics` | JSONB | Structured JSON metrics from Gemini |

#### `extracted_metrics`
| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `session_id` | UUID (FK) | Parent session |
| `document_id` | UUID (FK) | Source document |
| `metric_name` | VARCHAR(100) | Original metric name |
| `normalized_name` | VARCHAR(100) | Standardized metric name |
| `metric_value` | NUMERIC | Extracted numerical value |
| `metric_unit` | VARCHAR(20) | Unit (%, $, etc.) |
| `metric_currency` | VARCHAR(10) | Currency code (INR, USD, EUR) |
| `period_type` | VARCHAR(20) | `historical`, `current`, `projected`, `unknown` |
| `confidence` | FLOAT | Extraction confidence (0-1) |

#### `discrepancies`
| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `session_id` | UUID (FK) | Parent session |
| `classification` | VARCHAR(30) | `mismatch`, `inconsistency`, `missing`, `unusual` |
| `severity_weight` | INTEGER | 15 (mismatch), 10 (missing), 8 (unusual), 5 (inconsistency) |
| `metric_name` | VARCHAR(100) | Affected metric |
| `description` | TEXT | Human-readable description |
| `source_a_*` / `source_b_*` | Various | Document A and B references (filename, page, value, context) |
| `variance_pct` | FLOAT | Percentage difference between values |
| `follow_up_question` | TEXT | Auto-generated investor question |

---

## 🖥 Frontend Pages

### 1. Landing Page (`index.html`)
- Interactive Three.js **falling currency animation** ($, €, £, ¥, ₹) with mouse-reactive physics
- Hero section with call-to-action to start an audit

### 2. Secure Ingestion Hub (`upload.html`)
- **Drag & drop** file upload zone
- Supports PDF, XLSX, CSV, PPTX (up to 25MB each, max 8 files)
- **Document type tagging** dropdown (Pitch Deck, Financial Model, Cap Table, Certified P&L, Auto-detect)
- File size validation and rejection feedback
- "How it works" sidebar with step-by-step instructions

### 3. Analytics Dashboard (`analysis.html`)
- **Real-time processing overlay** with animated pipeline stages (Parsing → Extracting → Validating → Analyzing)
- **Executive Summary** — AI-generated markdown overview
- **Readiness Score Gauge** — Animated SVG half-circle gauge (0-100)
- **Metrics Grid** — Readiness Score, Documents Scanned, Verified Metrics, Total Discrepancies
- **Cross-Document Matrix** — Verification match percentages between document pairs
- **Discrepancy Stream** — Chronological timeline of findings with severity and category tags
- **Verification Deep Dive Modal** — Side-by-side quotes from conflicting documents with auto-generated investor questions
- **Export** — Download as PDF or CSV

### 4. History (`history.html`)
- Grid of past analysis session cards
- Session metadata (date, readiness score, status)
- Click to revisit any past analysis

---

## 🔄 Real-Time Pipeline

The analysis pipeline uses **Socket.IO** namespaced under `/analysis` to push real-time updates to the frontend:

```
Client                    Server
  │                         │
  ├── analysis:start ──────►│
  │                         ├── Parse docs (LlamaCloud)
  │◄── status:update ──────┤  stage: "parsing"
  │                         ├── Extract metrics (Gemini)
  │◄── status:update ──────┤  stage: "extracting"
  │                         ├── Validate claims
  │◄── status:update ──────┤  stage: "validating"
  │                         ├── Cross-verify (DeepSeek-R1)
  │◄── status:update ──────┤  stage: "analyzing"
  │                         ├── Save results to DB
  │◄── analysis:complete ──┤  data: { sessionId }
  │                         │
```

### Socket Events

| Event | Direction | Payload |
|---|---|---|
| `analysis:start` | Client → Server | `{ sessionId }` |
| `status:update` | Server → Client | `{ stage, progress: { current, total }, message }` |
| `status:warning` | Server → Client | `{ message }` |
| `analysis:complete` | Server → Client | `{ sessionId }` |
| `analysis:error` | Server → Client | `{ error }` |
| `rejoin` | Client → Server | `{ sessionId }` |

---

## 📸 Screenshots

> _Screenshots coming soon. Run the application locally to see the full UI._

---

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create** a feature branch:
   ```bash
   git checkout -b feature/amazing-feature
   ```
3. **Commit** your changes:
   ```bash
   git commit -m "feat: add amazing feature"
   ```
4. **Push** to the branch:
   ```bash
   git push origin feature/amazing-feature
   ```
5. **Open a Pull Request**

### Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Usage |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation changes |
| `style:` | Formatting, no code change |
| `refactor:` | Code restructuring |
| `test:` | Adding tests |
| `chore:` | Tooling, dependencies |

---

## 👥 Team

**Team TETRA022** — Built for a Hackathon 🏆

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  <sub>Built with ❤️ by Team TETRA022</sub>
</p>