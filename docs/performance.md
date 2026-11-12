# Cost and latency

<!-- measured:start -->
> **`PENDING`: no measurement from real sessions exists yet.** The tooling is built and tested (`scripts/report.py`), but a report needs at least 10 completed real sessions and at least 50 voice turns. No cost or latency figure is claimed until it has run on the deployed system.
<!-- measured:end -->

## Cost

**How cost is worked out.** Every billable unit is a row in a usage ledger, priced when inserted at the provider's published paid list price (`app/metrics/prices.py`, each entry with its source URL and the date it was read, 2026-11-10). Actual spend is **$0** because every provider is on a free tier; the reported figure is the **list-price equivalent**:

| Meter | List price used |
|---|---|
| Deepgram Nova-3 streaming STT | $0.0077 per minute (billed per second) |
| Deepgram Aura-2 TTS | $0.030 per 1,000 characters |
| Groq `openai/gpt-oss-20b` | $0.075 in / $0.30 out per 1M tokens |
| Groq `openai/gpt-oss-120b` (fallback) | $0.15 in / $0.60 out per 1M tokens |
| Gemini `gemini-flash-lite-latest` (last resort, priced as Gemini 3.5 Flash-Lite) | $0.30 in / $2.50 out / $0.03 cached per 1M tokens |
| Neon, Render | $0 at this scale |

Assumptions that move the number: Groq lists no cached-input rate, so cached tokens are priced at the input rate (an upper bound); Google does not publish which model the `-latest` alias points to. A session's cost is the exact sum of its ledger rows and is written into its record (`costUsd`, with `costBreakdownUsd`).

## Latency

**How latency is measured.** The primary number is **server-side**: from the STT end-of-utterance event (Deepgram `speech_final`) to the first TTS audio frame written to the socket, for every agent reply that follows a user utterance, with stage timings beside it (the merge wait, the model's first token, TTS's first byte). A secondary, noisy **browser-side** number (mic level below a threshold for 300 ms after speech, to the first agent audio scheduled to play) is reported separately. Percentiles are nearest rank, so every p50 and p95 is an observed value. The report states n, the dates, the region, the browsers and whether headphones were worn.

**What exists today** (a spike, not a measurement of this system): a laptop on home Wi-Fi in India, 20 runs of the same pipeline per variant, speech end to first audio byte, measured against the providers directly: **1,656 ms p50 / 1,768 ms p95** with the acknowledge-then-ask design, versus 2,311 / 2,513 ms when waiting for the model's follow-up speech. These include two round trips from the laptop to Deepgram that the deployed server will not have; the spike's own conservative estimate for the deployed system is about 1.3–1.4 s p50. **That estimate is not a measurement.**

To produce the real numbers once deployed: run the sessions, then `DATABASE_URL=<Neon URL> uv run python scripts/report.py --region "…" --browsers "…" --headphones yes`. It reads the database in a read-only transaction.
