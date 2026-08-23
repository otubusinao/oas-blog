/**
 * OAS Insights — Notion-powered static blog generator
 *
 * Source: Notion database + page blocks
 * Output: static HTML, sitemap, robots.txt, RSS feed and SEO metadata
 * Deployment: Cloudflare Pages via GitHub Actions
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SITE_URL = "https://blog.oassolutions.com.ng";
const OAS_URL = "https://oassolutions.com.ng";
const OKRIDE_URL = "https://okride.com.ng";
const SITE_NAME = "OAS Insights";
const COMPANY_NAME = "OAS Solutions Ltd";
const DEFAULT_DESCRIPTION = "Practical insights on technology, AI, digital transformation, software, mobility and entrepreneurship from OAS Solutions Ltd.";
const DEFAULT_OG = `${OAS_URL}/og-default.png`;

if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error("Missing NOTION_API_KEY or NOTION_DATABASE_ID environment variables");
  process.exit(1);
}

// ─── SAFETY / FORMATTING ─────────────────────────────────────────────────────

function escapeHTML(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value = "") {
  return escapeHTML(value);
}

function safeUrl(value = "") {
  try {
    const url = new URL(value, SITE_URL);
    if (["http:", "https:"].includes(url.protocol)) return url.href;
  } catch (_) {}
  return "";
}

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString("en-NG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function isoDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split("T")[0];
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? dateStr.slice(0, 10) : d.toISOString().split("T")[0];
}

function absoluteUrl(value = "") {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${SITE_URL}/${String(value).replace(/^\/+/, "")}`;
}

function stripHTML(html = "") {
  return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function wordCount(text = "") {
  const clean = stripHTML(text);
  return clean ? clean.split(/\s+/).length : 0;
}

function readingTime(text = "") {
  return Math.max(1, Math.ceil(wordCount(text) / 220));
}

function truncate(text = "", max = 160) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

// ─── NOTION API ───────────────────────────────────────────────────────────────

function notionRequest(endpoint, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.notion.com",
      path: `/v1${endpoint}`,
      method,
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) {
          reject(new Error(`Invalid Notion response (${res.statusCode})`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed.message || `Notion API error ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error("Notion request timed out")));
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function fetchPublishedPosts() {
  let all = [];
  let cursor;
  do {
    const body = {
      filter: { property: "Published", checkbox: { equals: true } },
      sorts: [{ property: "Date", direction: "descending" }],
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest(`/databases/${NOTION_DATABASE_ID}/query`, "POST", body);
    all = all.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all;
}

async function fetchPageBlocks(pageId) {
  let allBlocks = [];
  let cursor;
  do {
    const query = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = await notionRequest(`/blocks/${pageId}/children${query}`);
    allBlocks = allBlocks.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return allBlocks;
}

function getProperty(page, name, type) {
  const prop = page.properties?.[name];
  if (!prop) return type === "multi_select" ? [] : "";
  switch (type) {
    case "title": return prop.title?.map((t) => t.plain_text).join("") || "";
    case "text": return prop.rich_text?.map((t) => t.plain_text).join("") || "";
    case "checkbox": return Boolean(prop.checkbox);
    case "date": return prop.date?.start || "";
    case "select": return prop.select?.name || "";
    case "multi_select": return prop.multi_select?.map((t) => t.name).filter(Boolean) || [];
    case "url": return prop.url || "";
    default: return "";
  }
}

// ─── NOTION BLOCKS ────────────────────────────────────────────────────────────

function richText(items = []) {
  return items.map((item) => {
    let text = escapeHTML(item.plain_text || "");
    const a = item.annotations || {};
    if (a.code) text = `<code>${text}</code>`;
    if (a.bold) text = `<strong>${text}</strong>`;
    if (a.italic) text = `<em>${text}</em>`;
    if (a.strikethrough) text = `<del>${text}</del>`;
    if (a.underline) text = `<u>${text}</u>`;
    if (item.href) {
      const href = safeUrl(item.href);
      if (href) text = `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return text;
  }).join("");
}

function blockText(block) {
  const content = block?.[block.type];
  return content?.rich_text?.map((x) => x.plain_text).join("") || "";
}

function blocksToHTML(blocks) {
  const out = [];
  let listType = null;

  function closeList() {
    if (listType) out.push(`</${listType}>`);
    listType = null;
  }

  for (const block of blocks) {
    const type = block.type;
    const content = block[type] || {};

    if (type === "bulleted_list_item" || type === "numbered_list_item") {
      const wanted = type === "bulleted_list_item" ? "ul" : "ol";
      if (listType && listType !== wanted) closeList();
      if (!listType) { listType = wanted; out.push(`<${wanted}>`); }
      out.push(`<li>${richText(content.rich_text)}</li>`);
      continue;
    }
    closeList();

    switch (type) {
      case "heading_1": out.push(`<h2 class="post-h2">${richText(content.rich_text)}</h2>`); break;
      case "heading_2": out.push(`<h2 class="post-h2">${richText(content.rich_text)}</h2>`); break;
      case "heading_3": out.push(`<h3 class="post-h3">${richText(content.rich_text)}</h3>`); break;
      case "paragraph": {
        const text = richText(content.rich_text);
        if (text) out.push(`<p>${text}</p>`);
        break;
      }
      case "quote": out.push(`<blockquote>${richText(content.rich_text)}</blockquote>`); break;
      case "code": {
        const code = richText(content.rich_text);
        const language = content.language ? ` data-language="${escapeAttr(content.language)}"` : "";
        out.push(`<pre${language}><code>${code}</code></pre>`);
        break;
      }
      case "divider": out.push("<hr>"); break;
      case "callout": {
        const icon = content.icon?.emoji ? `<span class="callout-icon">${escapeHTML(content.icon.emoji)}</span>` : "";
        out.push(`<aside class="callout">${icon}<div>${richText(content.rich_text)}</div></aside>`);
        break;
      }
      case "image": {
        const url = content.type === "external" ? content.external?.url : content.file?.url;
        const caption = content.caption?.map((c) => c.plain_text).join("") || "";
        if (url) {
          out.push(`<figure><img src="${escapeAttr(url)}" alt="${escapeAttr(caption)}" loading="lazy" decoding="async"><figcaption>${escapeHTML(caption)}</figcaption></figure>`);
        }
        break;
      }
      case "bookmark":
      case "link_preview": {
        const url = safeUrl(content.url || content.link_preview?.url || "");
        if (url) out.push(`<p class="embedded-link"><a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(url)}</a></p>`);
        break;
      }
      case "table":
        // Table rows are separate blocks; keep a graceful fallback for unsupported nested rows.
        out.push("<div class=\"table-note\">Table content is available in the published source.</div>");
        break;
      case "child_page":
        out.push(`<p><strong>${escapeHTML(content.title || "Related page")}</strong></p>`);
        break;
      default:
        break;
    }
  }
  closeList();
  return out.join("\n");
}

function extractPlainText(blocks) {
  return blocks.map(blockText).filter(Boolean).join(" ");
}

// ─── CONTENT HELPERS ──────────────────────────────────────────────────────────

function extractCategories(posts) {
  const cats = new Set();
  posts.forEach((p) => getProperty(p, "Category", "multi_select").forEach((c) => cats.add(c)));
  return [...cats].sort((a, b) => a.localeCompare(b));
}

function getPostMeta(post) {
  const title = getProperty(post, "Title", "title");
  const summary = getProperty(post, "Summary", "text");
  const slug = getProperty(post, "Slug", "text") || slugify(title);
  const date = getProperty(post, "Date", "date");
  const categories = getProperty(post, "Category", "multi_select");
  const coverImage = getProperty(post, "Cover Image URL", "text");
  return { title, summary, slug, date, categories, coverImage };
}

function categorySlug(cat) { return slugify(cat); }
function postUrl(slug) { return `${SITE_URL}/posts/${encodeURIComponent(slug)}.html`; }
function categoryUrl(cat) { return `${SITE_URL}/category/${categorySlug(cat)}/`; }

function buildSearchIndex(posts) {
  return posts.map((p) => {
    const m = getPostMeta(p);
    return { title: m.title, summary: m.summary, slug: m.slug, date: m.date, categories: m.categories, coverImage: m.coverImage };
  });
}

function relatedPosts(currentPost, posts, limit = 3) {
  const current = getPostMeta(currentPost);
  return posts
    .filter((p) => p.id !== currentPost.id)
    .map((p) => {
      const m = getPostMeta(p);
      const overlap = m.categories.filter((c) => current.categories.includes(c)).length;
      return { p, score: overlap * 10 + (m.categories[0] === current.categories[0] ? 2 : 0) };
    })
    .sort((a, b) => b.score - a.score || new Date(getPostMeta(b.p).date) - new Date(getPostMeta(a.p).date))
    .slice(0, limit)
    .map((x) => x.p);
}

function categoryDescriptions() {
  return {
    "Business & Digital Transformation": "Practical thinking on business automation, digital operations and technology-led growth for Nigerian organizations.",
    "AI & Emerging Technology": "Clear, practical perspectives on artificial intelligence, machine learning and emerging technologies.",
    "Software & Web Development": "Engineering lessons on software, websites, APIs, cloud, mobile products and digital systems.",
    "OkRide & Mobility": "Insights from building technology for safer, smarter and more accessible mobility in Nigeria.",
    "Entrepreneurship & Startups": "Founder lessons, product development, innovation and the realities of building technology businesses in Nigeria.",
    "OAS Inside": "Product stories, milestones, experiments and lessons from the OAS Solutions team.",
  };
}

function getCategoryDescription(category) {
  return categoryDescriptions()[category] || `Insights and articles from OAS Solutions Ltd about ${category}.`;
}

// ─── DESIGN SYSTEM ────────────────────────────────────────────────────────────

function getBaseStyles() {
  return `
:root{--ink:#0A1628;--navy:#0A1F44;--blue:#1E56B0;--light:#EBF2FF;--sky:#3B82F6;--white:#fff;--paper:#F7F9FC;--line:#E5EAF2;--muted:#667085;--gold:#D4AF37;--shadow:0 16px 50px rgba(10,22,40,.08)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--white);line-height:1.7}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}img{max-width:100%}button,input{font:inherit}
.skip-link{position:absolute;left:-9999px;top:auto}.skip-link:focus{left:16px;top:16px;z-index:9999;background:#fff;padding:10px 14px;border-radius:8px}
.nav{position:sticky;top:0;z-index:1000;height:72px;background:rgba(255,255,255,.94);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}.nav-inner{max-width:1240px;height:100%;margin:auto;padding:0 5%;display:flex;align-items:center;justify-content:space-between;gap:28px}.brand{display:flex;align-items:center;gap:11px;font-weight:800;color:var(--ink);text-decoration:none}.brand-mark{width:38px;height:38px;border-radius:10px;background:var(--navy);color:#fff;display:grid;place-items:center;font-size:12px;letter-spacing:-.04em}.brand-copy{font-size:18px;letter-spacing:-.03em}.brand-copy span{color:var(--blue)}.nav-links{display:flex;align-items:center;gap:22px;list-style:none;margin:0;padding:0}.nav-links a{font-size:14px;font-weight:600;color:#475467}.nav-links a:hover{color:var(--blue);text-decoration:none}.nav-cta{background:var(--blue);color:#fff!important;padding:10px 17px;border-radius:9px}.nav-toggle{display:none;border:0;background:none;padding:8px}.nav-toggle span{display:block;width:22px;height:2px;background:var(--ink);margin:4px 0}
.container{max-width:1240px;margin:0 auto;padding-left:5%;padding-right:5%}.hero{background:linear-gradient(135deg,var(--navy),#102E5F 58%,#1E56B0);color:#fff;position:relative;overflow:hidden}.hero:after{content:"";position:absolute;width:520px;height:520px;border-radius:50%;right:-180px;top:-240px;background:rgba(59,130,246,.22);filter:blur(4px)}.hero-inner{position:relative;z-index:1;padding-top:86px;padding-bottom:78px;max-width:820px}.eyebrow{display:inline-flex;align-items:center;gap:9px;text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:800;color:rgba(255,255,255,.72);margin-bottom:18px}.eyebrow:before{content:"";width:24px;height:2px;background:var(--gold)}.hero h1{font-family:Georgia,"Times New Roman",serif;font-size:clamp(38px,6vw,66px);line-height:1.05;letter-spacing:-.045em;margin:0 0 18px}.hero p{max-width:700px;color:rgba(255,255,255,.72);font-size:18px;margin:0}.hero-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 18px;border-radius:9px;font-weight:700;font-size:14px;text-decoration:none}.btn-primary{background:#fff;color:var(--navy)}.btn-secondary{border:1px solid rgba(255,255,255,.24);color:#fff;background:rgba(255,255,255,.06)}
.page-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:44px;max-width:1240px;margin:0 auto;padding:62px 5%}.section-kicker{text-transform:uppercase;letter-spacing:.14em;color:var(--blue);font-size:11px;font-weight:800;margin-bottom:8px}.section-title{font-family:Georgia,"Times New Roman",serif;font-size:clamp(28px,4vw,38px);line-height:1.15;letter-spacing:-.03em;margin:0 0 25px;color:var(--ink)}
.featured{display:grid;grid-template-columns:1.15fr .85fr;border:1px solid var(--line);border-radius:20px;overflow:hidden;margin-bottom:42px;background:#fff;box-shadow:0 8px 30px rgba(10,22,40,.04)}.featured-image{min-height:310px;background:linear-gradient(135deg,#dbe8ff,#f5f8ff)}.featured-image img{width:100%;height:100%;object-fit:cover;display:block}.featured-copy{padding:34px}.post-category{display:inline-flex;background:var(--light);color:var(--blue);padding:4px 10px;border-radius:999px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin:0 5px 8px 0}.featured h2{font-family:Georgia,"Times New Roman",serif;font-size:30px;line-height:1.2;margin:12px 0}.featured h2 a{color:var(--ink)}.featured-summary{color:var(--muted);font-size:15px}.meta{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-top:20px}.read-more{font-weight:800;font-size:13px;display:inline-flex;margin-top:22px}
.search-wrap{position:relative;margin:0 0 18px}.search-wrap input{width:100%;padding:13px 16px 13px 43px;border:1px solid var(--line);border-radius:10px;outline:0;color:var(--ink);background:#fff}.search-wrap input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(30,86,176,.1)}.search-icon{position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--muted)}.category-nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:30px}.cat-pill{padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:#667085;font-size:12px;font-weight:700}.cat-pill:hover,.cat-pill.active{background:var(--blue);border-color:var(--blue);color:#fff;text-decoration:none}
.posts-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.post-card{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:#fff;transition:.25s ease}.post-card:hover{transform:translateY(-3px);box-shadow:var(--shadow);border-color:#c9d7ee}.post-card-image{height:190px;background:var(--paper);overflow:hidden}.post-card-image img{width:100%;height:100%;object-fit:cover;display:block}.post-card-body{padding:23px}.post-card h2{font-family:Georgia,"Times New Roman",serif;font-size:21px;line-height:1.25;margin:7px 0 10px}.post-card h2 a{color:var(--ink)}.post-card-summary{color:var(--muted);font-size:14px;margin:0}.post-card-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:18px}.post-date{font-size:12px;color:var(--muted)}
.sidebar{position:sticky;top:96px;align-self:start;display:flex;flex-direction:column;gap:20px}.widget{border:1px solid var(--line);border-radius:16px;padding:22px;background:#fff}.widget h3{font-family:Georgia,"Times New Roman",serif;margin:0 0 14px;font-size:18px}.widget p{font-size:13px;color:var(--muted);margin:0 0 15px}.widget ul{list-style:none;margin:0;padding:0}.widget li+li{border-top:1px solid var(--line)}.widget li a{display:flex;justify-content:space-between;gap:8px;padding:10px 0;color:#475467;font-size:13px}.count{background:var(--light);color:var(--blue);padding:1px 7px;border-radius:999px;font-size:11px;font-weight:800}.widget-cta{display:block;text-align:center;background:var(--blue);color:#fff!important;padding:10px 14px;border-radius:8px;font-weight:800;font-size:13px}.ad-slot{text-align:center;overflow:hidden}.ad-slot img{display:block;margin:auto;max-width:100%;height:auto;border-radius:8px}.ad-label{text-transform:uppercase;letter-spacing:.12em;color:#98a2b3;font-size:9px;margin-bottom:7px}.ad-leaderboard-mobile{display:none}
.post-header{background:linear-gradient(135deg,var(--navy),#12366f);color:#fff}.post-header-inner{max-width:900px;padding:76px 5% 68px;margin:auto}.post-header h1{font-family:Georgia,"Times New Roman",serif;font-size:clamp(34px,5.5vw,58px);line-height:1.08;letter-spacing:-.045em;margin:15px 0}.post-summary{font-size:18px;color:rgba(255,255,255,.72);max-width:760px}.post-container{max-width:1240px;margin:auto;padding:55px 5%;display:grid;grid-template-columns:minmax(0,800px) 300px;gap:44px}.post-body{font-family:Georgia,"Times New Roman",serif;font-size:18px;line-height:1.85;color:#344054}.post-body p{margin:0 0 24px}.post-body .post-h2{font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:28px;line-height:1.25;color:var(--ink);margin:44px 0 15px;letter-spacing:-.025em}.post-body .post-h3{font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:21px;line-height:1.3;color:var(--ink);margin:32px 0 10px}.post-body ul,.post-body ol{padding-left:25px;margin:0 0 24px}.post-body li{margin-bottom:9px}.post-body a{font-weight:600}.post-body blockquote{margin:30px 0;padding:18px 24px;border-left:4px solid var(--gold);background:#f8fafc;color:#475467}.post-body pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#101828;color:#d0d5dd;padding:20px;border-radius:12px;overflow:auto;font-size:13px;line-height:1.6}.post-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:var(--light);color:var(--blue);padding:2px 5px;border-radius:4px}.post-body pre code{background:none;color:inherit;padding:0}.post-body figure{margin:34px 0}.post-body figure img{width:100%;border-radius:14px;display:block}.post-body figcaption{text-align:center;color:var(--muted);font-family:Inter,ui-sans-serif,sans-serif;font-size:12px;margin-top:8px}.post-body hr{border:0;border-top:1px solid var(--line);margin:42px 0}.callout{display:flex;gap:12px;background:var(--light);border-left:4px solid var(--blue);padding:16px 18px;border-radius:0 10px 10px 0;margin:26px 0;font-family:Inter,ui-sans-serif,sans-serif;font-size:14px;color:#344054}.callout-icon{font-size:20px}.embedded-link{font-family:Inter,ui-sans-serif,sans-serif;background:var(--paper);border:1px solid var(--line);padding:12px 15px;border-radius:10px}.table-note{font-family:Inter,ui-sans-serif,sans-serif;background:var(--paper);border:1px solid var(--line);padding:14px;border-radius:10px;font-size:13px;color:var(--muted)}
.breadcrumbs{font-size:12px;color:rgba(255,255,255,.55);display:flex;gap:8px;flex-wrap:wrap}.breadcrumbs a{color:rgba(255,255,255,.75)}.author-card{display:flex;gap:15px;align-items:center;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:24px 0;margin-top:46px;font-family:Inter,ui-sans-serif,sans-serif}.avatar{width:52px;height:52px;border-radius:50%;background:var(--navy);color:#fff;display:grid;place-items:center;font-weight:900}.author-name{font-weight:800;color:var(--ink);font-size:14px}.author-role{font-size:12px;color:var(--muted)}.share{padding-top:25px;font-family:Inter,ui-sans-serif,sans-serif}.share-title{font-size:12px;text-transform:uppercase;letter-spacing:.12em;font-weight:800;color:var(--muted)}.share-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.share-links a{border:1px solid var(--line);padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;color:#475467}.related{margin-top:55px;padding-top:36px;border-top:1px solid var(--line)}.related h2{font-family:Georgia,"Times New Roman",serif;font-size:26px;margin:0 0 18px}.related-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.related-card{border:1px solid var(--line);border-radius:12px;padding:16px}.related-card h3{font-family:Inter,ui-sans-serif,sans-serif;font-size:15px;line-height:1.35;margin:7px 0}.related-card p{font-family:Inter,ui-sans-serif,sans-serif;font-size:11px;color:var(--muted);margin:0}.comments{margin-top:50px;padding-top:35px;border-top:1px solid var(--line)}
.cta-banner{margin-top:45px;background:linear-gradient(135deg,var(--navy),#163c7b);color:#fff;border-radius:18px;padding:28px}.cta-banner h2{font-family:Georgia,"Times New Roman",serif;margin:0 0 7px;font-size:25px}.cta-banner p{margin:0 0 16px;color:rgba(255,255,255,.7);font-size:14px}.cta-banner a{background:#fff;color:var(--navy);padding:10px 15px;border-radius:8px;font-weight:800;font-size:13px;display:inline-block}
footer{background:var(--navy);color:#fff;margin-top:30px}.footer-inner{max-width:1240px;margin:auto;padding:42px 5% 26px;display:flex;justify-content:space-between;gap:30px;flex-wrap:wrap}.footer-brand p{max-width:360px;color:rgba(255,255,255,.55);font-size:12px}.footer-links{display:flex;gap:18px;flex-wrap:wrap}.footer-links a{font-size:12px;color:rgba(255,255,255,.6)}.footer-bottom{text-align:center;border-top:1px solid rgba(255,255,255,.1);padding:17px 5%;font-size:11px;color:rgba(255,255,255,.38)}
.back-top{position:fixed;right:22px;bottom:22px;width:42px;height:42px;border:0;border-radius:50%;background:var(--blue);color:#fff;display:grid;place-items:center;box-shadow:0 8px 25px rgba(30,86,176,.3);cursor:pointer;opacity:0;visibility:hidden;transition:.2s;z-index:900}.back-top.show{opacity:1;visibility:visible}
.empty{text-align:center;padding:60px 20px;color:var(--muted)}.hidden{display:none!important}
@media(max-width:1020px){.page-layout,.post-container{grid-template-columns:1fr}.sidebar{position:static}.featured{grid-template-columns:1fr}.featured-image{min-height:240px}.post-container{padding-top:40px}.related-grid{grid-template-columns:1fr 1fr}}
@media(max-width:760px){.nav{height:64px}.nav-links{display:none;position:absolute;left:0;right:0;top:64px;background:#fff;border-bottom:1px solid var(--line);padding:10px 5% 18px;flex-direction:column;align-items:stretch;gap:0;box-shadow:0 15px 30px rgba(10,22,40,.08)}.nav-links.open{display:flex}.nav-links li{border-bottom:1px solid var(--line)}.nav-links a{display:block;padding:12px 0}.nav-cta{display:inline-block!important;margin-top:7px}.nav-toggle{display:block}.hero-inner{padding-top:58px;padding-bottom:55px}.hero p{font-size:16px}.page-layout{padding-top:42px}.posts-grid{grid-template-columns:1fr}.featured-copy{padding:25px}.featured h2{font-size:25px}.post-header-inner{padding-top:55px;padding-bottom:50px}.post-summary{font-size:16px}.post-body{font-size:17px}.post-container{padding-left:5%;padding-right:5%}.related-grid{grid-template-columns:1fr}.ad-leaderboard-desktop{display:none}.ad-leaderboard-mobile{display:block}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.post-card{transition:none}}
`;
}

function getNavHTML() {
  return `<a class="skip-link" href="#main-content">Skip to content</a>
  <header class="nav"><div class="nav-inner">
    <a class="brand" href="/"><span class="brand-mark">OAS</span><span class="brand-copy">OAS <span>Insights</span></span></a>
    <button class="nav-toggle" id="nav-toggle" aria-label="Open navigation" aria-expanded="false"><span></span><span></span><span></span></button>
    <ul class="nav-links" id="nav-links">
      <li><a href="/">Insights</a></li><li><a href="/category/ai-emerging-technology/">AI &amp; Tech</a></li><li><a href="/category/okride-mobility/">Mobility</a></li><li><a href="${OAS_URL}/#products">OAS Products</a></li><li><a href="${OKRIDE_URL}">OkRide</a></li><li><a class="nav-cta" href="${OAS_URL}/#contact">Work with OAS</a></li>
    </ul>
  </div></header>
  <script>(function(){const b=document.getElementById('nav-toggle'),n=document.getElementById('nav-links');if(!b||!n)return;b.addEventListener('click',()=>{const o=n.classList.toggle('open');b.setAttribute('aria-expanded',o?'true':'false')});n.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{n.classList.remove('open');b.setAttribute('aria-expanded','false')}));})();</script>`;
}

function getFooterHTML() {
  return `<footer><div class="footer-inner"><div class="footer-brand"><a class="brand" href="${OAS_URL}"><span class="brand-mark">OAS</span><span class="brand-copy" style="color:#fff">OAS <span>Solutions</span></span></a><p>OAS Insights is the knowledge platform of OAS Solutions Ltd — documenting ideas, technology, products and lessons from building digital solutions in Nigeria.</p></div><div class="footer-links"><a href="${OAS_URL}">OAS Solutions</a><a href="${OKRIDE_URL}">OkRide</a><a href="${OAS_URL}/privacy">Privacy</a><a href="${OAS_URL}/terms">Terms</a><a href="${OAS_URL}/#contact">Contact</a></div></div><div class="footer-bottom">© ${new Date().getFullYear()} ${COMPANY_NAME}. RC No. RC7765644. All rights reserved.</div></footer>`;
}

function getAdHTML(size = "leaderboard") {
  const base = "https://eu2.contabostorage.com/0929d2ec15194ce3b3cba7a318485ab8:go54/Affiliate";
  const map = {
    leaderboard: [`${base}/728x90/affilliates-1.1.webp`, "728", "90", `${base}/320x100/affilliates-4.1.webp`, "320", "100"],
    rectangle: [`${base}/336x280/affilliates-5.1.webp`, "336", "280", `${base}/300X250/affilliates-2.webp`, "300", "250"],
    sidebar: [`${base}/160*600/affilliates-2.1.webp`, "160", "600", `${base}/300X250/affilliates-1.webp`, "300", "250"],
  };
  const m = map[size] || map.leaderboard;
  return `<div class="ad-slot"><div class="ad-label">Advertisement</div><div class="ad-leaderboard-desktop"><a href="https://app.go54.com/signup?aff=ademuyiwao" target="_blank" rel="noopener sponsored"><img src="${m[0]}" width="${m[1]}" height="${m[2]}" alt="Go54 web hosting" loading="lazy"></a></div><div class="ad-leaderboard-mobile"><a href="https://app.go54.com/signup?aff=ademuyiwao" target="_blank" rel="noopener sponsored"><img src="${m[3]}" width="${m[4]}" height="${m[5]}" alt="Go54 web hosting" loading="lazy"></a></div></div>`;
}

function getSidebarHTML(posts, categories, activeCategory = null) {
  const recent = posts.slice(0, 5).map((p) => {
    const m = getPostMeta(p);
    return `<li><a href="/posts/${encodeURIComponent(m.slug)}.html"><span>${escapeHTML(m.title)}</span><small>${escapeHTML(formatDate(m.date))}</small></a></li>`;
  }).join("");
  const cats = categories.map((cat) => {
    const count = posts.filter((p) => getPostMeta(p).categories.includes(cat)).length;
    return `<li><a href="/category/${categorySlug(cat)}/" ${cat === activeCategory ? 'style="color:var(--blue);font-weight:800"' : ""}><span>${escapeHTML(cat)}</span><span class="count">${count}</span></a></li>`;
  }).join("");
  return `<aside class="sidebar" aria-label="Sidebar">
    <div class="widget"><h3>About OAS Insights</h3><p>Practical thinking from OAS Solutions on technology, AI, digital transformation, mobility and entrepreneurship.</p><a class="widget-cta" href="${OAS_URL}/#contact">Talk to OAS →</a></div>
    <div class="widget"><h3>Explore topics</h3><ul>${cats || '<li>No categories yet.</li>'}</ul></div>
    <div class="widget"><h3>Recent insights</h3><ul>${recent || '<li>No posts yet.</li>'}</ul></div>
    <div class="widget">${getAdHTML("sidebar")}</div>
  </aside>`;
}

function getBackTop() { return `<button class="back-top" id="back-top" aria-label="Back to top">↑</button><script>(function(){const b=document.getElementById('back-top');if(!b)return;addEventListener('scroll',()=>b.classList.toggle('show',scrollY>500),{passive:true});b.onclick=()=>scrollTo({top:0,behavior:'smooth'});})();</script>`; }

function commonHead({ title, description, canonical, image = DEFAULT_OG, type = "website", jsonld = null }) {
  const json = jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : "";
  return `<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0A1F44"><meta name="description" content="${escapeAttr(truncate(description || DEFAULT_DESCRIPTION, 160))}"><link rel="canonical" href="${escapeAttr(canonical)}"><link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="${SITE_URL}/rss.xml"><link rel="icon" href="${OAS_URL}/favicon.svg" type="image/svg+xml"><meta property="og:title" content="${escapeAttr(title)}"><meta property="og:description" content="${escapeAttr(truncate(description || DEFAULT_DESCRIPTION, 200))}"><meta property="og:url" content="${escapeAttr(canonical)}"><meta property="og:type" content="${type}"><meta property="og:site_name" content="${SITE_NAME}"><meta property="og:image" content="${escapeAttr(image)}"><meta property="og:image:alt" content="${escapeAttr(title)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeAttr(title)}"><meta name="twitter:description" content="${escapeAttr(truncate(description || DEFAULT_DESCRIPTION, 200))}"><meta name="twitter:image" content="${escapeAttr(image)}"><title>${escapeHTML(title)}</title>${json}`;
}

function pageShell({ title, head, body }) {
  return `<!doctype html><html lang="en"><head>${head}<link rel="preconnect" href="https://fonts.googleapis.com"><style>${getBaseStyles()}</style></head><body>${getNavHTML()}${body}${getFooterHTML()}${getBackTop()}</body></html>`;
}

// ─── INDEX ────────────────────────────────────────────────────────────────────

function generateIndexPage(posts) {
  const categories = extractCategories(posts);
  const searchIndex = buildSearchIndex(posts);
  const featured = posts[0];
  const featuredMeta = featured ? getPostMeta(featured) : null;

  const cards = posts.map((post) => {
    const m = getPostMeta(post);
    return `<article class="post-card"><a href="/posts/${encodeURIComponent(m.slug)}.html" aria-label="Read ${escapeAttr(m.title)}">${m.coverImage ? `<div class="post-card-image"><img src="${escapeAttr(m.coverImage)}" alt="${escapeAttr(m.title)}" loading="lazy" decoding="async"></div>` : ""}</a><div class="post-card-body">${m.categories.slice(0,2).map(c=>`<span class="post-category">${escapeHTML(c)}</span>`).join("")}<h2><a href="/posts/${encodeURIComponent(m.slug)}.html">${escapeHTML(m.title)}</a></h2><p class="post-card-summary">${escapeHTML(m.summary)}</p><div class="post-card-footer"><span class="post-date">${escapeHTML(formatDate(m.date))}</span><a class="read-more" href="/posts/${encodeURIComponent(m.slug)}.html">Read →</a></div></div></article>`;
  }).join("");

  const featuredHTML = featured ? `<article class="featured"><div class="featured-image">${featuredMeta.coverImage ? `<img src="${escapeAttr(featuredMeta.coverImage)}" alt="${escapeAttr(featuredMeta.title)}">` : ""}</div><div class="featured-copy"><div class="section-kicker">Featured insight</div>${featuredMeta.categories.slice(0,2).map(c=>`<span class="post-category">${escapeHTML(c)}</span>`).join("")}<h2><a href="/posts/${encodeURIComponent(featuredMeta.slug)}.html">${escapeHTML(featuredMeta.title)}</a></h2><p class="featured-summary">${escapeHTML(featuredMeta.summary)}</p><div class="meta"><span>${escapeHTML(formatDate(featuredMeta.date))}</span><span>•</span><span>${readingTime(featuredMeta.summary)} min read</span></div><a class="read-more" href="/posts/${encodeURIComponent(featuredMeta.slug)}.html">Read the insight →</a></div></article>` : "";

  const schema = {
    "@context":"https://schema.org","@type":"Blog","name":SITE_NAME,"url":SITE_URL,"description":DEFAULT_DESCRIPTION,
    "publisher":{"@type":"Organization","name":COMPANY_NAME,"url":OAS_URL},
    "blogPost":posts.slice(0,10).map(p=>{const m=getPostMeta(p);return {"@type":"BlogPosting","headline":m.title,"url":postUrl(m.slug),"datePublished":isoDate(m.date)};})
  };

  const body = `<main id="main-content"><section class="hero"><div class="container hero-inner"><div class="eyebrow">OAS Solutions Ltd</div><h1>Ideas, technology and lessons from building in Nigeria.</h1><p>OAS Insights documents what we are learning while building digital products, applying AI, solving business problems and creating technology for real-world needs.</p><div class="hero-actions"><a class="btn btn-primary" href="#latest">Explore insights</a><a class="btn btn-secondary" href="${OAS_URL}/#products">Explore OAS products</a></div></div></section><div class="page-layout"><main class="page-main"><div id="latest" class="section-kicker">Latest thinking</div><h2 class="section-title">Featured insight</h2>${featuredHTML}<div class="section-kicker">Browse the library</div><h2 class="section-title">Latest insights</h2><div class="search-wrap"><span class="search-icon">⌕</span><input id="blog-search" type="search" placeholder="Search insights by topic or keyword…" aria-label="Search insights" autocomplete="off"></div>${getCategoryNavHTML(categories)}<div id="search-results"></div><div id="posts-grid" class="posts-grid">${cards || '<div class="empty">No published insights yet.</div>'}</div></main>${getSidebarHTML(posts,categories)}</div></main><script>const SEARCH_INDEX=${JSON.stringify(searchIndex)};const input=document.getElementById('blog-search'),grid=document.getElementById('posts-grid'),results=document.getElementById('search-results');const pills=[...document.querySelectorAll('.cat-pill')];let active='all';function card(p){return '<article class="post-card"><div class="post-card-body">'+(p.categories||[]).slice(0,2).map(c=>'<span class="post-category">'+c+'</span>').join('')+'<h2><a href="/posts/'+encodeURIComponent(p.slug)+'.html">'+p.title+'</a></h2><p class="post-card-summary">'+p.summary+'</p><div class="post-card-footer"><span class="post-date">'+new Date(p.date).toLocaleDateString('en-NG',{year:'numeric',month:'long',day:'numeric'})+'</span><a class="read-more" href="/posts/'+encodeURIComponent(p.slug)+'.html">Read →</a></div></div></article>'}function render(){const q=(input.value||'').trim().toLowerCase();const m=SEARCH_INDEX.filter(p=>(active==='all'||(p.categories||[]).includes(active))&&(!q||[p.title,p.summary,(p.categories||[]).join(' ')].join(' ').toLowerCase().includes(q)));if(!q&&active==='all'){grid.classList.remove('hidden');results.innerHTML='';return}grid.classList.add('hidden');results.innerHTML=m.length?'<p class="meta"><strong>'+m.length+'</strong> matching insight'+(m.length===1?'':'s')+'</p><div class="posts-grid">'+m.map(card).join('')+'</div>':'<div class="empty">No matching insights found.</div>'}input.addEventListener('input',render);pills.forEach(p=>p.addEventListener('click',e=>{e.preventDefault();active=p.dataset.category;pills.forEach(x=>x.classList.toggle('active',x.dataset.category===active));render()}));</script>`;
  return pageShell({ title: `${SITE_NAME} — Technology, AI, Mobility & Business Insights`, head: commonHead({title:`${SITE_NAME} — Technology, AI, Mobility & Business Insights`,description:DEFAULT_DESCRIPTION,canonical:SITE_URL+"/",jsonld:schema}), body });
}

function getCategoryNavHTML(categories, active = null) {
  return `<nav class="category-nav" aria-label="Browse topics"><a class="cat-pill ${active===null?'active':''}" data-category="all" href="/">All</a>${categories.map(c=>`<a class="cat-pill ${active===c?'active':''}" data-category="${escapeAttr(c)}" href="/category/${categorySlug(c)}/">${escapeHTML(c)}</a>`).join("")}</nav>`;
}

// ─── CATEGORY ─────────────────────────────────────────────────────────────────

function generateCategoryPage(category, posts, categories) {
  const filtered = posts.filter(p=>getPostMeta(p).categories.includes(category));
  const cards = filtered.map(p=>{const m=getPostMeta(p);return `<article class="post-card"><a href="/posts/${encodeURIComponent(m.slug)}.html">${m.coverImage?`<div class="post-card-image"><img src="${escapeAttr(m.coverImage)}" alt="${escapeAttr(m.title)}" loading="lazy"></div>`:""}</a><div class="post-card-body">${m.categories.map(c=>`<span class="post-category">${escapeHTML(c)}</span>`).join("")}<h2><a href="/posts/${encodeURIComponent(m.slug)}.html">${escapeHTML(m.title)}</a></h2><p class="post-card-summary">${escapeHTML(m.summary)}</p><div class="post-card-footer"><span class="post-date">${escapeHTML(formatDate(m.date))}</span><a class="read-more" href="/posts/${encodeURIComponent(m.slug)}.html">Read →</a></div></div></article>`}).join("");
  const description=getCategoryDescription(category); const url=categoryUrl(category);
  const schema={"@context":"https://schema.org","@type":"CollectionPage","name":`${category} — ${SITE_NAME}`,"url":url,"description":description,"isPartOf":{"@type":"Blog","name":SITE_NAME,"url":SITE_URL}};
  const body=`<main id="main-content"><section class="hero"><div class="container hero-inner"><div class="eyebrow"><a href="/" style="color:inherit">OAS Insights</a></div><h1>${escapeHTML(category)}</h1><p>${escapeHTML(description)}</p></div></section><div class="page-layout"><main class="page-main"><div class="section-kicker">Topic archive</div><h2 class="section-title">${filtered.length} insight${filtered.length===1?'':'s'}</h2><div class="posts-grid">${cards||'<div class="empty">No published insights in this topic yet.</div>'}</div></main>${getSidebarHTML(posts,categories,category)}</div></main>`;
  return pageShell({title:`${category} — ${SITE_NAME}`,head:commonHead({title:`${category} — ${SITE_NAME}`,description,canonical:url,jsonld:schema}),body});
}

// ─── POST ─────────────────────────────────────────────────────────────────────

function generatePostPage(post, blocks, posts, categories) {
  const m=getPostMeta(post); const content=blocksToHTML(blocks); const text=extractPlainText(blocks); const url=postUrl(m.slug); const image=absoluteUrl(m.coverImage)||DEFAULT_OG; const related=relatedPosts(post,posts,3);
  const tags=m.categories.map(c=>`<a class="post-category" href="/category/${categorySlug(c)}/">${escapeHTML(c)}</a>`).join("");
  const relatedHTML=related.map(p=>{const r=getPostMeta(p);return `<article class="related-card">${r.categories[0]?`<span class="post-category">${escapeHTML(r.categories[0])}</span>`:""}<h3><a href="/posts/${encodeURIComponent(r.slug)}.html">${escapeHTML(r.title)}</a></h3><p>${escapeHTML(formatDate(r.date))}</p></article>`}).join("");
  const schema={"@context":"https://schema.org","@type":"BlogPosting","headline":m.title,"description":m.summary,"url":url,"datePublished":isoDate(m.date),"dateModified":isoDate(m.date),"author":{"@type":"Person","name":"Ademuyiwa Otubusin","jobTitle":"Founder & CEO","worksFor":{"@type":"Organization","name":COMPANY_NAME,"url":OAS_URL}},"publisher":{"@type":"Organization","name":COMPANY_NAME,"url":OAS_URL,"logo":{"@type":"ImageObject","url":`${OAS_URL}/android-chrome-512x512.png`}},"image":image,"mainEntityOfPage":{"@type":"WebPage","@id":url},"articleSection":m.categories};
  const body=`<main id="main-content"><header class="post-header"><div class="post-header-inner"><div class="breadcrumbs"><a href="/">OAS Insights</a><span>›</span>${m.categories[0]?`<a href="/category/${categorySlug(m.categories[0])}/">${escapeHTML(m.categories[0])}</a><span>›</span>`:""}<span>${escapeHTML(m.title)}</span></div><div style="margin-top:22px">${tags}</div><h1>${escapeHTML(m.title)}</h1><p class="post-summary">${escapeHTML(m.summary)}</p><div class="meta" style="color:rgba(255,255,255,.55)"><span>${escapeHTML(formatDate(m.date))}</span><span>•</span><span>${readingTime(text)} min read</span></div></div></header><div style="padding:22px 5% 0;max-width:1240px;margin:auto">${getAdHTML('leaderboard')}</div><div class="post-container"><article class="page-main"><div class="post-body">${content}</div><div class="cta-banner"><h2>Building something that matters?</h2><p>OAS Solutions helps organizations turn ideas, business problems and opportunities into practical digital products.</p><a href="${OAS_URL}/#contact">Talk to OAS Solutions →</a></div><div class="author-card"><div class="avatar">A</div><div><div class="author-name">Ademuyiwa Otubusin</div><div class="author-role">Founder &amp; CEO, OAS Solutions Ltd</div></div></div><div class="share"><div class="share-title">Share this insight</div><div class="share-links"><a target="_blank" rel="noopener" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}">LinkedIn</a><a target="_blank" rel="noopener" href="https://api.whatsapp.com/send?text=${encodeURIComponent(m.title+' — '+url)}">WhatsApp</a><a target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(m.title)}&url=${encodeURIComponent(url)}">X</a></div></div><section class="comments"><h2 class="section-title" style="font-size:25px;margin-bottom:7px">Join the conversation</h2><p style="color:var(--muted);font-size:13px">Comments are powered by GitHub Discussions.</p><script src="https://giscus.app/client.js" data-repo="tay4real/oas-blog" data-repo-id="R_kgDOSib5Pw" data-category="Announcements" data-category-id="DIC_kwDOSib5P84C9dFj" data-mapping="pathname" data-strict="0" data-reactions-enabled="1" data-emit-metadata="0" data-input-position="bottom" data-theme="light" data-lang="en" crossorigin="anonymous" async></script></section>${relatedHTML?`<section class="related"><h2>More from OAS Insights</h2><div class="related-grid">${relatedHTML}</div></section>`:""}</article>${getSidebarHTML(posts,categories,m.categories[0]||null)}</div></main>`;
  return pageShell({title:`${m.title} — ${SITE_NAME}`,head:commonHead({title:`${m.title} — ${SITE_NAME}`,description:m.summary,canonical:url,image,type:'article',jsonld:schema}),body});
}

// ─── SEO FILES ────────────────────────────────────────────────────────────────

function generateSitemap(posts,categories){const today=new Date().toISOString().split('T')[0];let urls=`<url><loc>${SITE_URL}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`;categories.forEach(c=>{urls+=`<url><loc>${categoryUrl(c)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`});posts.forEach(p=>{const m=getPostMeta(p);urls+=`<url><loc>${postUrl(m.slug)}</loc><lastmod>${isoDate(m.date)}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`});return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;}

function generateRobots(){return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`}
function generateRSS(posts){const items=posts.slice(0,30).map(p=>{const m=getPostMeta(p);return `<item><title><![CDATA[${m.title}]]></title><link>${postUrl(m.slug)}</link><guid isPermaLink="true">${postUrl(m.slug)}</guid><description><![CDATA[${m.summary}]]></description><pubDate>${new Date(m.date||Date.now()).toUTCString()}</pubDate></item>`}).join('');return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${SITE_NAME}</title><link>${SITE_URL}/</link><description>${DEFAULT_DESCRIPTION}</description><language>en-ng</language>${items}</channel></rss>`;}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function generate(){
  console.log("🚀 OAS Insights generator starting...");
  const dist=path.join(__dirname,'dist'); const postsDir=path.join(dist,'posts'); const catDir=path.join(dist,'category');
  fs.rmSync(dist,{recursive:true,force:true}); fs.mkdirSync(postsDir,{recursive:true}); fs.mkdirSync(catDir,{recursive:true});
  const posts=await fetchPublishedPosts(); console.log(`📚 ${posts.length} published post(s)`);
  const categories=extractCategories(posts); console.log(`🏷️ ${categories.length} categor${categories.length===1?'y':'ies'}`);
  fs.writeFileSync(path.join(dist,'index.html'),generateIndexPage(posts));
  for(const cat of categories){const dir=path.join(catDir,categorySlug(cat));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.html'),generateCategoryPage(cat,posts,categories));}
  for(const post of posts){const m=getPostMeta(post);if(!m.slug){console.warn(`⚠️ Skipping ${m.title}: missing slug`);continue;}const blocks=await fetchPageBlocks(post.id);fs.writeFileSync(path.join(postsDir,`${m.slug}.html`),generatePostPage(post,blocks,posts,categories));console.log(`📝 ${m.slug}`);}
  fs.writeFileSync(path.join(dist,'sitemap.xml'),generateSitemap(posts,categories));
  fs.writeFileSync(path.join(dist,'robots.txt'),generateRobots());
  fs.writeFileSync(path.join(dist,'rss.xml'),generateRSS(posts));
  fs.writeFileSync(path.join(dist,'llms.txt'),`# ${SITE_NAME}\n\n${DEFAULT_DESCRIPTION}\n\nWebsite: ${SITE_URL}/\nCompany: ${OAS_URL}/\nProduct: ${OKRIDE_URL}/\nRSS: ${SITE_URL}/rss.xml\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  console.log(`✅ Generated ${posts.length} posts, ${categories.length} categories, sitemap, RSS and llms.txt`);
}

generate().catch(err=>{console.error("❌ Generation failed:",err.stack||err.message);process.exit(1)});
