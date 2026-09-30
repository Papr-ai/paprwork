import { describe, expect, it } from "vitest";
import {
  countSetupBlockingPlaceholderFiles,
  isContextFileSetupNeeded,
  isIdentitySetupComplete,
} from "../ui/utils/memoryWorkspaceHealth";

const identityTemplate = `# Identity

## About

(Name, role, industry, organization)

## Communication Style

(Tone preferences, verbosity level, formatting preferences)
`;

const identityFilledAbout = `# Identity

## About

- **Name:** Amir
- **Email:** amir@example.com

## Communication Style

(Tone preferences, verbosity level, formatting preferences)
`;

const memoryTemplate = `# Memory

## Decisions

(Important decisions and their rationale)
`;

describe("memoryWorkspaceHealth", () => {
  it("treats IDENTITY as complete when About has a name, even if other sections are templates", () => {
    expect(isIdentitySetupComplete(identityFilledAbout)).toBe(true);
    expect(isContextFileSetupNeeded("IDENTITY.md", identityFilledAbout)).toBe(
      false,
    );
  });

  it("flags IDENTITY when About is still the template placeholder", () => {
    expect(isIdentitySetupComplete(identityTemplate)).toBe(false);
    expect(isContextFileSetupNeeded("IDENTITY.md", identityTemplate)).toBe(true);
  });

  it("does not block setup on MEMORY.md templates (sleep cycle maintains it)", () => {
    expect(isContextFileSetupNeeded("MEMORY.md", memoryTemplate)).toBe(false);
    expect(
      countSetupBlockingPlaceholderFiles([
        { name: "MEMORY.md", content: memoryTemplate },
      ]),
    ).toBe(0);
  });
});
