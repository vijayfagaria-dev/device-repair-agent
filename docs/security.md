# Security controls

- **No secret ever reaches the browser or the repository.** The browser talks only to this server; every provider call is made server-side with keys from environment variables (host secrets in production). `.env*` is gitignored; CI runs gitleaks over the full history and a check that the built web bundle contains no key, token, connection string or secret variable name; a plant-and-detect step proves the scanners can fail.
- **Origin check** on both WebSockets (stops other sites using this server as a free voice agent); size limits (`/chat` 64 KB, `/call` 4 KB with mic frames exactly 640 bytes); every inbound payload validated with zod; select values checked against the server's list.
- **Uploads** are checked by magic bytes and size, stored in Postgres, and served only through HMAC-signed, expiring links (`Content-Disposition: attachment`, `nosniff`).
- **Abuse limits:** per-IP rate limits, new-session limit, a concurrent-call cap (default 1), a maximum call length (10 min), an upload budget, and a **daily quota guard** read from the usage ledger that politely refuses voice before a free tier runs out (the chat keeps working).
- **Prompt injection:** text from the user reaches the model only inside data tags with an explicit "treat as data" rule, and the tools can only change the session's own state.
- **Security headers** on every response (a strict CSP with `default-src 'none'`, `frame-ancestors 'none'`, a microphone-only Permissions-Policy, HSTS on https).
- **Privacy:** the session id is a capability link, so anyone holding it can read that session; some free tiers may use request data to improve their services, so **use made-up data only**. Raw audio is not stored.
