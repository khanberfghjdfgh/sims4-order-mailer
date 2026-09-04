# Sims4 Order Mailer v2

Automatically emails the game (banner + torrent) to Etsy buyers whose subject reads "Order confirmation" and mentions Sims. Runs 24/7 on a free Koyeb server — no PC, no internet on your end needed.

## Why v2?

The old Cloudflare version used **Gmail OAuth**, whose refresh tokens expire after ~7 days in "Testing" mode. Re-authorizing required your PC to be online — which is exactly what breaks when you're offline.

v2 uses **Gmail IMAP + SMTP with an App Password** instead:

- App passwords **never expire** → no re-authorization ever needed.
- Logs to a local SQLite file (`sql.js`, no native build).
- Polls Gmail every 2 minutes.
- Sends you a **daily summary email** instead of exposing a web dashboard publicly.

## Security design (the important part)

- **Zero public attack surface.** The cloud worker runs as a Koyeb *worker* — it listens on NO port and cannot be reached by anyone, ever. It only makes outbound connections to Gmail (IMAP/SMTP).
- **The dashboard exists ONLY on this PC.** It binds to `127.0.0.1`, so it is not reachable from your Wi-Fi network, let alone the internet.
- **Token required even on localhost.** Without the `ACCESS_TOKEN`, every page returns 403.
- **Constant-time token comparison** (`crypto.timingSafeEqual`) — immune to timing attacks.
- **Brute-force lockout.** 5 wrong tokens → 15 minute lock for that IP.
- **Rate limiting.** 30 requests/minute per source.
- **XSS-proof.** Every dynamic value (subjects, errors, log lines come from buyer-emails) is HTML-escaped before rendering, and a strict Content-Security-Policy is applied.
- **Security headers** on every response: CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `Cache-Control: no-store`, permissions policy.
- **No web framework.** The dashboard uses Node's built-in `http` only — no express/qs/body-parser dependency chain to exploit.
- **`npm audit`: 0 vulnerabilities.**
- **Secrets never logged or committed** (`.env`, `data/`, `node_modules/` are gitignored; `GMAIL_APP_PASSWORD` is never printed).

Monitoring is done via the **daily summary email** to your own Gmail inbox (delivered/sent, failed, needs-manual counts + recent failure details).

## 1. One-time setup on Google

1. Enable 2-Step Verification (Security → 2-Step Verification).
2. Go to **Security → App passwords** and create one (choose "Mail" + any device).
3. Note the 16-character password like `abcd efgh ijkl mnop`.

This app password can only read/send email. It cannot change account settings.

## 2. Test locally on this PC

```bash
cd v2
npm install
# edit .env: put your real GMAIL_APP_PASSWORD and an ACCESS_TOKEN
npm start
```

Open `http://localhost:3000/?token=YOURTOKEN` — you'll see live scan results.

`.env` defaults keep the PC copy in **monitor-only** mode (`ALLOW_SEND=false`), so the local instance detects and logs but never sends — no risk of duplicate deliveries while you evaluate.

Logic sanity check:

```bash
npm test
```

## 3. Deploy to Koyeb (free, no credit card)

1. Push the `v2` folder to a GitHub repo (make sure `.env` and `data/` are NOT included — `.gitignore` handles this).
2. Sign up at **koyeb.com** (free tier, no card).
3. Create a **Worker** service from your GitHub repo (Docker build). Use `koyeb.yaml` as the service config.
4. Set env vars:
   - `GMAIL_ADDRESS` = you@gmail.com
   - `GMAIL_APP_PASSWORD` = your 16-char app password
   - `OWNER_EMAIL` = you@gmail.com (for the daily summary)
   - `DISABLE_DASHBOARD` = `true` (default in koyeb.yaml — no listener)
   - `ALLOW_SEND` = `true`
   - `POLL_INTERVAL_MS` = `120000`
5. Deploy. Koyeb keeps it running forever with no public URL, no ports, no access.

Because it's a Koyeb *worker* with no exposed port, it is completely unreachable from the outside — it only talks to Gmail.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GMAIL_ADDRESS` | — | Your Gmail (IMAP/SMTP login) |
| `GMAIL_APP_PASSWORD` | — | 16-char app password (secret) |
| `OWNER_EMAIL` | `GMAIL_ADDRESS` | Daily summary recipient |
| `ACCESS_TOKEN` | — | Dashboard token (REQUIRED) |
| `ALLOW_SEND` | `true` | `false` = detect + log only, never send |
| `DISABLE_DASHBOARD` | `false` | `true` = no web listener at all (cloud) |
| `POLL_INTERVAL_MS` | `120000` | Scan interval |
| `SUMMARY_INTERVAL_MS` | `43200000` | Daily summary interval (12h) |
| `BANNER_PATH` / `TORRENT_PATH` | `./assets/…` | Asset file locations |
| `TORRENT_FILENAME` | real name | Attachment filename in the email |
| `PORT` | `3000` | Local dashboard port |
| `DB_PATH` | `./data/mailer.db` | SQLite file location |

## Assets

- `assets/email_banner.gif` — banner at the top of the email.
- `assets/torrent.torrent` — the delivery attachment.

Overwrite these with your own copies if needed.

## Notes

- Gmail sending limits (500 recipients/day) still apply; fine for a small shop.
- To stop everything: delete the Koyeb service and revoke the app password in Google.
- Keep the app password secret. It's the only credential the server has.