/** Calendar date keys stored in briefs.date (YYYY-MM-DD only — no suffixes like -test). */
export const BRIEF_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyBriefHero {
  title: string;
  date?: string;
  subtitle?: string;
  stats?: Array<{ value?: string; label?: string }>;
}

export interface DailyBriefPayload {
  hero: DailyBriefHero;
  sections: unknown[];
}

export function isBriefDateKey(value: unknown): value is string {
  return typeof value === "string" && BRIEF_DATE_KEY_PATTERN.test(value);
}

export function parseDailyBriefPayload(raw: unknown): DailyBriefPayload | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "{}") {
      return null;
    }
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const hero = record.hero;
  if (!hero || typeof hero !== "object" || Array.isArray(hero)) {
    return null;
  }

  const heroRecord = hero as Record<string, unknown>;
  if (typeof heroRecord.title !== "string" || !heroRecord.title.trim()) {
    return null;
  }

  const title = heroRecord.title.trim();
  const heroPayload: DailyBriefHero = {
    title,
    ...(typeof heroRecord.date === "string" ? { date: heroRecord.date } : {}),
    ...(typeof heroRecord.subtitle === "string"
      ? { subtitle: heroRecord.subtitle }
      : {}),
    ...(Array.isArray(heroRecord.stats) ? { stats: heroRecord.stats } : {}),
  };

  if (!Array.isArray(record.sections) || record.sections.length === 0) {
    return null;
  }

  return {
    hero: heroPayload,
    sections: record.sections,
  };
}

export function validateDailyBriefWrite(
  dateKey: unknown,
  briefJson: unknown,
): { ok: true; payload: DailyBriefPayload } | { ok: false; error: string } {
  if (!isBriefDateKey(dateKey)) {
    return {
      ok: false,
      error:
        `Invalid brief date "${String(dateKey)}". Use YYYY-MM-DD only (no test suffixes).`,
    };
  }

  const payload = parseDailyBriefPayload(briefJson);
  if (!payload) {
    return {
      ok: false,
      error:
        "Invalid brief_json: must include hero.title and a non-empty sections array.",
    };
  }

  return { ok: true, payload };
}
