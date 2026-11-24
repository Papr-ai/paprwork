import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mcpInputSchemaToZod } from "../../../../src/gateway/services/mcp/mcpToolAdapter.js";

const wire = (schema: Record<string, unknown> | undefined) =>
  z.toJSONSchema(mcpInputSchemaToZod(schema), { io: "input", unrepresentable: "any" }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };

// Shape of Amplitude's use_amplitude_chart_monitors: empty top-level properties, everything in anyOf.
const amplitudeMonitors = {
  type: "object",
  properties: {},
  anyOf: [
    { type: "object", properties: { action: { type: "string" }, projectId: { type: "string" }, limit: { type: "number" } }, additionalProperties: false },
    { type: "object", properties: { action: { type: "string" }, chartId: { type: "string" } }, required: ["action"], additionalProperties: false },
    { type: "object", properties: { action: { type: "string" }, chartId: { type: "string" }, frequency: { type: "string" } }, required: ["action", "chartId"], additionalProperties: false },
  ],
};

describe("mcpInputSchemaToZod: provider-safe top-level schema", () => {
  it("flattens a top-level anyOf into one object that still lists every parameter", () => {
    const out = wire(amplitudeMonitors);
    expect(out.type).toBe("object");
    expect(Object.keys(out.properties ?? {}).sort()).toEqual(["action", "chartId", "frequency", "limit", "projectId"]);
  });

  it("only requires fields every branch requires", () => {
    const out = wire(amplitudeMonitors);
    // first branch requires nothing, so nothing is required overall
    expect(out.required).toBeUndefined();
    const all = wire({ anyOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, { properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] }] });
    expect(all.required).toEqual(["a"]);
  });

  it.each([
    ["missing type", { properties: { a: { type: "string" } } }],
    ["type undefined", { type: undefined, properties: { a: { type: "string" } } }],
    ["type null", { type: null, properties: {} }],
    ["type array", { type: ["object", "null"], properties: { a: { type: "string" } } }],
    ["top-level oneOf", { oneOf: [{ type: "object", properties: { a: { type: "string" } } }] }],
    ["empty schema", {}],
    ["no schema", undefined],
  ])("always sends type: object (%s)", (_name, schema) => {
    expect(wire(schema as Record<string, unknown> | undefined).type).toBe("object");
  });

  it("leaves an ordinary schema unchanged", () => {
    const out = wire({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
    expect(out.type).toBe("object");
    expect(out.required).toEqual(["q"]);
    expect(Object.keys(out.properties ?? {})).toEqual(["q"]);
  });
});
