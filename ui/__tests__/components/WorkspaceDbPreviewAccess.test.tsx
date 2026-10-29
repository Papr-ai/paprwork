/** Table tabs show Public / Private from table-scope. */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceDbPreview } from "../../components/Apps/WorkspaceDbPreview";

const table = (name: string) => ({ name, rowCount: 2, columns: [{ name: "id" }], rows: [] });
const preview = { tables: [table("posts"), table("notes"), table("logs")], selectedTable: "posts", limit: 50, offset: 0 };

Element.prototype.scrollTo = vi.fn() as never;

describe("WorkspaceDbPreview access tags", () => {
  it("tags public and private tables, skips unknown ones", () => {
    render(
      <WorkspaceDbPreview
        preview={preview as never}
        loading={false}
        onSelectTable={vi.fn()}
        scopes={[
          { db: "perf", name: "posts", scope: "all" },
          { db: "perf", name: "notes", scope: "user" },
        ]}
      />,
    );
    const tab = (n: string) => screen.getByRole("tab", { name: new RegExp(`^${n}`) });
    expect(tab("posts").textContent).toContain("Public");
    expect(tab("notes").textContent).toContain("Private");
    expect(tab("logs").textContent).not.toMatch(/Public|Private/);
  });
});
