import { describe, expect, it } from "vitest";
import { classifyTursoCredentialFailure } from "../src/gateway/services/tursoCredentialErrors.js";

describe("classifyTursoCredentialFailure", () => {
  it("detects install db-token ACL failures", () => {
    expect(
      classifyTursoCredentialFailure(
        'Install db-token failed (403): {"detail":"No read access"}',
      ),
    ).toBe("access_denied");
  });

  it("treats nested Turso 403 in provisioning as rate limit not ACL", () => {
    expect(
      classifyTursoCredentialFailure(
        'Turso token request failed (500): {"detail":"Database provisioning failed: Client error \'403 Forbidden\'',
      ),
    ).toBe("rate_limit");
  });

  it("detects database limit messages", () => {
    expect(
      classifyTursoCredentialFailure("Turso database limit reached — skipping"),
    ).toBe("rate_limit");
  });

  it("detects missing API key", () => {
    expect(classifyTursoCredentialFailure("PAPR_API_KEY not configured")).toBe(
      "missing_api_key",
    );
  });
});
