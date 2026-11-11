// The record's engagement block (architecture §7, P6-T01): how much the user engaged, from the session's calls,
// chat messages, chat answers and card attempts. Pure.
import type { Engagement } from "./record.js";

export interface EngagementInput {
  calls: readonly { startedAt: Date; endedAt: Date | null }[];
  /** Chat messages in the thread (agent and user). */
  chatMessages: number;
  /** Answers the user submitted in chat cards, valid or not. */
  chatAnswers: number;
  /** Invalid answers across all cards (input_requests.attempts). */
  invalidAttempts: number;
  /** For a call still in progress. */
  now: Date;
}

export function computeEngagement({ calls, chatMessages, chatAnswers, invalidAttempts, now }: EngagementInput): Engagement {
  let callSeconds = 0;
  for (const call of calls) {
    const end = call.endedAt ?? now;
    callSeconds += Math.max(0, Math.round((end.getTime() - call.startedAt.getTime()) / 1000));
  }
  return { calls: calls.length, callSeconds, chatMessages, chatInputsSubmitted: chatAnswers, invalidAttempts };
}
