export interface Output {
  /** Structured result: JSON with --json, otherwise a readable rendering. */
  result(value: unknown): void;
  line(text: string): void;
}

function render(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return `${indent}-`;
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}(none)`;
    return value.map((item) => (typeof item === 'object' && item !== null ? `${render(item, `${indent}  `).replace(/^\s+/, `${indent}- `)}` : `${indent}- ${String(item)}`)).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => (inner !== null && typeof inner === 'object' ? `${indent}${key}:\n${render(inner, `${indent}  `)}` : `${indent}${key}: ${String(inner)}`))
      .join('\n');
  }
  return `${indent}${String(value)}`;
}

export function createOutput(json: boolean, write: (text: string) => void = (text) => process.stdout.write(text)): Output {
  return {
    result: (value) => write(json ? `${JSON.stringify(value, null, 2)}\n` : `${render(value)}\n`),
    line: (text) => {
      if (!json) write(`${text}\n`);
    },
  };
}
