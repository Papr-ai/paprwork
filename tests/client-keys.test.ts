import { describe, expect, it } from "vitest";

import type { RequiredKeySpec } from "../src/core/types/bundles.js";
import {
  getAllowedClientKeyNames,
  resolveClientKeys,
} from "../src/core/utils/clientKeys.js";

const requirements: RequiredKeySpec[] = [
  {
    name: "GOOGLE_MAPS_KEY",
    service: "Google Maps",
    category: "other",
    description: "Publishable maps key",
    required: true,
    credentialScope: "owner",
    clientAccess: "client",
  },
  {
    name: "STRIPE_SECRET",
    service: "Stripe",
    category: "payments",
    description: "Secret key",
    required: true,
    credentialScope: "owner",
    clientAccess: "server",
  },
];

describe("clientKeys", () => {
  it("returns only client-declared key names", () => {
    expect(getAllowedClientKeyNames(requirements)).toEqual(["GOOGLE_MAPS_KEY"]);
  });

  it("filters requested names to client-safe intersection", () => {
    expect(
      getAllowedClientKeyNames(requirements, [
        "GOOGLE_MAPS_KEY",
        "STRIPE_SECRET",
      ]),
    ).toEqual(["GOOGLE_MAPS_KEY"]);
  });

  it("resolves values only for vault keys marked client", async () => {
    const result = await resolveClientKeys({
      requirements,
      requestedNames: ["GOOGLE_MAPS_KEY", "STRIPE_SECRET"],
      keyMetadata: [
        { name: "GOOGLE_MAPS_KEY", clientAccess: "client" },
        { name: "STRIPE_SECRET", clientAccess: "server" },
      ],
      getValue: async (name) =>
        name === "GOOGLE_MAPS_KEY" ? "pk-maps-123" : "sk-live-secret",
    });

    expect(result.keys).toEqual({ GOOGLE_MAPS_KEY: "pk-maps-123" });
    expect(result.rejected).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("reports missing client keys not in vault", async () => {
    const result = await resolveClientKeys({
      requirements,
      keyMetadata: [{ name: "GOOGLE_MAPS_KEY", clientAccess: "client" }],
      getValue: async () => null,
    });

    expect(result.keys).toEqual({});
    expect(result.missing).toEqual(["GOOGLE_MAPS_KEY"]);
  });
});
