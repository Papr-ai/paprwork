/**
 * Light / dark listing media. A listing can carry a second set of pictures and a second
 * preview loop made for dark mode; the viewer's appearance (the system setting Paprwork
 * follows) picks the set, live, with no reload. Items without a `scheme` (every older
 * listing) are shown in both modes.
 */
import { useEffect, useState } from "react";
import type { CatalogMediaItem } from "../../src/core/types/communityCatalog";

export type Scheme = "light" | "dark";

const query = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export const currentScheme = (): Scheme => (query()?.matches ? "dark" : "light");

/** The viewer's appearance; re-renders the moment it changes. */
export function useColorScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(currentScheme);
  useEffect(() => {
    const q = query();
    if (!q) return;
    const on = () => setScheme(q.matches ? "dark" : "light");
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return scheme;
}

/** Per role: items made for this appearance win, else the unscoped ones. Cover first. */
export function mediaForScheme(media: CatalogMediaItem[] | undefined, scheme: Scheme): CatalogMediaItem[] {
  const all = media ?? [];
  const pick = (role: CatalogMediaItem["role"]) => {
    const own = all.filter((m) => m.role === role && m.scheme === scheme);
    return own.length ? own : all.filter((m) => m.role === role && !m.scheme);
  };
  return [...pick("cover"), ...pick("gallery")];
}
