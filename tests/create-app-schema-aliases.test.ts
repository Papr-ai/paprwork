import { describe, expect, test } from "vitest";
import { z } from "zod";

function coerceCreateAppAliases(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const o = { ...(raw as Record<string, unknown>) };

  if (o.title === undefined && typeof o.name === "string") {
    o.title = o.name;
  }

  if (o.files === undefined && o.appFiles !== undefined) {
    o.files = o.appFiles;
  }

  if (typeof o.files === "string") {
    try {
      o.files = JSON.parse(o.files) as unknown;
    } catch {
      // keep string
    }
  }

  if (Array.isArray(o.files)) {
    o.files = o.files.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return item;
      }
      const file = { ...(item as Record<string, unknown>) };
      if (file.filename === undefined && typeof file.path === "string") {
        file.filename = file.path;
      }
      return file;
    });
  }

  return o;
}

const testSchema = z.preprocess(
  coerceCreateAppAliases,
  z.object({
    title: z.string().min(1),
    icon: z.string().min(1),
    files: z
      .array(
        z.object({
          filename: z.string().min(1),
          content: z.string(),
        }),
      )
      .optional(),
  }),
);

describe("create_app alias coercion", () => {
  test("maps name → title", () => {
    const parsed = testSchema.parse({
      name: "Cloud Run Monitor",
      icon: "<svg></svg>",
    });
    expect(parsed.title).toBe("Cloud Run Monitor");
  });

  test("maps appFiles → files and path → filename", () => {
    const parsed = testSchema.parse({
      title: "Cloud Run Monitor",
      icon: "<svg></svg>",
      appFiles: [{ path: "app.ts", content: "export {}" }],
    });
    expect(parsed.files?.[0]?.filename).toBe("app.ts");
  });

  test("parses JSON-string files array", () => {
    const parsed = testSchema.parse({
      title: "Cloud Run Monitor",
      icon: "<svg></svg>",
      files: '[{"path":"app.ts","content":"export {}"}]',
    });
    expect(parsed.files?.[0]?.filename).toBe("app.ts");
    expect(parsed.files?.[0]?.content).toBe("export {}");
  });
});
