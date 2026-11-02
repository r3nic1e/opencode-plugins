const sessionID = { type: "string", minLength: 1 } as const;
const reference = { type: "string", minLength: 1, maxLength: 100 } as const;

export const EvidenceRPC = {
  id: "evidence",
  methods: {
    list: {
      input: {
        type: "object", additionalProperties: false, required: ["sessionID"],
        properties: { sessionID, after: { type: "string" } },
      },
      output: { type: "object" },
    },
    get: {
      input: {
        type: "object", additionalProperties: false, required: ["sessionID", "reference"],
        properties: { sessionID, reference },
      },
      output: { type: ["object", "null"] },
    },
    check: {
      input: {
        type: "object", additionalProperties: false, required: ["sessionID", "references"],
        properties: { sessionID, references: { type: "array", maxItems: 1000, items: reference } },
      },
      output: { type: "object" },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object", additionalProperties: false, required: ["record"],
        properties: { record: { type: "object" } },
      },
    },
  },
} as const;
