/**
 * Org logo — replaces the org color ring. Your avatar wears the org's logo as a badge;
 * admins can change it, members only see it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { OrgMark } from "../components/Sidebar/OrgMark";
import { OrgSection } from "../components/Sidebar/OrgSection";
import { cleanSite, defaultOrgSite, isOrgAdmin, orgLogoSrc, useOrgLogos } from "../components/Sidebar/orgLogoStore";
import type { OrgEntry } from "../components/Sidebar/useOrgList";

const EMAIL = "shawkat@papr.ai";
const ORGS: OrgEntry[] = [
  { id: "prod", name: "papr-ai-production", role: "owner" },
  { id: "staging", name: "papr-ai-staging", role: "member" },
  { id: "personal", name: "shawkat", role: "owner" },
];
const siteFor = (o: OrgEntry) => useOrgLogos.getState().branding[o.id]?.site ?? defaultOrgSite([o.name], EMAIL);
const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

function renderSection(activeId: string) {
  return render(<OrgSection orgs={ORGS} activeId={activeId} switching={false} onSwitch={() => {}} siteFor={siteFor} />);
}

beforeEach(() => {
  localStorage.clear();
  useOrgLogos.setState({ branding: {} });
});

describe("orgLogoStore", () => {
  it("cleans whatever gets pasted into a bare domain", () => {
    expect(cleanSite("https://www.Stripe.com/pricing?x=1")).toBe("stripe.com");
    expect(cleanSite("  papr.ai ")).toBe("papr.ai");
    expect(cleanSite("not a site")).toBe("");
    expect(cleanSite("")).toBe("");
  });

  it("defaults to your work domain only when the org name carries it", () => {
    expect(defaultOrgSite(["papr-ai-production"], EMAIL)).toBe("papr.ai");
    expect(defaultOrgSite(["shawkat"], EMAIL)).toBe("");
    expect(defaultOrgSite(["gmail-team"], "a@gmail.com")).toBe("");
    expect(defaultOrgSite(["Acme"], "")).toBe("");
  });

  it("reads the domain out of a Parse org slug when email does not match", () => {
    expect(defaultOrgSite(["Sqaservices", "sqaservices-com"], EMAIL)).toBe("sqaservices.com");
    expect(defaultOrgSite(["Papr", "papr-ai"], "a@gmail.com")).toBe("papr.ai");
    expect(defaultOrgSite(["papr-ai-production"], "a@gmail.com")).toBe(""); // slug must end in the TLD
    expect(defaultOrgSite(["shawkat"], EMAIL)).toBe("");
  });

  it("prefers an upload, then the website icon, then nothing (monogram)", () => {
    expect(orgLogoSrc({ logo: "data:image/png;base64,x" }, "papr.ai")).toBe("data:image/png;base64,x");
    expect(orgLogoSrc(undefined, "papr.ai")).toBe(favicon("papr.ai"));
    expect(orgLogoSrc({ site: "" }, "papr.ai")).toBe(""); // admin cleared the site on purpose
  });

  it("treats owners and admins as admins", () => {
    expect([isOrgAdmin("owner"), isOrgAdmin("admin"), isOrgAdmin("member"), isOrgAdmin(undefined)]).toEqual([true, true, false, false]);
  });

  it("persists per org", () => {
    act(() => useOrgLogos.getState().update("prod", { site: "stripe.com" }));
    expect(JSON.parse(localStorage.getItem("paprwork-org-branding") ?? "{}")).toEqual({ prod: { site: "stripe.com" } });
  });
});

describe("OrgMark", () => {
  it("shows the logo, and falls back to the monogram when the image fails", () => {
    const { container } = render(<OrgMark name="papr-ai-production" src={favicon("papr.ai")} />);
    const mark = container.querySelector(".org-mark")!;
    expect(mark.getAttribute("data-letter")).toBe("P");
    fireEvent.error(mark.querySelector("img")!);
    expect(mark.querySelector("img")).toBeNull();
  });
});

describe("OrgSection", () => {
  it("admins can point the logo at a website", () => {
    const { container } = renderSection("prod");
    const input = screen.getByLabelText("Org website") as HTMLInputElement;
    expect(input.value).toBe("papr.ai");
    fireEvent.change(input, { target: { value: "https://www.stripe.com/pricing" } });
    fireEvent.blur(input);
    expect(useOrgLogos.getState().branding.prod).toEqual({ site: "stripe.com" });
    expect(container.querySelector(".rail-orglogo img")?.getAttribute("src")).toBe(favicon("stripe.com"));
  });

  it("admins see their upload and can go back to the website logo", () => {
    act(() => useOrgLogos.getState().update("prod", { logo: "data:image/png;base64,x" }));
    const { container } = renderSection("prod");
    expect(container.querySelector(".rail-orglogo img")?.getAttribute("src")).toBe("data:image/png;base64,x");
    fireEvent.click(screen.getByText("Use website logo"));
    expect(useOrgLogos.getState().branding.prod?.logo).toBeUndefined();
    expect(container.querySelector(".rail-orglogo img")?.getAttribute("src")).toBe(favicon("papr.ai"));
  });

  it("members see the logo but cannot change it", () => {
    renderSection("staging");
    expect(screen.queryByLabelText("Org website")).toBeNull();
    expect(screen.queryByLabelText(/Change .* logo/)).toBeNull();
    expect(screen.getByText("Only admins can change the logo.")).toBeTruthy();
  });

  it("an org with no website shows its monogram, and every org in the switcher has a mark", () => {
    const { container } = renderSection("personal");
    expect(container.querySelector(".rail-orglogo .org-mark img")).toBeNull();
    expect(container.querySelector(".rail-orglogo .org-mark")?.getAttribute("data-letter")).toBe("S");
    expect(container.querySelectorAll(".rail-org .org-mark")).toHaveLength(3);
    expect(container.querySelector(".rail-org i")).toBeNull(); // no more color dots
  });
});
