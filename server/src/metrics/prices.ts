// Paid-tier list prices (D20, P3-T07). Actual spend is $0: every provider runs on its free tier (constraint C1).
// These rates turn the usage ledger into a "list-price equivalent": what the same usage would cost on each
// provider's published pay-as-you-go plan. Each entry names its source page and the date it was read.
// Neon (database) and Render (hosting) are $0 at this scale and have no meters here.

export type CostCategory = "stt" | "llm" | "tts" | "vision";
export type UsageProvider = "deepgram" | "groq" | "gemini";

export interface Price {
  provider: UsageProvider;
  /** The ledger's `kind`: `<model>:<meter>`. */
  kind: string;
  /** What `units` counts in the ledger. */
  unit: "second" | "character" | "token" | "request";
  category: CostCategory;
  /** The published rate: `usd` per `per` units (e.g. $0.0077 per 60 seconds). */
  usd: number;
  per: number;
  source: string;
  /** When the rate was read from `source` (YYYY-MM-DD). */
  checkedOn: string;
  note?: string;
}

const CHECKED_ON = "2026-11-10";
const DEEPGRAM = "https://deepgram.com/pricing";
const GROQ = "https://console.groq.com/docs/models";
const GEMINI = "https://ai.google.dev/gemini-api/docs/pricing";
const MILLION = 1_000_000;

/** LLM models (D06): the primary, the Groq fallback and the Gemini last resort. Request counts are free meters. */
function llm(provider: "groq" | "gemini", model: string, input: number, output: number, cachedInput: number, source: string, note?: string): Price[] {
  const base = { provider, unit: "token" as const, category: "llm" as const, per: MILLION, source, checkedOn: CHECKED_ON, ...(note ? { note } : {}) };
  return [
    { ...base, kind: `${model}:input`, usd: input },
    { ...base, kind: `${model}:cachedInput`, usd: cachedInput },
    { ...base, kind: `${model}:output`, usd: output },
    { ...base, kind: `${model}:requests`, unit: "request", usd: 0, per: 1, note: "request count for the daily quota guard; not billed" },
  ];
}

const LIST: Price[] = [
  {
    provider: "deepgram",
    kind: "nova-3:audio",
    unit: "second",
    category: "stt",
    usd: 0.0077,
    per: 60,
    source: DEEPGRAM,
    checkedOn: CHECKED_ON,
    note: "Nova-3 Monolingual streaming, Pay as you go: $0.0077/min, billed per second with no rounding",
  },
  {
    provider: "deepgram",
    kind: "aura-2:characters",
    unit: "character",
    category: "tts",
    usd: 0.03,
    per: 1000,
    source: DEEPGRAM,
    checkedOn: CHECKED_ON,
    note: "Aura-2, Pay as you go: $0.030 per 1,000 characters of input text",
  },
  ...llm("groq", "openai/gpt-oss-20b", 0.075, 0.3, 0.075, GROQ, "Groq lists no cached-input rate; cached tokens are priced at the input rate (an upper bound)"),
  ...llm("groq", "openai/gpt-oss-120b", 0.15, 0.6, 0.15, GROQ, "Groq lists no cached-input rate; cached tokens are priced at the input rate (an upper bound)"),
  ...llm(
    "gemini",
    "gemini-flash-lite-latest",
    0.3,
    2.5,
    0.03,
    GEMINI,
    "paid Standard tier of Gemini 3.5 Flash-Lite, the newest Flash-Lite listed; Google doesn't publish which model the -latest alias points to",
  ),
];

export const PRICES: readonly Readonly<Price>[] = Object.freeze(LIST.map((price) => Object.freeze(price)));

export function findPrice(provider: string, kind: string): Readonly<Price> | null {
  return PRICES.find((price) => price.provider === provider && price.kind === kind) ?? null;
}

/** Cost decimals stored in usage.cost_usd (numeric(14, 8)). */
export const COST_DECIMALS = 8;

/** List-price cost of `units` at `price`, rounded to the ledger's precision. */
export function listPriceUsd(price: Pick<Price, "usd" | "per">, units: number): number {
  const scale = 10 ** COST_DECIMALS;
  return Math.round(((units * price.usd) / price.per) * scale) / scale;
}
