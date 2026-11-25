#!/usr/bin/env node
/**
 * ret2shell-seo-generator
 *
 * Reads the public wiki, bulletin and game content directly from the
 * Ret2Shell PostgreSQL database and writes:
 *
 *   output/sitemap.xml
 *   output/rss.xml
 *
 * Game full content is stored in `article` and linked from
 * `game.introduction_id`; wiki and bulletin content also live in `article`.
 *
 * Run this once (cron is fine), then serve the output directory with nginx.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { marked } from "marked";
import pg from "pg";
import sanitizeHtml from "sanitize-html";

const { Client } = pg;

const DEFAULT_SITE_NAME = "Ret2Shell";
const DEFAULT_SITE_DESCRIPTION = "A feature-riches CTF challenge platform.";
const DEFAULT_SITE_LANGUAGE = "zh-CN";
const DEFAULT_STATIC_PATHS = ["/", "/wiki", "/bulletin", "/games"];
// RSS is a recent-items feed, not an archive; the sitemap covers all URLs.
const DEFAULT_FEED_LIMIT = 30;
const DEFAULT_OUTPUT_DIR = path.resolve(import.meta.dirname, "output");
const MAX_FEED_LIMIT = 200;
const DB_STATEMENT_TIMEOUT = "30s";

const HELP = `Usage: node generate.mjs [options]

Generate sitemap.xml and rss.xml from a Ret2Shell PostgreSQL database.

Options:
  --out <dir>       output directory (default: $SEO_OUTPUT_DIR or ./output)
  --limit <n>       maximum number of RSS items (default: $FEED_LIMIT or ${DEFAULT_FEED_LIMIT})
  --self-test       generate from built-in fixtures, without touching the database
  -h, --help        show this help

Environment:
  DATABASE_URL      PostgreSQL DSN. Required unless --self-test is used.
  SITE_URL          public site origin, e.g. https://ctf.example.com. Required.
  SITE_NAME         site / feed title (default: ${DEFAULT_SITE_NAME})
  SITE_DESCRIPTION  site / feed description (default: ${DEFAULT_SITE_DESCRIPTION})
  SITE_LANGUAGE     RSS language (default: ${DEFAULT_SITE_LANGUAGE})
  SEO_OUTPUT_DIR    output directory (overridden by --out)
  SEO_STATIC_PATHS  comma-separated static paths (default: ${DEFAULT_STATIC_PATHS.join(",")})
  BUCKET_PATH       optional game bucket root; reads <bucket>/README.md when present

The database user should be read-only. This program sets
default_transaction_read_only=on for its session.
`;

const ALLOWED_TAGS = [
  ...new Set([
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "del",
    "input",
    "details",
    "summary",
  ]),
];

function fail(message) {
  throw new Error(message);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function cleanXmlChars(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function escapeXml(value) {
  return cleanXmlChars(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cdata(value) {
  return `<![CDATA[${cleanXmlChars(value).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function toDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatRfc822(value) {
  const date = toDate(value);
  return date ? date.toUTCString() : null;
}

function formatW3c(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function formatDisplayDate(value) {
  const date = toDate(value);
  return date ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

function latestDate(...values) {
  let latest = null;
  for (const value of values) {
    const date = toDate(value);
    if (date && (!latest || date > latest)) {
      latest = date;
    }
  }
  return latest;
}

function normalizeSiteUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("SITE_URL must be an absolute URL, e.g. https://ctf.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("SITE_URL must use http or https");
  }
  if (url.search || url.hash) {
    fail("SITE_URL must not contain a query string or fragment");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

function buildUrl(siteBase, pathname) {
  return new URL(String(pathname).replace(/^\/+/, ""), siteBase).href;
}

function absoluteUrl(value, siteBase) {
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return value;
  }
  try {
    return new URL(value, siteBase).href;
  } catch {
    return value;
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&apos;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(html, fallback, maxLength = 280) {
  const text = htmlToText(html) || String(fallback || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function renderMarkdown(markdown, siteBase) {
  if (!markdown || !markdown.trim()) {
    return "";
  }
  const rawHtml = marked.parse(markdown, { gfm: true, breaks: false, async: false });
  return sanitizeHtml(rawHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      code: ["class"],
      pre: ["class"],
      span: ["class"],
      div: ["class"],
      input: ["type", "checked", "disabled"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs) => {
        const next = { ...attribs };
        if (next.href) {
          next.href = absoluteUrl(next.href, siteBase);
        }
        next.rel = "nofollow noopener noreferrer";
        next.target = "_blank";
        return { tagName, attribs: next };
      },
      img: (tagName, attribs) => {
        const next = { ...attribs };
        if (next.src) {
          next.src = absoluteUrl(next.src, siteBase);
        }
        return { tagName, attribs: next };
      },
    },
  });
}

function positiveInteger(raw, name, fallback, maximum = Number.POSITIVE_INFINITY) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      limit: { type: "string" },
      "self-test": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const selfTest = values["self-test"] === true;
  const siteUrl = process.env.SITE_URL?.trim();
  if (!selfTest && !siteUrl) {
    fail("SITE_URL is required");
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!selfTest && !databaseUrl) {
    fail("DATABASE_URL is required (or use --self-test)");
  }

  const feedLimit = positiveInteger(
    values.limit ?? process.env.FEED_LIMIT,
    "FEED_LIMIT",
    DEFAULT_FEED_LIMIT,
    MAX_FEED_LIMIT
  );
  const outputDir = path.resolve(values.out ?? process.env.SEO_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR);
  const bucketPath = process.env.BUCKET_PATH ? path.resolve(process.env.BUCKET_PATH) : null;
  const staticPaths = (process.env.SEO_STATIC_PATHS ?? DEFAULT_STATIC_PATHS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    selfTest,
    databaseUrl: databaseUrl || null,
    siteBase: normalizeSiteUrl(siteUrl || "https://example.com"),
    siteName: process.env.SITE_NAME?.trim() || DEFAULT_SITE_NAME,
    siteDescription: process.env.SITE_DESCRIPTION?.trim() || DEFAULT_SITE_DESCRIPTION,
    siteLanguage: process.env.SITE_LANGUAGE?.trim() || DEFAULT_SITE_LANGUAGE,
    outputDir,
    bucketPath,
    staticPaths,
    feedLimit,
  };
}

const SITEMAP_ARTICLES_SQL = `
SELECT id, access_policy, updated_at
FROM article
WHERE access_policy IN (0, 1)
  AND draft = false
  AND published = true
ORDER BY updated_at DESC, id DESC`;

const FEED_ARTICLES_SQL = `
SELECT a.id, a.title, a.created_at, a.updated_at, a.access_policy, a.content,
       u.nickname AS publisher_name
FROM article a
LEFT JOIN "user" u ON u.id = a.publisher_id
WHERE a.access_policy IN (0, 1)
  AND a.draft = false
  AND a.published = true
ORDER BY a.created_at DESC, a.id DESC
LIMIT $1`;

const SITEMAP_GAMES_SQL = `
SELECT g.id, g.updated_at, ga.updated_at AS intro_updated_at
FROM game g
LEFT JOIN article ga
  ON ga.id = g.introduction_id
 AND ga.access_policy = 2
 AND ga.draft = false
 AND ga.published = true
WHERE g.host_type = 1
  AND g.hidden = false
ORDER BY g.updated_at DESC, g.id DESC`;

const FEED_GAMES_SQL = `
SELECT g.id, g.name, g.brief, g.updated_at, g.start_at, g.end_at, g.archive_at,
       g.introduction_id, g.bucket,
       ga.title AS intro_title,
       ga.content AS intro_content,
       ga.created_at AS intro_created_at,
       u.nickname AS intro_publisher
FROM game g
LEFT JOIN article ga
  ON ga.id = g.introduction_id
 AND ga.access_policy = 2
 AND ga.draft = false
 AND ga.published = true
LEFT JOIN "user" u ON u.id = ga.publisher_id
WHERE g.host_type = 1
  AND g.hidden = false
ORDER BY COALESCE(ga.created_at, g.start_at, g.updated_at) DESC, g.id DESC
LIMIT $1`;

async function fetchData(options) {
  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: "ret2shell-seo",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query(`SET statement_timeout = '${DB_STATEMENT_TIMEOUT}'`);

    const sitemapArticles = await client.query(SITEMAP_ARTICLES_SQL);
    const feedArticles = await client.query(FEED_ARTICLES_SQL, [options.feedLimit]);
    const sitemapGames = await client.query(SITEMAP_GAMES_SQL);
    const feedGames = await client.query(FEED_GAMES_SQL, [options.feedLimit]);

    return {
      articles: sitemapArticles.rows,
      feedArticles: feedArticles.rows,
      games: sitemapGames.rows,
      feedGames: feedGames.rows,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

function articleSection(article) {
  const policy = Number(article.access_policy);
  if (policy === 0) {
    return "bulletin";
  }
  if (policy === 1) {
    return "wiki";
  }
  return null;
}

function buildSitemap(data, options) {
  const entries = new Map();

  const add = (loc, lastmod) => {
    const current = entries.get(loc);
    const next = formatW3c(lastmod);
    if (!current || (next && (!current.lastmod || next > current.lastmod))) {
      entries.set(loc, { loc, lastmod: next || current?.lastmod || null });
    }
  };

  for (const staticPath of options.staticPaths) {
    add(buildUrl(options.siteBase, staticPath), null);
  }
  for (const article of data.articles) {
    const section = articleSection(article);
    if (section) {
      add(buildUrl(options.siteBase, `/${section}/${article.id}`), article.updated_at);
    }
  }
  for (const game of data.games) {
    add(
      buildUrl(options.siteBase, `/games/${game.id}`),
      latestDate(game.updated_at, game.intro_updated_at)
    );
  }

  const urls = [...entries.values()]
    .sort((left, right) => left.loc.localeCompare(right.loc))
    .map(({ loc, lastmod }) => {
      const lastmodXml = lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmodXml}\n  </url>`;
    })
    .join("\n");

  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    count: entries.size,
  };
}

function readGameReadme(game, bucketPath) {
  if (!bucketPath || !game.bucket) {
    return null;
  }
  const root = path.resolve(bucketPath);
  const candidate = path.resolve(root, String(game.bucket), "README.md");
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  try {
    const content = fs.readFileSync(candidate, "utf8");
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

function buildGameHtml(game, options) {
  const parts = [];
  if (game.brief) {
    parts.push(`<p>${escapeXml(game.brief)}</p>`);
  }
  const start = formatDisplayDate(game.start_at);
  const end = formatDisplayDate(game.end_at);
  if (start || end) {
    parts.push(`<p>${escapeXml(`${start || "?"} - ${end || "?"}`)}</p>`);
  }
  const readme = readGameReadme(game, options.bucketPath);
  if (readme) {
    parts.push(renderMarkdown(readme, options.siteBase));
  } else if (game.intro_content && game.intro_content.trim()) {
    parts.push(renderMarkdown(game.intro_content, options.siteBase));
  }
  if (parts.length === 0) {
    parts.push(`<p>${escapeXml(game.name)}</p>`);
  }
  return parts.join("\n");
}

function buildFeed(data, options) {
  const entries = [];

  for (const article of data.feedArticles) {
    const section = articleSection(article);
    if (!section) {
      continue;
    }
    const url = buildUrl(options.siteBase, `/${section}/${article.id}`);
    const html = renderMarkdown(article.content || "", options.siteBase);
    entries.push({
      title: article.title,
      link: url,
      guid: url,
      date: article.created_at,
      category: section === "wiki" ? "Wiki" : "Bulletin",
      author: article.publisher_name || null,
      html: html || `<p>${escapeXml(article.title)}</p>`,
      summary: summarize(html, article.title),
    });
  }

  for (const game of data.feedGames) {
    const url = buildUrl(options.siteBase, `/games/${game.id}`);
    const html = buildGameHtml(game, options);
    entries.push({
      title: game.name,
      link: url,
      guid: url,
      date: game.intro_created_at || game.start_at || game.updated_at,
      category: "Game",
      author: game.intro_publisher || null,
      html,
      summary: summarize(html, game.brief || game.name),
    });
  }

  entries.sort((left, right) => {
    const leftTime = toDate(left.date)?.getTime() ?? 0;
    const rightTime = toDate(right.date)?.getTime() ?? 0;
    return rightTime - leftTime;
  });
  const items = entries.slice(0, options.feedLimit);

  const itemXml = items
    .map((item) => {
      const pubDate = formatRfc822(item.date);
      const published = pubDate ? `\n      <pubDate>${escapeXml(pubDate)}</pubDate>` : "";
      const author = item.author ? `\n      <dc:creator>${escapeXml(item.author)}</dc:creator>` : "";
      return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.guid)}</guid>${published}
      <category>${escapeXml(item.category)}</category>${author}
      <description>${cdata(item.summary)}</description>
      <content:encoded>${cdata(item.html)}</content:encoded>
    </item>`;
    })
    .join("\n");

  const selfUrl = buildUrl(options.siteBase, "rss.xml");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(options.siteName)}</title>
    <link>${escapeXml(options.siteBase)}</link>
    <description>${escapeXml(options.siteDescription)}</description>
    <language>${escapeXml(options.siteLanguage)}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>ret2shell-seo-generator</generator>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml" />
${itemXml}
  </channel>
</rss>
`;

  return { xml, count: items.length };
}

function writeAtomically(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function selfTestData() {
  return {
    articles: [
      {
        id: "1",
        access_policy: 1,
        updated_at: "2026-11-24T11:00:00+00:00",
      },
      {
        id: "2",
        access_policy: 0,
        updated_at: "2026-11-23T11:00:00+00:00",
      },
    ],
    feedArticles: [
      {
        id: "1",
        title: "Wiki <One>",
        created_at: "2026-11-24T10:00:00+00:00",
        updated_at: "2026-11-24T11:00:00+00:00",
        access_policy: 1,
        content: "# Hello\n\nBody & <script>alert(1)</script>\n\n| a | b |\n| - | - |\n| 1 | 2 |",
        publisher_name: "tester",
      },
    ],
    games: [
      {
        id: "3",
        updated_at: "2026-11-22T10:00:00+00:00",
        intro_updated_at: "2026-11-22T11:00:00+00:00",
      },
    ],
    feedGames: [
      {
        id: "3",
        name: "Demo Game",
        brief: "A demo game & brief",
        updated_at: "2026-11-22T10:00:00+00:00",
        start_at: "2026-11-22T12:00:00+00:00",
        end_at: "2026-11-22T18:00:00+00:00",
        archive_at: "2026-11-23T00:00:00+00:00",
        intro_title: "Demo Game Intro",
        intro_content: "## Intro\n\nWelcome to the **demo**.\n\n<script>alert(2)</script>",
        intro_created_at: "2026-11-21T10:00:00+00:00",
        intro_updated_at: "2026-11-22T11:00:00+00:00",
        intro_publisher: "tester",
      },
    ],
  };
}

function runSelfTest(options) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-seo-"));
  const data = selfTestData();
  const sitemap = buildSitemap(data, options);
  const feed = buildFeed(data, options);

  writeAtomically(path.join(outputDir, "sitemap.xml"), sitemap.xml);
  writeAtomically(path.join(outputDir, "rss.xml"), feed.xml);

  const sitemapWritten = fs.readFileSync(path.join(outputDir, "sitemap.xml"), "utf8");
  const rssWritten = fs.readFileSync(path.join(outputDir, "rss.xml"), "utf8");
  const expected = [
    options.siteBase,
    buildUrl(options.siteBase, "/wiki/1"),
    buildUrl(options.siteBase, "/bulletin/2"),
    buildUrl(options.siteBase, "/games/3"),
  ];
  for (const url of expected) {
    if (!sitemapWritten.includes(url)) {
      fail(`self-test: sitemap is missing ${url}`);
    }
  }
  if (sitemapWritten.includes("1970-01-01")) {
    fail("self-test: a missing date was rendered as the Unix epoch");
  }
  if (rssWritten.includes("<script")) {
    fail("self-test: RSS contains an unsanitized script tag");
  }
  if (!rssWritten.includes("<h1>Hello</h1>") || !rssWritten.includes("<h2>Intro</h2>")) {
    fail("self-test: RSS is missing rendered Markdown");
  }
  const gameDate = formatRfc822("2026-11-21T10:00:00+00:00");
  if (!gameDate || !rssWritten.includes(`<pubDate>${escapeXml(gameDate)}</pubDate>`)) {
    fail("self-test: game pubDate does not use article.created_at");
  }

  if (process.env.SEO_SELF_TEST_KEEP === "1") {
    console.log(`self-test output: ${outputDir}`);
  } else {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  console.log(`self-test ok: ${sitemap.count} urls, ${feed.count} feed items`);
}

async function main() {
  loadDotEnv(path.resolve(import.meta.dirname, ".env"));
  const options = parseCli();
  if (options.selfTest) {
    runSelfTest(options);
    return;
  }

  const data = await fetchData(options);
  const sitemap = buildSitemap(data, options);
  const feed = buildFeed(data, options);

  fs.mkdirSync(options.outputDir, { recursive: true });
  writeAtomically(path.join(options.outputDir, "sitemap.xml"), sitemap.xml);
  writeAtomically(path.join(options.outputDir, "rss.xml"), feed.xml);

  console.log(`wrote ${path.join(options.outputDir, "sitemap.xml")} (${sitemap.count} urls)`);
  console.log(`wrote ${path.join(options.outputDir, "rss.xml")} (${feed.count} items)`);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
