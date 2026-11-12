# Architecture in detail

```
Browser (React, the starter UI, same origin)
  ├─ WS /call  : mic PCM16 16 kHz in, agent PCM16 24 kHz + live transcript lines out
  └─ WS /chat  : cards, messages, record out; answers, Stop, latency samples in
        │
Python 3.13 server (FastAPI + uvicorn, one process, Render free web service)
  ├─ Call engine   STT stream → turn detection → LLM (tools) → sentence chunks → TTS → audio frames
  ├─ Command processor  every state change is one command: row lock → transaction → events → publish
  ├─ Chat planner  idempotent reconciler: decides which card is open, from state alone
  ├─ Record builder + outcome machine (pure code, no I/O) · Outbox worker · Sweeper (persisted timers)
  └─ Session hub   in-process fan-out to every socket of a session
        │
Neon Postgres: sessions, events, field candidates, input requests, chat messages, transcript lines,
calls, files, usage ledger, turn metrics, records, outbox, timers, received records
Deepgram (Nova-3 STT, Aura-2 TTS) · Groq (gpt-oss-20b, then gpt-oss-120b) · Gemini (last-resort fallback)
```

## One conversation, two channels

The two sockets are views of one session, keyed by a client-generated UUIDv4 (the id is the capability; the server creates the session lazily on the first valid connect or upload). There is no per-channel state, which is what keeps the channels from drifting apart:

- **Every change is a command**, run by one processor: it takes the session's row lock (`SELECT … FOR UPDATE`), writes in a transaction (state tables plus an append-only `events` row), and **publishes after commit**. The call engine and the chat socket both submit commands; neither writes tables directly.
- **Collected values are candidates, never overwrites.** A value from the call or from a card appends a `field_candidates` row. The *effective* field (value, source, status) and any conflict are recomputed from those rows by a resolver each time.
- **Chat during a call.** A submitted card commits, the hub publishes, and the call engine, subscribed to the session, hands the event to the model in its next state message. The agent acknowledges it at a natural moment: when it is idle and the customer has been quiet for 1.2 s. Rejected or cancelled cards are reported the same way.
- **When the call ends** (hang-up, dropped socket, `end_call`, server restart), `EndCall` commits and a post-commit reconcile opens the next missing card in chat. Reconcile also runs on every chat connect and at boot, so a crash between the two steps cannot strand a session.
- **Chat reconnects** replay the history, the open card and the latest record from the database, subscribing to live events first so nothing committed during the replay is lost.
- **A restart loses nothing.** State, files, timers and the delivery outbox are in Postgres. At boot the server marks dangling calls ended (`server_restart`), re-arms timers, reclaims expired outbox leases, reconciles active sessions, and only then starts listening.

## The call agent

The call is a cascaded pipeline run on the server. Deepgram streams speech to text, and the STT end-of-utterance event marks the end of the customer's turn. The model answers with tool calls (`save_field`, `request_chat_input`, `flag_for_review`, `opt_out`, `end_call`), each validated server-side before anything runs. Reply text is cut into sentences and streamed to Deepgram Aura-2, and every audio frame carries the agent-turn id so late frames of a cancelled turn are dropped.

gpt-oss-20b mostly answers with tool calls and no speech, so code speaks a templated acknowledgement built from the validated calls ("Got it, Apple iPhone 14.") while the model writes the next question. That "acknowledge, then ask" shape is what keeps the reply latency down (see [performance](performance.md)).

**Barge-in.** When speech starts while the agent is talking, with at least two interim words or 400 ms of voice (which filters out echo and coughs), the server first stops forwarding audio and sends `stopPlayback`, then aborts the model, and truncates the agent's transcript line to what the customer actually heard, marked `[interrupted]`.

**The transcript follows the voice.** Each sentence appears in the transcript when its audio starts playing, not when it is synthesised, so the text never runs ahead of what the customer hears. The server tracks the playback position per sentence for this, and for the truncation above.

## Keeping the model honest

Riya's voice is the model's own: she greets the customer warmly, introduces herself by name, acknowledges what she hears and phrases her questions in her own words. The code does not script her. It guards the places where a small free-tier model, left to write speech and call tools in one generation, did real damage in recorded sessions: it saved values nobody said, read its own markup aloud, asked the same question again after a failed tool call, and spoke after the customer had already acted. Each guard exists because a recorded session broke it:

- **Saved values must be grounded.** `save_field` carries the customer's exact words as evidence; the server only accepts it when those words appear in the customer's last few utterances. A made-up urgency, a description nobody gave, or markup copied from the state message is rejected quietly, and the model is told to ask instead.
- **No second round after the model has asked something.** The engine used to call the model again after a failed tool call, which made it ask the same question up to three times in one turn. Once the model has asked, that turn is over; nothing it says is cut.
- **Speech is cleaned before it is spoken or stored.** Markup and markdown (`**Yes**` would be read as "star star yes"), zero-width characters, runaway filler and internal names such as `deviceModel` or `pendingChatCards` are removed or turned into plain words, and glued sentences are separated. A reply that degenerates into filler is cut off.
- **Stale text is dropped.** If a chat event arrives while the model is writing, text drafted from the older state is not spoken (it would ask for what the customer has just typed); the event gets its own turn with fresh state.
- **A broken stream is retried once**, told where it was cut off, so a dropped connection does not leave the line silent mid-sentence.
- **Speech recognition is primed** with the repair vocabulary (device types, brands, damage words) through Deepgram keyterms, which helps with mishearings such as "Riya" becoming "Reuters".
- **One call per claim.** A second call attempt for a claim whose call is still running is told so ("a call is already running for this claim") instead of being reported as the voice line being busy.

Most of these have regression tests built from the transcripts of the failing sessions.
