/**
 * Lazy Mermaid renderer for the document editor.
 *
 * mermaid is ~1MB, so it is only imported the first time a document actually
 * contains a ```mermaid block. Rendering is serialised because mermaid keeps
 * global state and concurrent render() calls can clobber each other.
 */

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let initializedTheme: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

export function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidPromise;
  const theme = prefersDark() ? "dark" : "default";
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      fontFamily: "inherit",
      flowchart: { htmlLabels: true, useMaxWidth: true },
    });
    initializedTheme = theme;
  }
  return mermaid;
}

export interface MermaidResult {
  svg?: string;
  error?: string;
}

export function renderMermaid(source: string): Promise<MermaidResult> {
  const job = queue.then(async (): Promise<MermaidResult> => {
    const code = source.trim();
    if (!code) return { error: "Empty diagram" };
    try {
      const mermaid = await loadMermaid();
      const id = `papr-mermaid-${Date.now().toString(36)}-${counter++}`;
      const { svg } = await mermaid.render(id, code);
      return { svg };
    } catch (err) {
      // mermaid leaves an error <svg> in <body> when parsing fails
      document.querySelectorAll('[id^="dpapr-mermaid-"]').forEach((n) => n.remove());
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
