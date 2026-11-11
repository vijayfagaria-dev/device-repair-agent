"""Barge-in confirmation (P5-T07, architecture section 6).

While the agent is audible, the user's speech interrupts it only once it is clearly speech, not echo or a cough: at
least ``min_words`` interim words, or at least one word with ``min_speech_ms`` of continuous speech. The first
``ignore_agent_ms`` of each agent turn's audio are ignored (the tail of the user's own turn and the speaker's onset
echo). Deepgram's voice-activity event alone never confirms: it also fires on echo. All three thresholds are
configurable (tuning for R2, echo without headphones).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BargeInSettings:
    min_words: int = 2
    min_speech_ms: float = 400
    ignore_agent_ms: float = 250


DEFAULT_BARGE_IN = BargeInSettings()


@dataclass(frozen=True, slots=True)
class BargeInFacts:
    #: When the agent turn's first audio was sent (None: nothing audible yet).
    agent_audible_since: float | None
    #: The agent turn still has audio playing or coming.
    agent_speaking: bool
    #: When the user's voice activity began (None: not speaking).
    user_speech_since: float | None
    #: Words heard so far in the user's utterance.
    words: int
    now: float


def should_barge_in(facts: BargeInFacts, settings: BargeInSettings = DEFAULT_BARGE_IN) -> bool:
    if not facts.agent_speaking or facts.agent_audible_since is None:
        return False
    if facts.now - facts.agent_audible_since < settings.ignore_agent_ms:
        return False
    if facts.words >= settings.min_words:
        return True
    return (
        facts.words >= 1
        and facts.user_speech_since is not None
        and facts.now - facts.user_speech_since >= settings.min_speech_ms
    )
