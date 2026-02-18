---
id: preloaded-pptx-advanced
name: PPTX (Advanced)
description: Advanced PowerPoint creation, editing, and QA with design systems, color palettes, and multi-slide workflows.
---
# PPTX (Advanced)

Advanced PowerPoint creation and editing skill using Python (`python-pptx`) for complex presentations with design systems, QA workflows, and professional layouts.

## When to Use

Use this skill for:
- Complex presentations requiring design consistency
- Editing existing PPTX files
- QA review of presentation content and design
- Multi-section presentations with varied layouts
- Presentations requiring custom color palettes and branding

For quick, template-based slides, see "Slides Creator (Quick)".

## Tools

Use `bash` to run Python scripts with `python-pptx`:

```bash
pip install python-pptx Pillow
```

## Design System Approach

### Step 1: Define Color Palette
```python
PALETTE = {
    'primary': '#1a1a2e',
    'secondary': '#0f3460',
    'accent': '#e94560',
    'background': '#ffffff',
    'text': '#333333',
    'muted': '#888888'
}
```

### Step 2: Define Typography
```python
FONTS = {
    'title': ('Helvetica Neue', 36, True),    # (face, size, bold)
    'subtitle': ('Helvetica Neue', 24, False),
    'body': ('Helvetica Neue', 18, False),
    'caption': ('Helvetica Neue', 12, False),
}
```

### Step 3: Create Slide Templates
Build reusable slide factories for each layout type.

## Common Layouts

### Title Slide
Full-width title with subtitle and optional background.

### Section Divider
Large text divider between presentation sections.

### Content + Bullets
Title with 3-5 bullet points, consistent spacing.

### Two-Column
Side-by-side comparison or text + image layout.

### Data/Chart
Embedded charts (bar, line, pie) with clear labels.

### Image Gallery
1-4 images with captions in grid layout.

## Editing Existing PPTX

```python
from pptx import Presentation
prs = Presentation('existing.pptx')

for slide in prs.slides:
    for shape in slide.shapes:
        if shape.has_text_frame:
            for paragraph in shape.text_frame.paragraphs:
                # Modify text
                pass

prs.save('modified.pptx')
```

## QA Workflow

### Content QA
1. Extract all text from slides
2. Check for spelling/grammar issues
3. Verify consistent terminology
4. Ensure key messages are present

### Design QA
1. Check font consistency across slides
2. Verify color palette adherence
3. Check alignment and spacing
4. Ensure images are high resolution
5. Verify slide transitions are appropriate

### Accessibility QA
1. Ensure sufficient color contrast
2. Check text size minimums (18pt for body)
3. Verify alt text on images
4. Check reading order

## Best Practices

- Start with a design brief and color palette
- Use slide masters for consistency
- Limit text per slide (6 lines max, 6 words per line)
- Use high-quality images (minimum 1920x1080)
- Test on projector/screen before finalizing
- Save both .pptx and .pdf versions
