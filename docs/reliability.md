# Reliability and edge cases

## Handled

Each of these has an automated test; the scenario tests drive a real server through both sockets with fake providers.


- A card answered while the call is on, and the agent acknowledging it; a rejected or cancelled card reaching the call.
- The call dropping at any point, then finishing in chat; a returning call that knows what was collected and the last question asked.
- Invalid answers (three attempts, then no more asking and a review flag); a duplicate submit; a stale card answered after it was cancelled.
- The same answer from both channels (agreement) and different answers (resolved by policy and recorded).
- A reload mid-session, a second tab, a chat reconnect without a reload (no duplicate thread items, the open card reconciled).
- A server restart with a live call and a card open; a record that must not be produced or delivered twice; delivery retries; an outbox row left leased by a dead worker.
- An idle `partial` user returning to finish (revision 2, revision 1 untouched); opt-out by call and by chat, and a resume offer afterwards.
- Uploads: a renamed `.exe`, an empty file, a file over 10 MB, a forged select value, a tampered or expired file link.
- Provider failures: the model rate-limited or down (next model, then Gemini), STT dropping (one reconnect, then the call ends and chat continues), TTS errors, an exhausted free-tier quota (voice politely refused, chat still works).
- Abuse: foreign Origin, oversized or malformed frames, floods of messages, many new sessions from one IP, concurrent calls beyond the cap.

## Known gaps

- **No "which is correct?" card for an identifier conflict.** The resolver detects it and marks it unresolved, so today it ends in `needsReview` (R-2) without asking the user.
- **A typed edit of a narrative field** (problem, start date, urgency) on the edit card is not offered, because the spoken account wins by policy.
- **English only.** The date resolver has no festival names ("around Diwali" is re-asked) and no "last year". Aura-2 has no Indian-accent voice.
- **An opted-out user** is offered "Resume your claim?" only when they try to call again; chat has no other control for it.
- **A silent session with no activity at all** never finalizes (only the no-call timer runs).
- **Cold start:** the free Render instance sleeps when idle (about a minute to wake), and the first call after a long quiet period can start slowly. There is deliberately no keep-alive monitor.
- **Single instance:** the rate limiter, the call cap and the quota override live in process memory. Two instances during a deploy overlap stay consistent for session data (row locks, `SKIP LOCKED`), but not for these limits.
- **Free-tier ceilings:** the Groq limit (8,000 tokens a minute per model) caps concurrent calls at 1 by default; Neon's 1 GB and 100 compute-hours bound the data and the always-on time.
- **The call's live state does not survive a restart:** the call ends and the user taps Call again (a new call resumes from state; no automatic redial).
- **Vision checks of uploads, other languages, the debug view and the post-review data purge** are not built.

## What I trust least

1. **The model's choices on a real call.** Tool handling, grounding, the speech filter and the turn rules are covered by tests built from real failing sessions, but the model itself is a free-tier 20B model: whether it asks for cards at good moments and how it phrases things are only checked by hand. Because Riya's wording is the model's own, she can still repeat herself or phrase something oddly; the guards limit the damage, not the style.
2. **Barge-in latency from the reviewer's network.** The stop-after-speech-onset budget (1.0 s) measured 1.40–1.48 s from India in the spike, because Deepgram detects words late from there. It may miss on the deployed check.
3. **The free tiers themselves.** Their limits are not guaranteed, and an outage or a spent quota degrades the call to chat-only (by design, but a worse demo).
4. **The browser latency probe.** Its thresholds are untested guesses, and the number is noisy with speakers.
5. **The free Render instance:** it sleeps when idle, and its restart behaviour and proxy headers (client IP) rely on free-tier terms that can change.
