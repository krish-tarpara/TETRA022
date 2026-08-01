# FinVerify AI 📊✨
> **Automated AI-Powered Financial Due Diligence Platform**  
> *Investors spend 40 hours auditing collateral. We do it in 40 seconds.*

---

## 🌟 Overview

**FinVerify AI** is an intelligent, high-precision financial due diligence interface designed for founders, venture capital analysts, and M&A auditors. Before pitching or closing investment rounds, FinVerify AI enables teams to ingest pitch decks, financial models, cap tables, and P&L statements to automatically cross-reference metrics, formulas, and claims—eliminating embarrassing mismatches and post-term-sheet surprises.

---

## ✨ Key Frontend Features

### 1. 🚀 Interactive Landing & Value Showcase
* **Hero Experience:** High-impact value proposition highlighting speed and accuracy metrics.
* **3D Particle Canvas (`moneyShower.js`):** WebGL-powered 3D falling currency animation using **Three.js** featuring real-time mouse repulsion dynamics and floating currency symbols (`$`, `€`, `£`, `¥`, `₹`, `💵`).
* **ROI & Feature Highlights:** Visual breakdown of the manual auditing problem vs. automated engine impact.

### 2. 📥 Secure Ingestion Hub (`upload.html`)
* **Multi-Format Drag & Drop Zone:** File uploader supporting `.pdf`, `.xlsx`, `.csv`, and `.pptx` documents up to 25MB each (up to 8 files per session).
* **Document Tagging System:** Categorize uploaded files as *Pitch Deck*, *Financial Model*, *Cap Table*, *Certified P&L*, or *Auto-detect*.
* **Real-time Validation:** Dynamic file list updates, size formatting, and file removal actions.
* **Security Notice Panel:** Highlighted memory-only data processing notice assuring bank-grade confidentiality.

### 3. 📈 Analytics & Audit Dashboard (`analysis.html`)
* **Readiness Score Gauge:** Custom interactive SVG half-circle gauge displaying overall audit readiness score (0–100%) with status threshold indicators (*Investor Ready* for >85%).
* **AI Executive Summary Card:** Rendered via **Marked.js** for markdown summary highlights.
* **Metrics Overview Cards:** Key performance indicators showing total discrepancies, critical risks, verification speed, and matched formulas.
* **Cross-Document Matrix:** High-level match percentage breakdown across document pairs (e.g., *Pitch Deck ↔ Financial Model*).
* **Discrepancy Stream:** Filterable chronological stream of detected inconsistencies categorized by severity (*Critical*, *Warning*, *Low*) and topic (*Math*, *Contextual*, *Metrics*).
* **Split Verification Modal:** Deep-dive modal interface displaying side-by-side claim comparisons, exact page/cell references, formula checks, and resolution recommendations.
* **Report Exports:** One-click CSV and PDF report export actions.
* **Live Audit Progress Overlay:** Animated real-time modal progress bar driven by WebSocket updates during execution.

### 4. 🗂️ Audit History Hub (`history.html`)
* **Session-Linked Reports:** View past financial verification runs linked to the current browser session.
* **Empty State Guidance:** Intuitive empty-state UX prompting users to initiate their first audit.
* **Quick Access Cards:** Instant navigation back to previously completed dashboard audits.

---

## 🎨 Design System & Architecture

FinVerify AI features a bespoke, glassmorphic financial UI built with modern web aesthetics:
* **Typography:** Modern Sans-Serif variable font (`Inter`) from Google Fonts.
* **Color Palette:** Sleek dark/emerald theme with semantic indicators (Success Emerald, Warning Amber, Mismatch Rose, Terracotta Accent).
* **Iconography:** Clean vector icon set powered by **Lucide Icons**.
* **Modular CSS Component Structure:**
  * `css/style.css` – CSS variables, color tokens, global resets.
  * `css/layout.css` – Navigation header, main grid systems, sticky containers.
  * `css/components/` – Reusable UI modules (`button.css`, `card.css`, `typography.css`, `overlay.css`).
  * `css/pages/` – Page-specific layout styles (`home.css`, `upload.css`, `dashboard.css`, `history.css`).

---

## 📁 Frontend Directory Structure

```
Frontend/
├── index.html            # Landing page with 3D interactive showcase
├── upload.html           # File drag & drop & document tagging hub
├── analysis.html         # Analytics dashboard & discrepancy verification
├── history.html          # Session audit history log
├── css/
│   ├── style.css         # Global tokens and design variables
│   ├── layout.css        # Core layout & grid wrappers
│   ├── components/       # Component-level styles (cards, buttons, overlays)
│   └── pages/            # Page-specific layouts
└── js/
    ├── api.js            # API communication client
    ├── socket.js         # Socket.io WebSocket real-time progress client
    ├── upload.js         # File upload state management & tagging logic
    ├── dashboard.js      # Dashboard rendering, SVG gauge & verification modal
    ├── history.js        # History session rendering logic
    └── moneyShower.js    # Three.js 3D money particles background effect
```

---

## 🛠️ Tech Stack & Dependencies

| Layer | Technology / Library | Description |
| :--- | :--- | :--- |
| **Structure** | HTML5 | Semantic markup & accessibility |
| **Styling** | Vanilla CSS3 | Custom Design Tokens, Flexbox/Grid, Glassmorphism |
| **Graphics** | Three.js (r128) | 3D WebGL interactive money falling background |
| **Icons** | Lucide Icons | Clean modern UI icon set |
| **Markdown** | Marked.js | Renders AI executive summaries dynamically |
| **Sockets** | Socket.io Client | Real-time analysis status & progress streaming |

---

## ⚡ Getting Started (Frontend Local Setup)

To run the frontend locally without a server build step:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-org/TETRA022.git
   cd TETRA022
   ```

2. **Serve the Frontend directory:**
   You can serve the static files using any local development server (e.g. VS Code Live Server, Vite, `npx serve`, or Python's HTTP server):
   ```bash
   npx serve Frontend
   ```
   *Alternatively, using Python:*
   ```bash
   cd Frontend
   python -m http.server 3000
   ```

3. **Open in Browser:**
   Navigate to `http://localhost:3000` (or the URL provided by your local server) to explore the interface.

---
