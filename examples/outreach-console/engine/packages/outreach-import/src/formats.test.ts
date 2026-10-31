import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { ImportRejectedError, detectFormat } from './detect';
import { escapeCsvCell, toCsv } from './export';
import { parseHtmlCards, parseHtmlTable, parseSelector } from './html';
import { parseJson, parseXlsx } from './parsers';

describe('HTML', () => {
  const page = `<!doctype html><html><head><script>window.stolen = document.cookie</script>
    <style>td { color: red }</style></head><body>
    <table><tr><th>Name</th><th>Email</th><th>Title</th></tr>
      <tr><td>Ada <b>Lovelace</b></td><td><a href="mailto:ada@example.org">write</a></td><td>CTO<script>alert(1)</script></td></tr>
      <tr><td><img src=x onerror="alert(1)">Grace</td><td>grace@example.net</td><td><template>hidden</template>Admiral</td></tr>
    </table>
    <ul><li class="person card" data-lead><h3>Linus</h3><a class="mail" href="mailto:linus@example.com">mail</a><span class="role">Maintainer</span></li>
        <li class="person"><h3>Other</h3></li></ul></body></html>`;

  it('extracts tables inertly, ignoring scripts, templates and event handlers', () => {
    const rows = parseHtmlTable(page, 0, 100);
    expect(rows.map((r) => r.values)).toEqual([
      { Name: 'Ada Lovelace', Email: 'write', 'Email link': 'mailto:ada@example.org', Title: 'CTO' },
      { Name: 'Grace', Email: 'grace@example.net', Title: 'Admiral' },
    ]);
    expect(rows[0]?.locator).toBe('html:table[0]/tr[1]');
    expect((globalThis as Record<string, unknown>).stolen).toBeUndefined();
  });

  it('extracts repeated cards with simple selectors and attributes', () => {
    const rows = parseHtmlCards(page, 'ul li.person.card[data-lead]', { Name: 'h3', Email: 'a.mail@href', Title: '.role' }, 100);
    expect(rows.map((r) => r.values)).toEqual([{ Name: 'Linus', Email: 'mailto:linus@example.com', Title: 'Maintainer' }]);
  });

  it('survives pathological nesting and rejects unsupported selectors', () => {
    const deep = `${'<div>'.repeat(3_000)}<table><tr><th>Name</th></tr><tr><td>Deep</td></tr></table>${'</div>'.repeat(3_000)}`;
    expect(() => parseHtmlTable(deep, 0, 100)).toThrow(ImportRejectedError);
    expect(() => parseSelector('div > p')).toThrow(/unsupported selector/);
    expect(() => parseSelector('a:hover')).toThrow(/unsupported selector/);
  });
});

describe('JSON', () => {
  it('reads arrays and JSON Lines, flattening nested objects', () => {
    expect(parseJson('[{"name":"Ada","org":{"name":"Analytical","domain":"example.org"},"tags":["a","b"]}]', 10)[0]?.values)
      .toEqual({ name: 'Ada', 'org.name': 'Analytical', 'org.domain': 'example.org', tags: 'a, b' });
    const lines = parseJson('{"email":"a@example.org"}\n\n{"email":"b@example.org","__proto__":{"polluted":1}}\n', 10);
    expect(lines.map((r) => r.locator)).toEqual(['jsonl:line=1', 'jsonl:line=2']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => parseJson('{"a":', 10)).toThrow(ImportRejectedError);
  });
});

describe('XLSX', () => {
  it('reads cached values only and never evaluates formulas', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Leads');
    sheet.addRow(['Name', 'Email', 'Score', 'Site']);
    sheet.addRow(['Ada', 'ada@example.org', { formula: 'SUM(1,2)', result: 3 }, { text: 'site', hyperlink: 'https://example.org' }]);
    sheet.addRow([{ richText: [{ text: 'Gra' }, { text: 'ce' }] }, 'grace@example.net', { formula: 'WEBSERVICE("http://evil.example")' }, '']);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    expect(detectFormat(bytes, 'anything.bin')).toBe('xlsx');
    const rows = await parseXlsx(bytes, 100);
    expect(rows.map((r) => r.values)).toEqual([
      { Name: 'Ada', Email: 'ada@example.org', Score: '3', Site: 'site' },
      { Name: 'Grace', Email: 'grace@example.net', Score: '', Site: '' },
    ]);
    expect(rows[0]?.locator).toBe('xlsx:Leads!2');
  });

  it('rejects files that are not workbooks', async () => {
    await expect(parseXlsx(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 10)).rejects.toThrow(ImportRejectedError);
  });
});

describe('CSV export', () => {
  it('neutralizes formula injection and quotes every cell', () => {
    expect(escapeCsvCell('=HYPERLINK("http://evil.example")')).toBe(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(escapeCsvCell('+1 555')).toBe(`"'+1 555"`);
    expect(escapeCsvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(escapeCsvCell('Ada')).toBe('"Ada"');
    expect(toCsv(['a', 'b'], [[1, null]])).toBe('"a","b"\r\n"1",""');
  });
});
