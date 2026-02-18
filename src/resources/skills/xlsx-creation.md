---
id: preloaded-xlsx-creation
name: XLSX Spreadsheet Creation
description: Create Excel spreadsheets with formulas, charts, formatting, and multiple sheets using ExcelJS.
---
# XLSX Spreadsheet Creation

Create professional Excel (.xlsx) files programmatically using ExcelJS.

## Setup

```bash
npm install exceljs
```

## Basic Spreadsheet

```javascript
const ExcelJS = require('exceljs');
const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Data');

// Headers
sheet.columns = [
  { header: 'Name', key: 'name', width: 25 },
  { header: 'Value', key: 'value', width: 15 },
  { header: 'Date', key: 'date', width: 15 },
];

// Style headers
sheet.getRow(1).font = { bold: true, size: 12 };
sheet.getRow(1).fill = {
  type: 'pattern', pattern: 'solid',
  fgColor: { argb: 'FF1a1a2e' }
};
sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

// Add data
sheet.addRow({ name: 'Item A', value: 100, date: new Date() });
sheet.addRow({ name: 'Item B', value: 200, date: new Date() });

await workbook.xlsx.writeFile('output.xlsx');
```

## Formulas

```javascript
// SUM formula
sheet.getCell('B10').value = { formula: 'SUM(B2:B9)' };

// AVERAGE
sheet.getCell('B11').value = { formula: 'AVERAGE(B2:B9)' };

// Conditional
sheet.getCell('C2').value = { formula: 'IF(B2>100,"High","Low")' };
```

## Formatting

```javascript
// Number format
sheet.getColumn('B').numFmt = '#,##0.00';

// Currency
sheet.getColumn('C').numFmt = '$#,##0.00';

// Percentage
sheet.getColumn('D').numFmt = '0.0%';

// Borders
cell.border = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

// Conditional formatting
sheet.addConditionalFormatting({
  ref: 'B2:B100',
  rules: [{
    type: 'cellIs', operator: 'greaterThan', formulae: [100],
    style: { fill: { type: 'pattern', bgColor: { argb: 'FF90EE90' } } }
  }]
});
```

## Common Use Cases

### Financial Report
Multiple sheets: Summary, Revenue, Expenses, Forecast. Include formulas, charts, and formatting.

### Data Export
Export job results or Papr Memory data to spreadsheet format for sharing.

### Analytics Dashboard
Pivot-table-style summaries with charts and conditional formatting.

### Project Tracker
Tasks, deadlines, status columns with conditional formatting for overdue items.

## Best Practices

- Use named ranges for complex formulas
- Freeze panes for headers (`sheet.views = [{ state: 'frozen', ySplit: 1 }]`)
- Auto-filter on data ranges
- Set print area and page setup for printing
- Include a summary/overview sheet for multi-sheet workbooks
