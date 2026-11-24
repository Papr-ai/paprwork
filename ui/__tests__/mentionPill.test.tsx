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
    // Pen bolds people: an exact teammate name in ** ** is a pill; other bold text stays bold.
    expect(linkMentions("Notified **amirkabbara+110** by **tomorrow**", ["amirkabbara+110"])).toBe("Notified [@amirkabbara+110](#mention:amirkabbara%2B110) by **tomorrow**");
    expect(linkMentions("```\n@foo\n```")).toBe("```\n@foo\n```");
  });
  it("chat Markdown shows initials + name", () => {
    const { container } = render(<Markdown mentions>{"Notified **@amir+1** to own it."}</Markdown>);
    const pill = container.querySelector(".mention-pill");
    expect(pill?.textContent).toBe("Aamir+1");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".mention-pill .papr-avatar")).not.toBeNull();
  });
  it("only common/mentionPill.css styles the pill (no card-scoped vars leaking into chat)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "../components/Chat/MentionCard.css"), "utf8");
    expect(css).not.toMatch(/(^|\n)\.mention-pill\b/);
  });
});

describe("pill photo", () => {
  it("uses the teammate's photo when there is one, initials otherwise", async () => {
    const { gateway } = await import("../src/lib/gateway");
    (gateway.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true, data: { members: [
      { userId: "u1", displayName: "Shawkat Kabbara", email: "shawkat@papr.ai", imageUrl: "https://img.example/s.png" },
    ] } });
    vi.resetModules();
    const mod = await import("../components/common/mentionPill");
    const menu = await import("../components/Chat/MentionMenu");
    await menu.loadTeammates();
    const withPhoto = render(<mod.MentionPill name="Shawkat Kabbara" />).container;
    expect(withPhoto.querySelector("img")?.getAttribute("src")).toBe("https://img.example/s.png");
    const noPhoto = render(<mod.MentionPill name="amir+1" />).container;
    expect(noPhoto.querySelector("img")).toBeNull();
    // Same avatar as Settings → Team: UserAvatar initials, not a separate blue dot.
    expect(noPhoto.querySelector(".papr-avatar__initials")?.textContent).toBe("A");
  });
});
