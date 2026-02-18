---
id: preloaded-seo-audit
name: SEO Audit
description: Conduct SEO audits — technical SEO, on-page optimization, content gaps, and keyword analysis.
---
# SEO Audit

Conduct comprehensive SEO audits for websites and content.

## Audit Checklist

### Technical SEO
- [ ] Site loads in under 3 seconds
- [ ] Mobile-friendly / responsive
- [ ] HTTPS enabled
- [ ] XML sitemap exists and is submitted
- [ ] robots.txt is configured correctly
- [ ] No broken links (404s)
- [ ] Canonical URLs set
- [ ] Structured data / schema markup
- [ ] Core Web Vitals passing

### On-Page SEO
- [ ] Title tags unique and under 60 characters
- [ ] Meta descriptions unique and under 160 characters
- [ ] H1 tag present on every page (one per page)
- [ ] Header hierarchy (H1 > H2 > H3)
- [ ] Image alt text on all images
- [ ] Internal linking between related pages
- [ ] URL structure is clean and descriptive
- [ ] Content is at least 300 words per page

### Content Quality
- [ ] Content matches search intent
- [ ] Original content (not duplicate)
- [ ] Updated within last 12 months
- [ ] Includes target keywords naturally
- [ ] Provides clear value to reader
- [ ] Includes multimedia (images, video)

### Off-Page SEO
- [ ] Backlink profile is healthy
- [ ] No toxic/spammy backlinks
- [ ] Google Business Profile (if local)
- [ ] Social media profiles linked

## Quick Audit Process

### Step 1: Crawl the Site
```bash
# Use curl to check key pages
curl -sI https://example.com | head -20
curl -s https://example.com/sitemap.xml | head -50
curl -s https://example.com/robots.txt
```

### Step 2: Check Key Metrics
```bash
# Page speed (via PageSpeed Insights API)
# Mobile-friendly test
# Check for broken links
```

### Step 3: Analyze Content
- Identify thin pages (under 300 words)
- Find duplicate content
- Check keyword coverage
- Map content to search intent

### Step 4: Generate Report
Create a Papr document with findings, priority issues, and recommendations.

## Keyword Analysis

### Finding Keywords
- Seed keywords from business/topic
- Expand with related terms
- Check search volume and competition
- Group by intent (informational, transactional, navigational)

### Optimizing Content
- Primary keyword in title, H1, first paragraph
- Secondary keywords in H2s and body
- Natural language — don't keyword stuff
- Include long-tail variations

## Report Template

```markdown
# SEO Audit: [Website]
## Executive Summary
## Technical Issues (Priority)
## On-Page Opportunities
## Content Gaps
## Keyword Recommendations
## Action Plan (30/60/90 day)
```
