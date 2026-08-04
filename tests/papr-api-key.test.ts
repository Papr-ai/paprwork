import { describe, expect, it, afterEach, vi } from "vitest";
import * as paprWorkspaceModule from "../src/core/utils/paprWorkspace.js";
import {
  isActivePaprNamespace,
  isInternalPaprNamespaceApiKeyName,
  paprApiKeyMatchesActiveWorkspace,
  paprApiKeyMatchesNamespace,
  paprNamespaceApiKeyName,
  parsePaprApiKeyScope,
} from "../src/core/utils/paprApiKey.js";

describe("paprApiKeyMatchesNamespace", () => {
  it("matches keys for the same org and namespace", () => {
    const apiKey =
      "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-abc123";

    expect(
      paprApiKeyMatchesNamespace(apiKey, "Y8D4H7Yp3Z", "onnNQFe3DN"),
    ).toBe(true);
  });

  it("rejects keys for a different namespace", () => {
    const apiKey =
      "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-abc123";

    expect(
      paprApiKeyMatchesNamespace(apiKey, "Y8D4H7Yp3Z", "S7mQcHZCtj"),
    ).toBe(false);
  });

  it("accepts keys when namespace matches even if org id in key differs (legacy org segment)", () => {
    const apiKey =
      "sk-org-De6SRb7yNd-namespace-S7mQcHZCtj-abc123";

    expect(
      paprApiKeyMatchesNamespace(apiKey, "Y8D4H7Yp3Z", "S7mQcHZCtj"),
    ).toBe(true);
  });

  it("accepts keys when namespace matches even if org id in key differs", () => {
    const apiKey =
      "sk-org-OtherOrgId123-namespace-85ZIB7mD1V-abc123";

    expect(
      paprApiKeyMatchesNamespace(apiKey, "Y8D4H7Yp3Z", "85ZIB7mD1V"),
    ).toBe(true);
  });

  it("accepts legacy keys without embedded namespace when namespace-bound", () => {
    expect(
      paprApiKeyMatchesNamespace("sk-org-ns-legacy-key", "Y8D4H7Yp3Z", "85ZIB7mD1V", {
        trustLegacyBinding: true,
      }),
    ).toBe(true);
  });

  it("rejects legacy keys without embedded namespace for untrusted sources", () => {
    expect(
      paprApiKeyMatchesNamespace("sk-org-ns-legacy-key", "Y8D4H7Yp3Z", "85ZIB7mD1V"),
    ).toBe(false);
  });
});

describe("parsePaprApiKeyScope", () => {
  it("extracts org and namespace from Papr API keys", () => {
    expect(
      parsePaprApiKeyScope(
        "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-abc123",
      ),
    ).toEqual({
      organizationId: "Y8D4H7Yp3Z",
      namespaceId: "onnNQFe3DN",
    });
  });

  it("extracts scope when the key has no trailing secret segment", () => {
    expect(
      parsePaprApiKeyScope("sk-org-Y8D4H7Yp3Z-namespace-85ZIB7mD1V"),
    ).toEqual({
      organizationId: "Y8D4H7Yp3Z",
      namespaceId: "85ZIB7mD1V",
    });
  });
});

describe("isActivePaprNamespace", () => {
  const originalOrg = process.env.PAPR_ORG_ID;
  const originalNamespace = process.env.PAPR_NAMESPACE_ID;

  afterEach(() => {
    if (originalOrg === undefined) delete process.env.PAPR_ORG_ID;
    else process.env.PAPR_ORG_ID = originalOrg;
    if (originalNamespace === undefined) delete process.env.PAPR_NAMESPACE_ID;
    else process.env.PAPR_NAMESPACE_ID = originalNamespace;
  });

  it("matches the active workspace namespace id", () => {
    process.env.PAPR_ORG_ID = "Y8D4H7Yp3Z";
    process.env.PAPR_NAMESPACE_ID = "85ZIB7mD1V";

    expect(isActivePaprNamespace("85ZIB7mD1V")).toBe(true);
    expect(isActivePaprNamespace("onnNQFe3DN")).toBe(false);
  });
});

describe("paprApiKeyMatchesActiveWorkspace", () => {
  const originalOrg = process.env.PAPR_ORG_ID;
  const originalNamespace = process.env.PAPR_NAMESPACE_ID;

  afterEach(() => {
    if (originalOrg === undefined) delete process.env.PAPR_ORG_ID;
    else process.env.PAPR_ORG_ID = originalOrg;
    if (originalNamespace === undefined) delete process.env.PAPR_NAMESPACE_ID;
    else process.env.PAPR_NAMESPACE_ID = originalNamespace;
  });

  it("accepts keys that match the active workspace env pointer", () => {
    process.env.PAPR_ORG_ID = "Y8D4H7Yp3Z";
    process.env.PAPR_NAMESPACE_ID = "onnNQFe3DN";

    expect(
      paprApiKeyMatchesActiveWorkspace(
        "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-abc123",
      ),
    ).toBe(true);
  });

  it("rejects keys for a different namespace than the active workspace", () => {
    process.env.PAPR_ORG_ID = "Y8D4H7Yp3Z";
    process.env.PAPR_NAMESPACE_ID = "onnNQFe3DN";

    expect(
      paprApiKeyMatchesActiveWorkspace(
        "sk-org-T1HzjVDD3R-namespace-aXNvpekYXn-abc123",
      ),
    ).toBe(false);
  });

  it("rejects legacy keys from env even when workspace pointer exists", () => {
    process.env.PAPR_ORG_ID = "Y8D4H7Yp3Z";
    process.env.PAPR_NAMESPACE_ID = "85ZIB7mD1V";

    expect(paprApiKeyMatchesActiveWorkspace("sk-org-ns-legacy-key")).toBe(
      false,
    );
  });

  it("rejects wrong-namespace keys when env is unset but workspace pointer file exists", () => {
    delete process.env.PAPR_ORG_ID;
    delete process.env.PAPR_NAMESPACE_ID;

    const readSpy = vi
      .spyOn(paprWorkspaceModule, "readActiveWorkspacePointer")
      .mockReturnValue({
        organizationId: "Y8D4H7Yp3Z",
        namespaceId: "onnNQFe3DN",
        paprHome: "/tmp/papr",
        userDataPath: "/tmp/user",
      });

    expect(
      paprApiKeyMatchesActiveWorkspace(
        "sk-org-T1HzjVDD3R-namespace-aXNvpekYXn-abc123",
      ),
    ).toBe(false);

    expect(
      paprApiKeyMatchesActiveWorkspace(
        "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-abc123",
      ),
    ).toBe(true);

    readSpy.mockRestore();
  });
});

describe("paprNamespaceApiKeyName", () => {
  it("builds a per-namespace vault slot name", () => {
    expect(paprNamespaceApiKeyName("85ZIB7mD1V")).toBe(
      "PAPR_API_KEY__85ZIB7mD1V",
    );
  });

  it("identifies internal namespace key slots", () => {
    expect(isInternalPaprNamespaceApiKeyName("PAPR_API_KEY__85ZIB7mD1V")).toBe(
      true,
    );
    expect(isInternalPaprNamespaceApiKeyName("PAPR_API_KEY")).toBe(false);
    expect(isInternalPaprNamespaceApiKeyName("OPENAI_API_KEY")).toBe(false);
  });
});
