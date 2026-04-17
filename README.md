# Deal Scout CRM

Commercial real estate CRM with OM ingestion. Built for Real Estate AI Studio.

Stack:
- Frontend: Vite + React + TypeScript + Tailwind, served via `serve` on Cloud Run
- Backend: FastAPI on Cloud Run, Python 3.11
- Data: Firestore (five collections), Firebase Storage (OM files), Firebase Auth (Google only)
- OM extraction: Anthropic Claude Sonnet 4.6 vision (PDFs and images)

Monorepo:

```
crm/
  apps/
    web/   # Vite React TypeScript frontend, deploys to Cloud Run service "deal-scout"
    api/   # FastAPI backend, deploys to Cloud Run service "deal-scout-api"
  firebase.json
  firestore.rules
  storage.rules
```

## Data model (Firestore)

- `buildings`: address, city, state, zip, asset_class, units, sf, nrsf, keys, zoning, entitlements, year_built, year_renovated, occupancy, current_noi, asking_price, cap_rate, adr, revpar, notes, photos[], documents[], created_at, updated_at
- `contacts`: name, role (broker/sponsor/owner/lender/tenant/other), firm, email, phone, linkedin, notes, related_buildings[], related_deals[]
- `deals`: building_id, contact_ids[], status (sourcing/underwriting/loi/diligence/won/lost), source, deadline, notes, created_at
- `underwriting`: building_id, asset_class, ttm, proforma_12mo, assumptions, rent_roll[], lease_roll[], returns (irr, equity_multiple, coc_yr1, dscr), version, created_at
- `om_ingestions`: storage_path[], building_id, extraction_status, raw_extraction, confirmed_at, error

## Asset classes

Underwriting adapts to: `multifamily, office, retail, industrial, hospitality, mixed-use, land, self-storage, other`.

- Multifamily: rent roll by unit, T12, vacancy, OpEx, NOI, proforma, IRR
- Office / Retail / Industrial / Mixed-use: lease roll (tenant, sf, rent, start, expiration, options, recovery), TI/LC reserves
- Hospitality: ADR, RevPAR, occupancy, rooms revenue, F&B, OpEx per key
- Self-storage: NRSF, occupancy, rental income, tenant insurance
- Land: price, zoning, entitlements. No operating cashflows.
- Other / Mixed-use: free-form

One `UnderwritingPanel` component handles all of them with conditional fields.

## Local development

Prereqs: Node 22 and Python 3.11 locally. Firebase CLI for rules deploys.

### Web

```
cd apps/web
cp .env.example .env.local
npm install
npm run dev
```

Fill `.env.local` with the Firebase web config from Firebase Console -> Project Settings -> General -> Your apps. Set `VITE_API_BASE_URL=http://localhost:8080` to point at the local API.

### API

```
cd apps/api
cp .env.example .env
pip install -r requirements.txt
export AUTH_DISABLED=1           # optional, skips Firebase token verify locally
export ANTHROPIC_API_KEY=sk-...  # required for extraction
uvicorn app.main:app --reload --port 8080
```

## First-time Firebase setup

1. Confirm the project `reais---prospecter` exists in Firebase Console. If not, create it.
2. Enable Firestore (Native mode) and Firebase Storage.
3. Enable Authentication and turn on the Google sign-in provider.
4. In Authentication settings, lock down Authorized Domains to the Cloud Run URL plus `localhost`.
5. From Project Settings -> General -> Your apps, register a web app. Copy the config values into `apps/web/.env.local` (and into Cloud Run env vars at deploy time).
6. Deploy rules:

```
npm i -g firebase-tools
firebase login
firebase use reais---prospecter
firebase deploy --only firestore:rules,storage:rules
```

## Deploy to Cloud Run

Both services deploy from this monorepo using source-based builds. The frontend replaces the existing `deal-scout` service so the iframe URL stays the same: `https://deal-scout-s4vcjek4ra-uw.a.run.app`.

### Deploy the frontend (Cloud Run service `deal-scout`)

```
cd apps/web
gcloud config set project reais---prospecter
gcloud run deploy deal-scout \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars VITE_FIREBASE_API_KEY=...,VITE_FIREBASE_AUTH_DOMAIN=...,VITE_FIREBASE_PROJECT_ID=reais---prospecter,VITE_FIREBASE_STORAGE_BUCKET=...,VITE_FIREBASE_MESSAGING_SENDER_ID=...,VITE_FIREBASE_APP_ID=...,VITE_API_BASE_URL=https://deal-scout-api-s4vcjek4ra-uw.a.run.app,VITE_ALLOWED_DOMAIN=realestateaistudio.com,VITE_ALLOWED_EMAIL=pinekrone@gmail.com
```

Cloud Run Buildpacks picks up `package.json` (Node 22), runs `npm install` and `npm run build`, then `npm run start` which is `serve -s dist -l tcp://0.0.0.0:$PORT`.

### Deploy the backend (Cloud Run service `deal-scout-api`)

```
cd apps/api
gcloud run deploy deal-scout-api \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars ANTHROPIC_API_KEY=sk-ant-...,ANTHROPIC_MODEL=claude-sonnet-4-6,FIREBASE_PROJECT_ID=reais---prospecter,FIREBASE_STORAGE_BUCKET=reais---prospecter.appspot.com,ALLOWED_ORIGINS=https://deal-scout-s4vcjek4ra-uw.a.run.app,ALLOWED_EMAILS=pinekrone@gmail.com,ALLOWED_DOMAINS=realestateaistudio.com
```

Buildpacks detects Python via `requirements.txt` + `Procfile`. `runtime.txt` pins Python 3.11. The Cloud Run service uses its default service account, which auto-authenticates to Firestore and Storage in the same project. Verify that service account has `roles/datastore.user` and `roles/storage.objectAdmin` on the project.

After the backend deploys, grab the generated URL and put it back into the frontend as `VITE_API_BASE_URL`, then redeploy the frontend. If you want a stable URL, bind a custom domain or use a URL map.

### Where to put the Anthropic key

`ANTHROPIC_API_KEY` only goes on the backend Cloud Run service. Never ship it to the browser. Rotate by redeploying with a new value in `--set-env-vars` or use Secret Manager:

```
echo -n "sk-ant-..." | gcloud secrets create anthropic-api-key --data-file=-
gcloud run services update deal-scout-api \
  --region us-west1 \
  --set-secrets=ANTHROPIC_API_KEY=anthropic-api-key:latest
```

## GitHub setup

The existing repo `pinekrone-dev/deal-scout` is reused as the monorepo home. From a clean checkout:

```
cd crm
git init -b main
git remote add origin git@github.com:pinekrone-dev/deal-scout.git
git add .
git commit -m "Rewrite as Deal Scout CRM monorepo"
git push -f origin main
```

The backend lives at `apps/api`; there is no separate `deal-scout-api` repo. Cloud Run source deploys point at each subfolder independently.

## OM ingest flow

1. User clicks **Upload OM** on Buildings page, selects PDFs and/or images.
2. Frontend POSTs multipart to `/api/ingest` on the backend. Files are written to Storage under `om_ingestions/{id}/`.
3. Backend kicks off a background task that calls Claude Sonnet 4.6 vision via the Anthropic SDK with the files as `document` (PDFs) or `image` blocks, system prompt instructs strict JSON schema for building, contacts, and TTM financials.
4. Frontend navigates to `/ingest/{id}`, polls `/api/ingest/{id}` every 2 seconds until `extraction_status=done`.
5. User edits extracted fields inline, clicks **Confirm and Create**.
6. Backend creates `buildings` doc, linked `contacts` docs, and a version-1 `underwriting` doc with computed proforma and returns.

## Underwriting math

Implemented in `apps/web/src/underwriting/engine.ts` (frontend reactivity) and `apps/api/app/underwriting.py` (server-side recalculation). Both compute:
- NOI from revenue minus expenses line items
- Proforma year 1 from TTM grown by rent_growth_pct and expense_growth_pct
- Reserves: per-unit capex (multifamily/hospitality), per-SF TI/LC (office/retail/industrial/mixed-use)
- Debt service: standard amortizing mortgage payment
- DSCR: proforma NOI / annual debt service
- CoC year 1: (proforma NOI - reserves - debt service) / equity
- Equity multiple: (equity + sum of hold-period distributions) / equity
- Levered IRR: robust bisection with Newton fallback, on equity cashflows including refi or sale at exit cap

IRR uses numpy (server) and pure TypeScript (client), with sanity-tested textbook result for [-1000, 500, 500, 500] of 23.38%.

## File tree

```
crm/
  README.md
  firebase.json
  firestore.rules
  storage.rules
  .gitignore
  .gcloudignore
  apps/
    web/
      package.json
      Procfile
      .env.example
      .node-version
      .nvmrc
      vite.config.ts
      tailwind.config.js
      postcss.config.js
      tsconfig*.json
      index.html
      serve.json
      src/
        main.tsx
        App.tsx
        index.css
        types/index.ts
        lib/
          firebase.ts
          auth.tsx
          api.ts
          format.ts
        underwriting/engine.ts
        components/
          Shell.tsx
          UnderwritingPanel.tsx
        pages/
          LoginPage.tsx
          BuildingsPage.tsx
          BuildingDetailPage.tsx
          ContactsPage.tsx
          ContactDetailPage.tsx
          DealsPage.tsx
          IngestPage.tsx
          NotFoundPage.tsx
    api/
      requirements.txt
      pyproject.toml
      Procfile
      runtime.txt
      .env.example
      app/
        __init__.py
        config.py
        auth.py
        firebase_admin_client.py
        om_extractor.py
        underwriting.py
        main.py
```

## Verification performed

- `npm install` and `npm run build` in `apps/web` complete successfully on Node 22.
- `pip install -r requirements.txt` in `apps/api` installs FastAPI, anthropic, firebase-admin, numpy, etc.
- FastAPI app imports cleanly and registers all expected routes: `/`, `/healthz`, `/api/ingest`, `/api/ingest/{id}`, `/api/ingest/{id}/confirm`, `/api/underwriting/{id}/calc`.
- IRR unit sanity matches textbook (23.38% for [-1000, 500, 500, 500]).
- Frontend binds on `tcp://0.0.0.0:$PORT` via `serve` as required by Cloud Run.
- Iframe-friendly `Content-Security-Policy: frame-ancestors` headers set on both frontend (via `serve.json`) and backend (middleware).
