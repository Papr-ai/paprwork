/** Share sheet data check: Ask Pen opens a new chat with the review prompt already sent. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareDataCheck } from "../../components/Apps/ShareDataCheck";

vi.mock("../../utils/v9CloudApi", () => ({
  fetchTableScopes: async () => [
    { db: "crm", name: "deals", scope: "all" },
    { db: "crm", name: "contacts", scope: "user" },
  ],
}));

describe("ShareDataCheck", () => {
  it("Ask Pen opens a new chat titled Review shared data and sends the prompt", async () => {
    const events: CustomEvent[] = [];
    const on = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("papr-chat-open", on);
    render(<ShareDataCheck appId="app-1" audience="team" requireSignIn />);
    fireEvent.click(await screen.findByRole("button", { name: /1 table/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask Pen" }));
    await waitFor(() => expect(events).toHaveLength(1));
    const d = events[0].detail as { message: string; send: boolean; title: string };
    expect(d.send).toBe(true);
    expect(d.title).toBe("Review shared data");
    expect(d.message).toContain("crm.deals");
    expect(d.message).not.toContain("crm.contacts");
    window.removeEventListener("papr-chat-open", on);
  });

  it("hides Ask Pen for read-only viewers", async () => {
    render(<ShareDataCheck appId="app-1" audience="team" requireSignIn readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: /1 table/ }));
    expect(screen.queryByRole("button", { name: "Ask Pen" })).toBeNull();
  });
});
