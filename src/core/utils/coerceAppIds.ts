/** Coerce model-supplied appIds into a string array before Zod validation. */
export function coerceAppIdsValue(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    return raw.filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof raw !== "string") {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    trimmed === "__standalone__" ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    return [trimmed];
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      );
    }
    if (typeof parsed === "string" && parsed.trim().length > 0) {
      return [parsed.trim()];
    }
  } catch {
    // Not JSON — fall through
  }

  return undefined;
}
