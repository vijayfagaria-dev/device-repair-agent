// Barge-in confirmation (P5-T07, architecture §6). While the agent is audible, the user's speech interrupts it only
// once it is clearly speech, not echo or a cough: at least `minWords` interim words, or at least one word with
// `minSpeechMs` of continuous speech. The first `ignoreAgentMs` of each agent turn's audio are ignored (the tail of
// the user's own turn and the speaker's onset echo). Deepgram's voice-activity event alone never confirms: it also
// fires on echo. All three thresholds are configurable (tuning for R2, echo without headphones).
export interface BargeInSettings {
  minWords: number;
  minSpeechMs: number;
  ignoreAgentMs: number;
}

export const DEFAULT_BARGE_IN: BargeInSettings = { minWords: 2, minSpeechMs: 400, ignoreAgentMs: 250 };

export interface BargeInFacts {
  /** When the agent turn's first audio was sent (null: nothing audible yet). */
  agentAudibleSince: number | null;
  /** The agent turn still has audio playing or coming. */
  agentSpeaking: boolean;
  /** When the user's voice activity began (null: not speaking). */
  userSpeechSince: number | null;
  /** Words heard so far in the user's utterance. */
  words: number;
  now: number;
}

export function shouldBargeIn(facts: BargeInFacts, settings: BargeInSettings = DEFAULT_BARGE_IN): boolean {
  if (!facts.agentSpeaking || facts.agentAudibleSince === null) return false;
  if (facts.now - facts.agentAudibleSince < settings.ignoreAgentMs) return false;
  if (facts.words >= settings.minWords) return true;
  return facts.words >= 1 && facts.userSpeechSince !== null && facts.now - facts.userSpeechSince >= settings.minSpeechMs;
}
