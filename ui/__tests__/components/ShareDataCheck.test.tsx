/** Share sheet data check: Everyone / Some people pills, hover columns, click to open, Ask Pen. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ShareDataCheck } from "../../components/Apps/ShareDataCheck";

const many = Array.from({ length: 9 }, (_, i) => ({ db: "crm", name: `t${i}`, scope: "all", columns: ["x"] }));
let tables: unknown[] = [];
vi.mock("../../utils/v9CloudApi", () => ({ fetchTableScopes: async () => tables }));

const base = [
  { db: "crm", name: "deals", scope: "all", columns: ["company", "amount"], moreColumns: 0 },
  { db: "crm", name: "contacts", scope: "user", columns: ["full_name", "email"], moreColumns: 3 },
];

async function expand(readOnly = false) {
  render(<ShareDataCheck appId="app-1" audience="team" requireSignIn readOnly={readOnly} />);
  fireEvent.click(await screen.findByRole("button", { name: /1 table/ }));
}

describe("ShareDataCheck", () => {
  beforeEach(() => {
    tables = base;
  });

  it("shows Everyone and Some people rows of table pills with columns in the hover card", async () => {
    await expand();
    const everyone = screen.getByText("Everyone").parentElement!;
    const some = screen.getByText("Some people").parentElement!;
    const deals = within(everyone).getByRole("button", { name: /deals/ });
    expect(within(deals).getByRole("tooltip").textContent).toContain("Every row");
    expect(within(deals).getByRole("tooltip").textContent).toContain("company, amount");
    const contacts = within(some).getByRole("button", { name: /contacts/ });
    expect(within(contacts).getByRole("tooltip").textContent).toContain("Their own rows");
    expect(within(contacts).getByRole("tooltip").textContent).toContain("full name, email +3 more");
  });

  it("clicking a pill asks the app to open that table", async () => {
    const events: CustomEvent[] = [];
    const on = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("papr-app-open-table", on);
    await expand();
    fireEvent.click(screen.getByRole("button", { name: /deals/ }));
    expect(events[0].detail).toEqual({ appId: "app-1", db: "crm", table: "deals" });
    window.removeEventListener("papr-app-open-table", on);
  });

  it("caps a row at 6 pills with +N", async () => {
    tables = many;
    render(<ShareDataCheck appId="app-1" audience="team" requireSignIn />);
    fireEvent.click(await screen.findByRole("button", { name: /9 tables/ }));
    expect(screen.getByRole("button", { name: "+3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+3" }));
    expect(screen.getByRole("button", { name: /t8/ })).toBeTruthy();
  });

  it("Ask Pen opens a new chat titled Review shared data and sends the prompt", async () => {
    const events: CustomEvent[] = [];
    const on = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("papr-chat-open", on);
    await expand();
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
    await expand(true);
    expect(screen.queryByRole("button", { name: "Ask Pen" })).toBeNull();
  });
});
