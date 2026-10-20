import { describe, expect, it } from "vitest";
import type { RequiredKeySpec } from "../../../core/types/bundles.js";
import { AUTO_DETECTED_KEY_DESCRIPTION } from "../appKeyDeclarations.js";
import {
  buildCredentialHelpMessage,
  platformForKey,
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

describe("platform sign-ins", () => {
  const reddit: RequiredKeySpec = {
    name: "REDDIT_REDDIT_SESSION",
    service: "Reddit Reddit Session",
    category: "other",
    description: AUTO_DETECTED_KEY_DESCRIPTION,
    required: true,
    credentialScope: "user",
    clientAccess: "server",
  };
  const redditToken: RequiredKeySpec = { ...reddit, name: "REDDIT_TOKEN_V2" };

  it("detects platform cookie keys", () => {
    expect(platformForKey("REDDIT_REDDIT_SESSION")).toEqual({ id: "reddit", name: "Reddit" });
    expect(platformForKey("LINKEDIN_LI_AT")?.id).toBe("linkedin");
    expect(platformForKey("TWITTER_AUTH_TOKEN")?.id).toBe("twitter");
    expect(platformForKey("OPENAI_API_KEY")).toBeNull();
  });

  it("shows one Connect card per platform instead of a paste box", () => {
    const html = renderCredentialSetupPage({
      action: "/ns/app/credentials/setup",
      returnTo: "/ns/app/",
      appTitle: "Reddit Research",
      missing: [reddit, redditToken],
      statusUrl: "/ns/app/api/credentials/status",
    });
    expect(html.match(/data-connect="reddit"/g)).toHaveLength(1);
    expect(html).toContain("Connect Reddit");
    expect(html).toContain('data-keys="REDDIT_REDDIT_SESSION,REDDIT_TOKEN_V2"');
    expect(html).not.toContain("Reddit Reddit Session");
    expect(html).not.toContain("Paste your Reddit key");
    // Only the "paste a session instead" fallback has a Save button.
    expect(html.match(/Save and open app/g)).toHaveLength(1);
    expect(html).toContain("<summary>Paste a session instead</summary>");
    expect(html).toContain("Skip for now");
    expect(html).toContain("papr://connections/connect?platform=");
  });

  it("keeps API key cards alongside a platform card", () => {
    const html = render([reddit, openai]);
    expect(html).toContain("Connect Reddit");
    expect(html).toContain("Paste your OpenAI key");
    expect(html).toContain("Save and open app");
  });

  it("hides the older backend-manifest placeholder too", () => {
    const html = render([{ ...reddit, description: "Server-side key for app backend handlers (synced from backend/manifest.json)" }]);
    expect(html).not.toContain("synced from");
    expect(html).toContain("Sign in to Reddit so this app can work as you.");
  });

  it("tells Pen it's a sign-in, not a key", () => {
    expect(buildCredentialHelpMessage("Reddit Research", [reddit])).toContain("Reddit sign-in");
  });
});
