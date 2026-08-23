# OAS Insights

Notion-powered editorial platform for **OAS Solutions Ltd**, published at:

**https://blog.oassolutions.com.ng**

OAS Insights is designed as an authority and SEO platform for OAS — covering technology, AI, digital transformation, software, mobility, entrepreneurship and the products we build.

## Publishing workflow

1. Create an article in the OAS Blog Notion database.
2. Fill in **Title, Slug, Summary, Date, Category** and **Cover Image URL** where available.
3. Tick **Published**.
4. GitHub Actions rebuilds the repository every 6 hours (and can also be triggered manually).
5. The connected Cloudflare Pages project deploys the updated `dist/` directory.

## Notion properties

| Property | Type | Required | Purpose |
|---|---|---:|---|
| Title | Title | Yes | Article title |
| Slug | Text | Recommended | Stable URL slug; falls back to title slugification |
| Summary | Text | Recommended | Search/social/card description |
| Published | Checkbox | Yes | Controls publication |
| Date | Date | Recommended | Publication date |
| Category | Multi-select | Recommended | Topic/category |
| Cover Image URL | Text | Optional | Absolute URL for article/card image |

The generator remains compatible with the current database; no new property is required for the upgrade.

## What the generator now creates

- Editorial-style OAS Insights homepage
- Featured latest article
- Search and topic filtering
- SEO-friendly category archive pages
- Article pages with canonical URLs
- Open Graph and X/Twitter metadata
- BlogPosting / CollectionPage / Blog structured data
- Related-article recommendations
- Author attribution
- Reading-time estimate
- Social sharing buttons
- Giscus comments
- XML sitemap
- `robots.txt`
- RSS feed at `/rss.xml`
- `llms.txt` for machine-readable site discovery
- Mobile navigation and responsive layouts
- Accessibility improvements and reduced-motion support
- Automatic internal links between articles, categories and OAS products

## Local build

```bash
NOTION_API_KEY=your_key NOTION_DATABASE_ID=your_db_id node generate.js
```

The generated site is written to `dist/`.

## Cloudflare Pages

The existing Cloudflare Pages setup can continue using:

- Build command: `node generate.js`
- Build output directory: `dist`
- Environment variables: `NOTION_API_KEY`, `NOTION_DATABASE_ID`

The GitHub workflow touches `.last-rebuild` every six hours so a connected Cloudflare Pages project receives a new commit and rebuilds the site.

## Strategic content direction

Prioritize original, experience-backed content in these clusters:

- AI & Emerging Technology
- Business & Digital Transformation
- Software & Web Development
- OkRide & Mobility
- Entrepreneurship & Startups
- OAS Inside

The goal is not to publish generic SEO filler. The strongest OAS content should document what the company is actually building, testing, learning and observing in the Nigerian market.

---

© 2026 OAS Solutions Ltd. RC No. RC7765644. All rights reserved.
