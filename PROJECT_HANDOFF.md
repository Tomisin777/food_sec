# Find Food Baltimore (PantryPulse) — Comprehensive Technical Handoff Document

> **Project Mission:** Bridging the food pantry information gap in Baltimore City. No existing platform (Plentiful, Link2Feed, 211, Maryland Food Bank) gives food-insecure clients live, category-level shelf visibility (*"Does a pantry near 21218 have baby formula right now?"*). We solve this with a two-sided platform: a dignity-first public web locator and a lightweight pantry operator toolkit powered by multimodal AI and a predict-and-correct inventory state estimator.

---

## 1. Repository & Collaboration Information

* **GitHub Repository:** `https://github.com/AdeoyeStephanie/food_sec`
* **Active Working Branch:** `feature/predict-and-correct`
* **Stable Production Branch:** `main`
* **Local Project Directory:** `/Users/tomisinadebari/Downloads/Food Pantry`

---

## 2. Architecture Overview & Two-App Separation

Per project requirements, the system is strictly split into two completely isolated applications so neighbors never see administrative tools, and pantry staff have a dedicated operating console:

```
                               ┌────────────────────────────────────────────────────────┐
                               │                    FIND FOOD BALTIMORE                 │
                               └───────────────────────────┬────────────────────────────┘
                                                           │
                      ┌────────────────────────────────────┴────────────────────────────────────┐
                      ▼                                                                         ▼
     ┌─────────────────────────────────┐                                       ┌─────────────────────────────────┐
     │      NEIGHBOR / CLIENT APP      │                                       │   PANTRY OPERATOR / OWNER APP   │
     │            Route: /             │                                       │        Route: /volunteer        │
     ├─────────────────────────────────┤                                       ├─────────────────────────────────┤
     │ • 100% clean, no admin buttons  │                                       │ • Protected by 4-digit PIN      │
     │ • Natural language + voice search│                                      │   (e.g., "4827")                │
     │ • Conversational AI summary     │                                       │ • Big-button check-in counter   │
     │ • Leaflet map with stock pins   │                                       │ • Real-time camera scanner with │
     │ • Category bands (Plenty/Low/Out│                                       │   Gemini 3.6 Flash multimodal AI│
     │ • Walking distance & directions │                                       │ • 10-second closing check       │
     │ • "What to expect" (No ID, etc.)│                                       │ • Quick mid-shift "Out" flags   │
     │ • Anonymous neighbor feedback   │                                       │ • TEFAP report generation       │
     └─────────────────────────────────┘                                       └─────────────────────────────────┘
```

---

## 3. What Has Been Built & Achieved So Far

### A. Database Layer (`db/`)
* **Database Engine:** PostgreSQL + PostGIS (compatible with Supabase).
* **Schema (`db/init.sql`):**
  * `pantries`: UUID, name, address, neighborhood, PostGIS `geography(POINT, 4326)`, hours JSONB, distribution model, volunteer code, ID policy, walk-in policy, spoken languages.
  * `food_categories`: Standard pantry taxonomy (Produce, Protein, Dairy, Grains, Diapers, Hygiene, Canned Goods, Halal items).
  * `pantry_categories`: Per-category allocation rates (lbs per person for predict-and-correct math).
  * `shelf_state`: Time-series shelf updates (`plenty`, `low`, `out`), internal estimated quantities, source (`intake_photo`, `prediction`, `volunteer_correction`, `client_feedback`), confidence score (0.0–1.0).
  * `check_ins`: Fast anonymous household logging (household size 1–20, timestamp).
  * `latest_shelf` View: Fast materialized lookup of the most recent stock status and freshness timestamp per pantry.
  * `find_pantries_near(lat, lng, radius_miles)` Function: PostGIS geospatial distance calculation and walking time estimation.
* **Seed Data (`db/seed.sql`):** 10 verified real Baltimore pantries seeded with coordinates, operating hours, and realistic shelf states:
  1. Northside Family Pantry (Hampden)
  2. Beans and Bread (Fells Point)
  3. GEDCO CARES Pantry (Charles Village)
  4. St. Vincent de Paul (Jonestown)
  5. Bea Gaddy Family Centers (Patterson Park)
  6. Riverside Community Table (Riverside)
  7. Paul's Place (Pigtown)
  8. Waverly Community Pantry (Waverly / 21218)
  9. Cherry Hill Community Pantry (Cherry Hill)
  10. Sandtown Community Pantry (Sandtown-Winchester)

### B. Python FastAPI Backend (`backend/`)
* Built with `FastAPI`, `asyncpg`, and `pydantic`.
* **Endpoints:**
  * `GET /health` — Health check
  * `GET /api/pantries` — Geospatial radius search returning pantries and live stock items
  * `GET /api/pantries/{pantry_id}` — Single pantry detail
  * `GET /api/categories` — Master food category list
  * `POST /api/inventory/checkin` — Household visit logging **plus predict-and-correct depletion** (respects `distribution_model`)
  * `POST /api/inventory/intake` — Photo donation endpoint
  * `POST /api/inventory/correction` — Volunteer closing check; snaps estimates to ground truth with `source=volunteer_correction` and `confidence=1.0`
  * `GET /api/inventory/{pantry_id}/today` — Today's households / individuals served
  * `GET /api/inventory/{pantry_id}/shelf` — Latest estimated quantities for the closing-check UI
  * `PATCH /api/inventory/{pantry_id}/distribution` — Persist pre-packed / list / client-choice
  * `GET /api/inventory/{pantry_id}/report?year=&month=` — TEFAP / Maryland Food Bank monthly CSV

### C. Modern Next.js Frontend (`frontend/`)
* Built with Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, Lucide Icons, and Leaflet.
* **Client App (`frontend/app/page.tsx`):**
  * Natural language search box (*"diapers near Hampden after 6pm"*) with browser Web Speech API voice search in English and Spanish.
  * Suggestion chips (*"Baby formula near me"*, *"Open tonight"*, *"No ID needed"*, *"Fresh produce"*).
  * Conversational AI summary box at the top of results.
  * Interactive Leaflet Map (`frontend/components/PantryMap.tsx`) with custom HTML pins rendering miniature stock bars.
  * Detailed Slide-over sheet (`frontend/components/PantryDetailSheet.tsx`) showing shelf levels, freshness stamps (*"40 min ago"*), practical expectations (*"Bring your own bags"*, *"No ID needed"*), and anonymous neighbor feedback (*"Yes, they had it" / "No, they were out"*).
  * Emergency voice hotline card (*"(410) 555-FOOD"*) for smartphone-dependent clients.
* **Pantry Operator Portal (`frontend/app/volunteer/page.tsx` & `components/VolunteerDashboard.tsx`):**
  * Protected by 4-digit volunteer code (**`4827`**).
  * **Check-In Touchpad:** Large 1 to 8+ household size buttons that increment the "Families served today" counter **and deplete estimated shelf quantities**.
  * **Distribution Style Selector:** Operators pick Pre-packed boxes, Pick from a list, or Shop the shelves (client choice). Persisted per pantry; check-in math follows the model.
  * **Quick Run-out Flags:** 1-tap toggles for Produce, Protein, Dairy, Diapers, Hygiene to immediately alert neighbors on the map.
  * **Live Camera Viewfinder (`frontend/components/CameraViewfinder.tsx`):** Integrated browser webcam/phone camera stream with live shutter button and front/back camera toggle.
  * **Gemini 3.6 Flash Multimodal Scanner (`frontend/app/api/scan-donation/route.ts`):** Sends snapped photo in-memory to Google Gemini, methodically scans and categorizes items with zero-temperature accuracy, displays editable `+` and `−` review counters, and commits updates to shelves with privacy guarantees (*"Photo is deleted immediately after sorting"*).
  * **Closing Check:** 10-second end-of-shift review where volunteers confirm or override the predict-and-correct model guesses. **Send update** writes `volunteer_correction` rows with confidence **1.0**.
  * **TEFAP Monthly Report:** Reports tab exports a CSV of households served, family-size breakdown, and estimated pounds for the selected month.

---

## 4. Current File Tree

```
Food Pantry/
├── .gitignore
├── PROJECT_HANDOFF.md
├── docker-compose.yml
├── db/
│   ├── init.sql
│   ├── migrate_predict_and_correct.sql
│   └── seed.sql
├── backend/
│   ├── .env.example
│   ├── config.py
│   ├── db.py
│   ├── main.py
│   ├── models.py
│   ├── estimator.py
│   ├── report.py
│   ├── requirements.txt
│   ├── tests/
│   │   ├── test_estimator.py
│   │   └── test_report.py
│   └── routers/
│       ├── inventory.py
│       └── pantries.py
└── frontend/
    ├── package.json
    ├── tsconfig.json
    ├── app/
    │   ├── globals.css
    │   ├── layout.tsx
    │   ├── page.tsx
    │   ├── volunteer/page.tsx
    │   └── api/
    │       ├── inventory/          <-- check-in, correction, shelf, report, distribution
    │       └── scan-donation/route.ts
    ├── components/
    │   ├── CameraViewfinder.tsx
    │   ├── PantryDetailSheet.tsx
    │   ├── PantryMap.tsx
    │   └── VolunteerDashboard.tsx
    └── lib/
        ├── estimator.ts
        ├── inventoryApi.ts
        ├── operatorStore.ts
        ├── pantryData.ts
        ├── reportCsv.ts
        └── shelfSync.ts
```

---

## 5. Active Environment & Configuration

* **Node.js Version:** `v22.17.1`, `npm 10.9.2`
* **Python Version:** `Python 3.13.5`
* **Active Dev Server:** Running on `http://localhost:3000` (Next.js Turbopack)
* **Active Gemini Model:** `gemini-3.6-flash`
* **Local secrets (gitignored):** put `GEMINI_API_KEY` in `frontend/.env.local` — never commit real values.
* **Database URL:** put `DATABASE_URL` in `backend/.env` (see `backend/.env.example`) — never commit real values.

---

## 6. What Needs to Be Done Next (Roadmap for Grok Bot)

### Done on this pass
1. **Distribution Style Selector** — volunteer portal persists `pre_packed` / `list` / `client_choice` and check-in depletion follows the model.
2. **Predict-and-correct estimator** — check-ins write `shelf_state` with `source=prediction`; closing **Send update** snaps quantities and sets `confidence=1.0` / `volunteer_correction`. Neighbor map/detail read the overlay.
3. **TEFAP monthly CSV** — Reports tab → Export Monthly Report.

### Still open
1. **Category Customization:** Allow pantries to add custom categories (e.g., Kosher items, Infant formula, Pet food).
2. **Voice Hotline Integration (ElevenLabs + Twilio):** incoming phone hotline with a server tool that hits `/api/pantries`.
3. **Production Deployment (Vercel).**

---

## 7. How to Run & Verify the Project

```bash
# 1. Clone repository and switch to feature branch
git clone https://github.com/AdeoyeStephanie/food_sec.git
cd food_sec
git checkout feature/predict-and-correct

# 2. Start the Frontend Application
cd frontend
npm install
npm run dev

# 3. Open in Browser
# Neighbor/Client App: http://localhost:3000
# Pantry Operator Portal: http://localhost:3000/volunteer (PIN: 4827)
#
# Verify pantry features:
# 1. Pick a pantry, enter PIN 4827.
# 2. Choose a distribution style (Pre-packed / List / Shop the shelves) — it persists.
# 3. Tap household sizes; toast shows lbs deducted. Closing check → Send update (confidence 1.0).
# 4. Reports tab → Export Monthly Report downloads a TEFAP CSV.
# 5. Exit to Neighbor View: map pins / detail sheet reflect the new bands.
```
