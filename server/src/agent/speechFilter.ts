// Cleans the model's streamed text before it is spoken or recorded. Real gpt-oss-20b calls leaked prompt markup
// (`<customer_words field="deviceModel">`), emitted runs of zero-width characters, whitespace and ellipses for
// seconds, and glued sentences together ("chat.When"). This is stateful because markup and sentences span deltas.

import { RECORD_FIELD_IDS } from "@device-repair/shared/fields";
import { FIELDS } from "../domain/fields.js";

/** Internal names the model must never say aloud: field ids become their spoken label, state keys vanish. */
const FIELD_NAMES = new Map<string, string>([...RECORD_FIELD_IDS.map((id): [string, string] => [id, FIELDS[id].label]), ["submitConfirmation", "confirmation"], ["optOutConfirmation", "confirmation"]]);
const STATE_KEYS = ["heardButMustBeTyped", "pendingChatCards", "readyToSubmit", "claimStatus", "isReturningCall", "newChatEvents", "givenUp", "callSecondsElapsed", "lastQuestionOnPreviousCall", "localTime", "request_chat_input", "save_field", "flag_for_review", "opt_out", "end_call", "spoken_evidence", "user_confirmed"];
const INTERNAL = new RegExp(`\\b(?:${[...FIELD_NAMES.keys(), ...STATE_KEYS].join("|")})\\b`, "g");
const hideInternal = (text: string): string => text.replace(INTERNAL, (name) => FIELD_NAMES.get(name) ?? "").replace(/ {2,}/g, " ");

/** Zero-width and bidi-control characters: never meaningful in speech. */
const INVISIBLE = /[​-‏⁠-⁤‪-‮﻿­]/g;
/** Markdown emphasis and code marks: a voice reads "**Yes**" as "star star yes". */
const MARKDOWN = /[*`]+|~~/g;
/** A tag that was not closed within this many characters is plain text, not markup. */
const MAX_TAG = 160;
/** Consecutive filler (whitespace, dots, ellipses) beyond this means the model is looping. */
const MAX_JUNK_RUN = 12;

export class SpeechFilter {
  #pendingTag = "";
  /** The unfinished last word of the previous delta: held until the next one so a name split in two is still seen. */
  #word = "";
  #lastChar = "";
  #lastNonSpace = "";
  #junkRun = 0;
  /** The model is producing runaway filler: the caller should stop reading the stream. */
  degenerate = false;

  /** Cleaned text for one streamed delta ("" while it is inside a tag or only filler). */
  push(delta: string): string {
    let input = this.#pendingTag + this.#word + delta.replace(INVISIBLE, "").replace(MARKDOWN, "");
    this.#word = "";
    this.#pendingTag = "";
    let out = "";
    while (input.length > 0) {
      const open = input.indexOf("<");
      if (open === -1) {
        out += input;
        break;
      }
      out += input.slice(0, open);
      const close = input.indexOf(">", open);
      if (close === -1) {
        const rest = input.slice(open);
        if (rest.length > MAX_TAG) {
          out += rest.replace("<", " ");
        } else this.#pendingTag = rest; // possibly the start of a tag; wait for more
        break;
      }
      input = input.slice(close + 1);
    }
    const tail = /[A-Za-z0-9_]+$/.exec(out)?.[0] ?? "";
    this.#word = tail;
    return hideInternal(this.#tidy(out.slice(0, out.length - tail.length)));
  }

  /** What is left at the end of the stream (an unfinished tag is dropped). */
  flush(): string {
    this.#pendingTag = "";
    const word = this.#word;
    this.#word = "";
    return word ? hideInternal(this.#tidy(word)) : "";
  }

  /** Trailing dots in `text`. */
  #dotsRun(text: string): number {
    return /\.*$/.exec(text)?.[0].length ?? 0;
  }

  #tidy(text: string): string {
    let result = "";
    for (const ch of text) {
      if (/[\s.…]/.test(ch)) {
        this.#junkRun++;
        if (this.#junkRun > MAX_JUNK_RUN) this.degenerate = true;
      } else this.#junkRun = 0;
      const prev = result.length > 0 ? result.at(-1) ?? "" : this.#lastChar;
      // Whitespace runs become one space; ellipsis runs become one.
      if (/\s/.test(ch)) {
        if (prev === "" || /\s/.test(prev)) continue;
        result += " ";
        continue;
      }
      if (ch === "…" || ch === ".") {
        const tail = result.trimEnd();
        const before = tail.length > 0 ? tail.at(-1) ?? "" : this.#lastNonSpace;
        // An ellipsis never follows another dot or ellipsis (even across a space); a plain "." run stops at three.
        if (before === "…" || (before === "." && (ch === "…" || result.length !== tail.length || /\.\.\.$/.test(tail) || this.#dotsRun(result) >= 3))) continue;
      }
      // "chat.When" → "chat. When"
      if (/[A-Z]/.test(ch) && /[.!?]/.test(prev) && result.length > 1 && !/[A-Z]/.test(result.at(-2) ?? "")) result += " ";
      else if (/[A-Z]/.test(ch) && /[.!?]/.test(prev) && result.length === 0 && this.#lastChar !== "") result += " ";
      result += ch;
    }
    if (result.length > 0) this.#lastChar = result.at(-1) ?? this.#lastChar;
    const visible = result.trimEnd();
    if (visible.length > 0) this.#lastNonSpace = visible.at(-1) ?? this.#lastNonSpace;
    return result;
  }
}

/** One-shot cleaning (tests and non-streaming uses). */
export function cleanSpeech(text: string): string {
  const filter = new SpeechFilter();
  return (filter.push(text) + filter.flush()).trim();
}
