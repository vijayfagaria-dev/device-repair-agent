// shared/record.schema.json and the TypeScript types must describe the same record (P2-T07 risk: schema/type drift).
import {
  ACCEPTED_FILE_TYPES,
  CALL_FIELDS,
  CHAT_FIELDS,
  DATE_PRECISIONS,
  DEVICE_TYPES,
  RECORD_FIELD_IDS,
  URGENCY_LEVELS,
} from "@device-repair/shared/fields";
import { FieldStatus, Outcome, SESSION_ID_PATTERN } from "@device-repair/shared/protocol";
import schema from "@device-repair/shared/record.schema.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { FIELDS, MAX_FILE_BYTES, MAX_NOTES_CHARS } from "../../src/domain/fields.js";
import { MAX_SUMMARY_CHARS, MAX_VERBATIM_CHARS } from "../../src/domain/validators/voiceFields.js";

// biome-ignore lint/suspicious/noExplicitAny: walking an arbitrary JSON document
const s = schema as any;
const field = (id: string) => s.properties.fields.properties[id];

describe("record schema ↔ TypeScript", () => {
  it("names exactly the catalog's record fields, all required", () => {
    expect(Object.keys(s.properties.fields.properties)).toEqual([...RECORD_FIELD_IDS]);
    expect(s.properties.fields.required).toEqual([...RECORD_FIELD_IDS]);
    expect(s.properties.missingRequired.items.enum).toEqual([...CALL_FIELDS, ...CHAT_FIELDS]);
  });

  it("uses the same enums as the code", () => {
    expect(s.$defs.outcome.enum).toEqual(Object.values(Outcome));
    expect(s.$defs.deviceType.enum).toEqual([...DEVICE_TYPES]);
    expect(s.$defs.urgency.properties.level.enum).toEqual([...URGENCY_LEVELS]);
    expect(s.$defs.problemStartedAt.properties.precision.enum).toEqual([...DATE_PRECISIONS]);
    expect(s.$defs.file.properties.mime.enum).toEqual([...ACCEPTED_FILE_TYPES]);
    expect(s.$defs.file.properties.size.maximum).toBe(MAX_FILE_BYTES);
    expect(s.properties.sessionId.pattern).toBe(SESSION_ID_PATTERN.source);
  });

  it("allows the statuses each field can really have", () => {
    for (const id of RECORD_FIELD_IDS) {
      const expected = ["valid", "invalid", "missing"];
      if (FIELDS[id].authority === "chatOnly") expected.push("unverified");
      if (!FIELDS[id].required) expected.push("skipped");
      expect(field(id).properties.status.enum, id).toEqual(expected);
      for (const status of field(id).properties.status.enum) expect(Object.values(FieldStatus), id).toContain(status);
    }
  });

  it("uses the validators' length limits", () => {
    expect(s.$defs.additionalNotes.maxLength).toBe(MAX_NOTES_CHARS);
    expect(s.$defs.problemDescription.properties.summary.maxLength).toBe(MAX_SUMMARY_CHARS);
    expect(s.$defs.problemDescription.properties.verbatim.maxLength).toBe(MAX_VERBATIM_CHARS);
  });

  it("is a closed, draft 2020-12 schema", () => {
    expect(s.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.schemaVersion.const).toBe("1.0");
  });
});
