# Product and technical decisions

Where the brief left room, these are the choices made and the reasoning behind them.

| Decision | Why |
|---|---|
| The scenario is a **device repair claim**, with the call and chat split above | Spoken fields are easy to say; identifiers and files are exactly what speech recognition gets wrong |
| **Completion needs an explicit "Submit claim?" tap in chat** | The business receives a confirmed record, and a misheard "yes" cannot submit it |
| **Identifiers must be typed.** A serial number or email heard on the call is saved as `unverified` and the agent asks for it in the chat | Speech recognition is unreliable for alphanumerics |
| **One page, one session.** The call and chat share the starter's single page; the same session link works in a second tab | Matches the brief's UI and makes reconnects trivial |
| **A header Stop button** opens a confirmation card; only Yes opts out (the chat has no free-text field) | An accidental tap cannot end a claim |
| **Silence:** a re-prompt at 8 s; after two, the call ends and the chat continues | A quiet line should not hang the session, and the chat can finish the job |
| **Safety first:** a swollen battery, smoke, burning smell or liquid while charging makes the agent advise stopping use and flags `needsReview` | A hazard matters more than a complete form |
| **Consent line:** the call opens with a note that it is processed as text; raw audio is never stored | Privacy by default |
| **Service centres are a fictional list** ("… Demo Repair Centre") | No real business is impersonated |
| A customer **who never calls** still gets the chat: after 2 minutes without a call it starts with a message and the first card | The chat alone must be able to finish a claim |
| **Retention:** data is kept until a review period ends, then should be purged | No purge script is built yet (see [reliability](reliability.md)) |
