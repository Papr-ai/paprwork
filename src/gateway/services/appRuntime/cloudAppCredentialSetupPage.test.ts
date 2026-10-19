import { describe, expect, it } from "vitest";
import type { RequiredKeySpec } from "../../../core/types/bundles.js";
import { AUTO_DETECTED_KEY_DESCRIPTION } from "../appKeyDeclarations.js";
import {
  buildCredentialHelpMessage,
  renderCredentialSetupPage,
} from "./cloudAppCredentialSetupPage.js";
import { hasCredentialSkipCookie } from "./CloudAppHostCredentialService.js";

const openai: RequiredKeySpec = {
  name: "OPENAI_API_KEY",
  service: "OpenAI",
  category: "ai",
  description: "Writes your drafts with your own OpenAI account",
  required: true,
  credentialScope: "user",
  clientAccess: "server",
};

function render(missing: RequiredKeySpec[]): string {
  return renderCredentialSetupPage({
    action: "/ns/app/credentials/setup",
    returnTo: "/ns/app/",
    appTitle: "Draft Studio",
    missing,
  });
}

describe("renderCredentialSetupPage", () => {
  it("leads with the service and purpose, links to signup, offers skip and help", () => {
    const html = render([openai]);
    expect(html).toContain("Connect your accounts");
    expect(html).toContain("Writes your drafts with your own OpenAI account");
    expect(html).toContain("Get a OpenAI key");
    expect(html).toContain("platform.openai.com");
    expect(html).toContain('name="skip" value="1"');
    expect(html).toContain("Ask Pen");
    // Env var name is tucked away, not the label.
    expect(html).toContain("<summary>Technical name</summary><code>OPENAI_API_KEY</code>");
    expect(html).not.toContain("required placeholder");
  });

  it("never shows the old auto-sync placeholder or internal jargon", () => {
    const html = render([{ ...openai, description: AUTO_DETECTED_KEY_DESCRIPTION }]);
    expect(html).not.toContain("synced from backend manifest");
    expect(html).not.toContain("sandbox");
  });

  it("marks optional keys", () => {
    expect(render([{ ...openai, required: false }])).toContain(">Optional<");
  });

  it("escapes publisher text", () => {
    const html = render([{ ...openai, description: '<img src=x onerror="x">' }]);
    expect(html).not.toContain("<img src=x");
  });
});

describe("buildCredentialHelpMessage", () => {
  it("tells Pen what each key is for", () => {
    expect(buildCredentialHelpMessage("Draft Studio", [openai])).toContain(
      "OpenAI (OPENAI_API_KEY): Writes your drafts",
    );
  });
});

describe("hasCredentialSkipCookie", () => {
  it("detects the skip cookie", () => {
    expect(hasCredentialSkipCookie("a=1; papr_cred_skip=1")).toBe(true);
    expect(hasCredentialSkipCookie("papr_cred_skip=0")).toBe(false);
    expect(hasCredentialSkipCookie(undefined)).toBe(false);
  });
});
