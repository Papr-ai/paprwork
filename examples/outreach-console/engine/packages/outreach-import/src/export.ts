/**
 * CSV export that cannot be turned into a spreadsheet formula (OWASP CSV injection): cells starting
 * with = + - @ tab or carriage return are prefixed with a single quote, and every cell is quoted.
 */
export function escapeCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}
