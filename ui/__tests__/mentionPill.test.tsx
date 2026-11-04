import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("../src/lib/gateway", () => ({ gateway: { send: vi.fn(async () => ({ success: true, data: { members: [] } })) } }));

import { linkMentions } from "../components/common/mentionPill";
import { Markdown } from "../components/common/Markdown";

describe("@ names render as pills", () => {
  it("one token, full names, and leaves emails and code alone", () => {
    expect(linkMentions("@amir+1 knows the copy")).toBe("[@amir+1](#mention:amir%2B1) knows the copy");
    expect(linkMentions("Ask @Shawkat Kabbara today", ["Shawkat Kabbara"])).toBe("Ask [@Shawkat Kabbara](#mention:Shawkat%20Kabbara) today");
    expect(linkMentions("mail amir@papr.ai")).toBe("mail amir@papr.ai");
    expect(linkMentions("run `@foo` now")).toBe("run `@foo` now");
    expect(linkMentions("```\n@foo\n```")).toBe("```\n@foo\n```");
  });
  it("chat Markdown shows initials + name", () => {
    const { container } = render(<Markdown mentions>{"Notified **@amir+1** to own it."}</Markdown>);
    const pill = container.querySelector(".mention-pill");
    expect(pill?.textContent).toBe("Aamir+1");
    expect(container.querySelector("a")).toBeNull();
  });
});
