# SecondShift backend (tiny version)

Endpoints (all `/tools/*` and `/debug/*` need `Authorization: Bearer $TOOL_TOKEN`):

- `GET  /health` – no auth, liveness check
- `GET  /tools/ping` – harmless tool for CREAO to call
- `POST /tools/submit_investigation` – logs and stores whatever JSON it receives
- `GET  /debug/submissions` – shows what has been submitted

## Run

    cp .env.example .env     # then set TOOL_TOKEN (openssl rand -hex 24)
    npm install
    npm run dev

## Expose to CREAO

    ngrok http 3000          # or: cloudflared tunnel --url http://localhost:3000

Save the public https URL as `BACKEND_URL` and the token as `BACKEND_TOKEN` in CREAO's Secrets.
