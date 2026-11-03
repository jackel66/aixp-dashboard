# AIxP Dashboard

Executive web view of AI platform economics (Anthropic, OpenAI, GitHub Copilot,
Copilot Cowork): spend, consumption, active users, organisational attribution and
data verification. v1 runs on generated fixture data shaped to the AI Platform
Economics model contract; a file importer is a later addition behind the same
staging and promote seam.

Standing caveat: this is a directional view of AI spend. It may not reconcile to
actual invoices or Finance-reported expense and must not be used for budget
reconciliation.

## Run

    cd backend && npm install && npm start      # http://localhost:3090
    cd frontend && npm install && npm run dev   # http://localhost:5190 (proxies /api)

Build the frontend with `npm run build` in frontend/; the backend serves dist/.
pm2: `pm2 start ecosystem.config.js` (app aixp-dashboard, port 3090).
Set APP_PASSWORD to require a sign-in.

## Layout

- backend/   Express 4 + better-sqlite3, node --test suite in backend/tests
- frontend/  React 18 + Vite 5 + Tailwind 4 + Chart.js 4 + framer-motion 11
- docs/      CONTRACT.md (binding build contract), API.md (route reference)
- ProjectPrimer  the source SME guide the column contract and checks come from
