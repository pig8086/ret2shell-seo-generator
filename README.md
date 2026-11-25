# ret2shell-seo-generator

Standalone sitemap / RSS generator for Ret2Shell. It reads the public content
directly from PostgreSQL, writes two static files, and exits:

- `output/sitemap.xml`
- `output/rss.xml`

It is intentionally outside the main repository, so the Ret2Shell source tree
does not need any changes.

## Data sources

- **Wiki / bulletin**: `article` rows where
  `access_policy IN (0, 1)`, `draft = false`, `published = true`.
- **Games**: `game` rows where `host_type = 1` and `hidden = false`.
  Full content resolution order:
  1. `<BUCKET_PATH>/<game.bucket>/README.md`, when `BUCKET_PATH` is set and the
     file exists (this is what the current frontend serves).
  2. The linked `article` row: `game.introduction_id = article.id`,
     `article.access_policy = 2`, `draft = false`, `published = true`.
  3. The game brief and times.

Upstream commit `af613bbe` replaced game introductions stored in `article`
with bucket documents (`README.md` / `TRAINING.md` / `RULES.md`). New games no
longer get an `introduction_id`, so `BUCKET_PATH` is required for complete
coverage; the article path is only a legacy fallback.


RSS items contain the rendered full Markdown content in
`<content:encoded>`. Markdown is rendered with `marked` and sanitized with
`sanitize-html`; relative links and images are resolved against `SITE_URL`.

Feed items are ordered by **`article.created_at`**, newest first. For a game,
this is the `created_at` of its linked introduction article, not
`game.updated_at` (the game row is updated by unrelated settings changes). If a
game has no public linked article, its `start_at` is used as a fallback.
This rule applies to RSS ordering only; sitemap `<lastmod>` still reflects
the page's update timestamps.

## Requirements

- Node.js 20+
- Network access to PostgreSQL
- Optional: read access to the game bucket directory for current README content
- A read-only PostgreSQL role is recommended

## Install

```bash
npm install
```

## Configure

Copy `.env.example` to `.env` (the program loads `.env` next to
`generate.mjs`), or export the variables directly:

```bash
export DATABASE_URL='postgresql://ret2shell:password@127.0.0.1:5432/ret2shell?sslmode=require'
export SITE_URL='https://ctf.example.com'
export SITE_NAME='Ret2Shell'
export SITE_DESCRIPTION='A feature-riches CTF challenge platform.'
export SITE_LANGUAGE='zh-CN'
export FEED_LIMIT='30'
export BUCKET_PATH='/var/lib/ret2shell/bucket' # optional
```

`SITE_URL` must be the canonical public origin, including the scheme. It is
used for absolute links in both the sitemap and RSS.

## Feed size

`FEED_LIMIT` (default `30`, maximum `200`) controls the number of RSS items.
This is a size/latency choice, not an SEO setting: RSS is a recent-items feed,
not an archive. The sitemap always contains every public article and game.

Items are sorted by `article.created_at` before the limit is applied, so a
smaller feed always contains the newest content. Raise `FEED_LIMIT` if you want
a longer feed, or use the sitemap for the complete URL list.

## Generate once

```bash
npm run generate
# or
node generate.mjs
```

Optional flags:

```bash
node generate.mjs --out /var/www/seo --limit 50
node generate.mjs --self-test   # no database needed
```

## Serve with nginx

Add exact-match locations before the SPA fallback:

```nginx
location = /sitemap.xml {
    alias /srv/ret2shell-seo-generator/output/sitemap.xml;
    default_type application/xml;
    charset utf-8;
    add_header Cache-Control "public, max-age=900";
}

location = /rss.xml {
    alias /srv/ret2shell-seo-generator/output/rss.xml;
    default_type application/rss+xml;
    charset utf-8;
    add_header Cache-Control "public, max-age=300";
}
```

If your nginx already has `gzip_static on`, this is enough. Otherwise add:

```nginx
gzip on;
gzip_types application/xml application/rss+xml;
gzip_min_length 1024;
```

The exact `location =` blocks are important: without them the existing SPA
fallback would serve `index.html` with HTML content for `/sitemap.xml`.

## Cron example

```cron
*/15 * * * * cd /srv/ret2shell-seo-generator && /usr/bin/node generate.mjs >> /var/log/ret2shell-seo.log 2>&1
```

The generator writes to a temporary file and renames it, so nginx never reads a
partially written XML file. On failure the old files remain in place.

## Read-only database session

The program runs `SET default_transaction_read_only = on` before querying. A
dedicated role is still recommended:

```sql
CREATE ROLE r2s_seo LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE ret2shell TO r2s_seo;
GRANT USAGE ON SCHEMA public TO r2s_seo;
GRANT SELECT ON article, game, "user" TO r2s_seo;
```

If the database uses a separate schema or table prefix, adjust the SQL in
`generate.mjs`.

## Notes

- The current frontend is a SPA, so sitemap/RSS improve discovery and
  syndication but do not replace server-side rendering for search ranking.
- The sitemap excludes `/training/*` (login required), `/account/*`,
  `/admin/*`, `/api/*`, user profiles and query-string duplicates.
- `SEO_STATIC_PATHS` controls the static entries; default:
  `/`, `/wiki`, `/bulletin`, `/games`.
- Keep `SITE_URL` in sync with the canonical URL used by the frontend.
