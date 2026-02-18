---
id: preloaded-slides-creator
name: Slides Creator (Quick)
description: Create professional presentation slides using PptxGenJS with ready-made templates and layouts.
---
# Slides Creator (Quick)

Create professional presentation slides using PptxGenJS (already installed in Paprwork's dependencies).

## Prerequisites

PptxGenJS is available via Node.js:

```javascript
const PptxGenJS = require('pptxgenjs');
const pres = new PptxGenJS();
```

## Slide Types & Layouts

### 1. Title Slide
```javascript
const slide = pres.addSlide();
slide.addText('Presentation Title', {
  x: 1, y: 1.5, w: 8, fontSize: 44, bold: true, color: '1a1a2e',
  fontFace: 'Helvetica Neue'
});
slide.addText('Subtitle or Date', {
  x: 1, y: 2.8, w: 8, fontSize: 24, color: '666666',
  fontFace: 'Helvetica Neue'
});
```

### 2. Content Slide with Bullets
```javascript
const slide = pres.addSlide();
slide.addText('Section Title', {
  x: 0.5, y: 0.5, w: 9, fontSize: 28, bold: true, color: '1a1a2e'
});
slide.addText([
  { text: 'First key point\n', options: { bullet: true, fontSize: 18 } },
  { text: 'Second key point\n', options: { bullet: true, fontSize: 18 } },
  { text: 'Third key point', options: { bullet: true, fontSize: 18 } }
], { x: 0.8, y: 1.5, w: 8, color: '333333' });
```

### 3. Two-Column Layout
```javascript
const slide = pres.addSlide();
slide.addText('Left Column', { x: 0.5, y: 0.5, w: 4, fontSize: 18 });
slide.addText('Right Column', { x: 5.2, y: 0.5, w: 4, fontSize: 18 });
```

### 4. Chart Slide
```javascript
const slide = pres.addSlide();
slide.addChart(pres.ChartType.bar, [
  { name: 'Q1', labels: ['Jan','Feb','Mar'], values: [10,20,30] }
], { x: 1, y: 1.5, w: 8, h: 4 });
```

### 5. Image Slide
```javascript
const slide = pres.addSlide();
slide.addImage({ path: '/path/to/image.png', x: 1, y: 1, w: 8, h: 5 });
```

## Design Principles

- **Keep it simple**: 1 idea per slide
- **Use hierarchy**: Title -> Main points -> Supporting details
- **Consistent styling**: Same fonts, colors, sizes throughout
- **White space**: Don't overcrowd slides
- **Visual aids**: Use charts, images, icons when possible

## Workflow

1. **Understand requirements**: What's the presentation about? Who's the audience?
2. **Create outline**: Plan slide sequence and key messages
3. **Design slides**: Use appropriate layouts for each content type
4. **Add content**: Titles, bullets, charts, images
5. **Apply styling**: Consistent colors, fonts, spacing
6. **Save file**: Generate .pptx in appropriate location

## Complete Example: Pitch Deck

```javascript
const PptxGenJS = require('pptxgenjs');
const pres = new PptxGenJS();
pres.layout = 'LAYOUT_WIDE';

// Title slide
const s1 = pres.addSlide();
s1.addText('Company Name', { x:1, y:1.5, w:8, fontSize:44, bold:true, color:'1a1a2e' });
s1.addText('Tagline here', { x:1, y:2.8, w:8, fontSize:24, color:'666666' });

// Problem slide
const s2 = pres.addSlide();
s2.addText('The Problem', { x:0.5, y:0.5, w:9, fontSize:32, bold:true, color:'1a1a2e' });
s2.addText('Description of the problem...', { x:0.8, y:1.5, w:8, fontSize:18, color:'333333' });

// Solution slide
const s3 = pres.addSlide();
s3.addText('Our Solution', { x:0.5, y:0.5, w:9, fontSize:32, bold:true, color:'1a1a2e' });

// Save
pres.writeFile({ fileName: 'pitch-deck.pptx' });
```

## When to Use

Use this skill for quick, template-based presentation creation. For advanced design, QA workflows, and complex editing, see the "PPTX (Advanced)" skill.
