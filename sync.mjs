// DZMGWSM - DayZ Workshop catalog sync for GitHub Actions.
//
// Ported from DZMG's WorkshopCatalogService (C#). Crawls Steam's
// IPublishedFileService/QueryFiles and produces workshop-catalog.json in the exact shape
// DZMG reads back: System.Text.Json defaults (case-sensitive PascalCase, indented), with
// unmapped Steam fields inlined per mod like the C# [JsonExtensionData] Extra.
//
// The catalog is ~175 MB uncompressed, over GitHub's 100 MB per-file push limit, so it is
// NOT committed to the repo. Instead it is gzipped (~15 MB) and published as an asset on a
// fixed GitHub Release (tag "catalog"). That keeps full fidelity, dodges the size limit, and
// avoids bloating the repo with a fresh 175 MB file every run. The delta sync reads the
// previous catalog back from that same asset.
//
// Usage:
//   node sync.mjs full    rebuild the whole catalog (pages the entire DayZ workshop)
//   node sync.mjs delta   top up only mods added/changed since the last sync
//                         (falls back to a full sync if there is no catalog yet)
//   node sync.mjs test    like full but stops after TEST_PAGES pages (default 10), for
//                         checking changes end to end without hammering Steam. The workflow
//                         routes its output to a throwaway artifact, never the real release.
//
// Needs STEAM_API_KEY in the environment. No dependencies (Node 18+ global fetch).

import { writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";

const APP_ID = "221100";                    // DayZ (AppPaths.DayZAppId)
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 250;                  // gentle on Steam, matches C# PageDelay
const REQUEST_TIMEOUT_MS = 60000;

// How many pages the "test" mode crawls before stopping (override with TEST_PAGES env).
const TEST_PAGES = Number(process.env.TEST_PAGES) || 10;

// Where the gzipped catalog is written locally and published.
const OUTPUT_FILE = "workshop-catalog.json.gz";
const RELEASE_TAG = "catalog";
const ASSET_NAME = "workshop-catalog.json.gz";
const DEFAULT_REPO = "PrawnCocktail/DZMGWSM"; // used when GITHUB_REPOSITORY is unset (local runs)

// query_type values (Steam EPublishedFileQueryType)
const RANKED_BY_PUBLICATION_DATE = 1;       // full crawl: stable enumeration of every item
const RANKED_BY_LAST_UPDATED = 21;          // delta crawl: newest-updated first

// Steam fields WorkshopCatalogService maps to typed properties. Everything else Steam
// returns is kept verbatim and inlined per mod, mirroring the C# [JsonExtensionData] Extra
// so no metadata is lost and new Steam fields survive without a code change.
const MAPPED_FIELDS = new Set([
  "publishedfileid", "title", "creator", "preview_url", "time_updated", "time_created",
  "subscriptions", "lifetime_subscriptions", "favorited", "lifetime_favorited", "views",
  "file_size", "filename", "hcontent_file", "num_children", "flags", "visibility",
  "file_description", "short_description", "banned", "tags", "children", "vote_data",
]);

const API_KEY = process.env.STEAM_API_KEY;
const mode = (process.argv[2] || "delta").toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowUnix = () => Math.floor(Date.now() / 1000);
const log = (m) => console.log(m);

function buildUrl(cursor, queryType) {
  const p = new URLSearchParams({
    key: API_KEY,
    appid: APP_ID,
    creator_appid: APP_ID,
    query_type: String(queryType),
    numperpage: String(PAGE_SIZE),
    cursor,
    return_metadata: "true",
    return_tags: "true",
    return_vote_data: "true",
    return_children: "true",
    return_short_description: "true",
  });
  return `https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?${p}`;
}

// Read a numeric field Steam may send as a JSON number or a quoted string (file_size is a
// string, subscriptions a number), mirroring the C# GetLong helper.
function toLong(v) {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
const toStr = (v) => (typeof v === "string" ? v : null);

// Parse one QueryFiles item into a WorkshopMod-shaped object, or null to skip it
// (missing id/title, banned, or non-public), matching ParseItem.
function parseItem(item) {
  const id = toStr(item.publishedfileid);
  const title = toStr(item.title);
  if (!id || !title) return null;
  if (item.banned === true) return null;
  const visibility = toLong(item.visibility);
  if (visibility !== 0) return null;

  const mod = {
    Id: id,
    Title: title,
    TimeUpdated: toLong(item.time_updated),
    TimeCreated: toLong(item.time_created),
    PreviewUrl: toStr(item.preview_url),
    Subscriptions: toLong(item.subscriptions),
    LifetimeSubscriptions: toLong(item.lifetime_subscriptions),
    Favorited: toLong(item.favorited),
    LifetimeFavorited: toLong(item.lifetime_favorited),
    Views: toLong(item.views),
    FileSize: toLong(item.file_size),
    Creator: toStr(item.creator),
    Filename: toStr(item.filename),
    ContentHandle: toStr(item.hcontent_file),
    NumChildren: toLong(item.num_children),
    Flags: toLong(item.flags),
    Visibility: visibility,
    Description: toStr(item.file_description),
    ShortDescription: toStr(item.short_description),
    VotesUp: 0,
    VotesDown: 0,
    Score: 0,
    Tags: [],
    Children: [],
  };

  const vote = item.vote_data;
  if (vote && typeof vote === "object") {
    mod.VotesUp = toLong(vote.votes_up);
    mod.VotesDown = toLong(vote.votes_down);
    if (typeof vote.score === "number") mod.Score = vote.score;
  }

  if (Array.isArray(item.tags)) {
    for (const t of item.tags) {
      // QueryFiles returns tags as objects ({ "tag": "Vehicle" }); tolerate plain strings.
      const value = t && typeof t === "object" ? t.tag : typeof t === "string" ? t : null;
      if (value && value.trim()) mod.Tags.push(value);
    }
  }

  if (Array.isArray(item.children)) {
    for (const c of item.children) {
      const cid = c && typeof c === "object" ? toStr(c.publishedfileid) : null;
      if (cid && cid.trim()) mod.Children.push(cid);
    }
  }

  // Keep every other Steam field verbatim, inlined (the [JsonExtensionData] Extra).
  for (const [k, v] of Object.entries(item)) {
    if (!MAPPED_FIELDS.has(k)) mod[k] = v;
  }

  return mod;
}

async function fetchPage(cursor, queryType) {
  const url = buildUrl(cursor, queryType);
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < 4) {
        const backoff = 1000 * attempt;
        log(`  request failed (${e.message}); retry ${attempt} in ${backoff}ms`);
        await sleep(backoff);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function parsePage(json) {
  const response = json?.response ?? {};
  const nextCursor = typeof response.next_cursor === "string" ? response.next_cursor : null;
  const total = toLong(response.total);
  const details = Array.isArray(response.publishedfiledetails) ? response.publishedfiledetails : [];
  const mods = [];
  for (const item of details) {
    const mod = parseItem(item);
    if (mod) mods.push(mod);
  }
  return { mods, nextCursor, total };
}

// Page through QueryFiles from the start cursor, handing each page to
// onPage(mods, total, page) -> stop. Stops when the handler says so, a page is empty, or
// the cursor stops advancing (Steam echoes the same next_cursor once it runs out).
async function crawl(queryType, onPage, maxPages = 0) {
  let cursor = "*";
  let page = 0;
  for (;;) {
    const { mods, nextCursor, total } = parsePage(await fetchPage(cursor, queryType));
    page++;
    const stop = onPage(mods, total, page);
    // Also stop once a page cap is set and reached (test mode), so we do not crawl the lot.
    if (stop || mods.length === 0 || !nextCursor || nextCursor === cursor || (maxPages && page >= maxPages)) {
      break;
    }
    cursor = nextCursor;
    await sleep(PAGE_DELAY_MS);
  }
}

// Fetch and gunzip the previously published catalog from the Release asset. Returns null if
// there is no release/asset yet (first run) or it cannot be read, so the caller falls back
// to a full sync.
async function readPreviousCatalog() {
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const url = `https://github.com/${repo}/releases/download/${RELEASE_TAG}/${ASSET_NAME}`;
  try {
    const res = await fetch(url); // follows redirects to the asset storage
    if (!res.ok) {
      log(`No previous catalog asset (HTTP ${res.status}).`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return JSON.parse(gunzipSync(buf).toString("utf8"));
  } catch (e) {
    log(`Could not read previous catalog: ${e.message}`);
    return null;
  }
}

async function writeCatalog(catalog) {
  const gz = gzipSync(Buffer.from(JSON.stringify(catalog, null, 2), "utf8"));
  await writeFile(OUTPUT_FILE, gz);
  log(`Wrote ${OUTPUT_FILE} (${(gz.length / 1e6).toFixed(1)} MB gzipped, ${catalog.Mods.length} mods).`);
}

// Rebuild the catalog from scratch. maxPages > 0 caps the crawl (test mode).
async function runFull(maxPages = 0) {
  const startedUnix = nowUnix();
  log(maxPages
    ? `Test sync: crawling the first ${maxPages} pages (~${maxPages * PAGE_SIZE} mods) only...`
    : "Full sync: crawling the whole DayZ workshop (this can take a few minutes)...");

  const mods = [];
  const seen = new Set();
  await crawl(RANKED_BY_PUBLICATION_DATE, (batch, total, page) => {
    let added = 0;
    for (const mod of batch) {
      if (!seen.has(mod.Id)) {
        seen.add(mod.Id);
        mods.push(mod);
        added++;
      }
    }
    log(total > 0
      ? `  fetched ${mods.length} of ~${total} mods (page ${page})`
      : `  fetched ${mods.length} mods (page ${page})`);
    return added === 0; // a page that brings nothing new means we are done
  }, maxPages);

  await writeCatalog({ SyncedAtUnix: startedUnix, PartialSyncedAtUnix: 0, Mods: mods });
  log(`${maxPages ? "Test" : "Full"} sync finished: ${mods.length} mods.`);
}

async function runDelta() {
  const startedUnix = nowUnix();
  const existing = await readPreviousCatalog();
  const watermark = existing
    ? Math.max(existing.SyncedAtUnix || 0, existing.PartialSyncedAtUnix || 0)
    : 0;

  if (!existing || !Array.isArray(existing.Mods) || existing.Mods.length === 0 || watermark <= 0) {
    log("No catalog to update yet - running a full sync instead.");
    return runFull();
  }

  // Key by id so changed mods overwrite in place; keep original order, append new ones.
  const byId = new Map();
  const order = [];
  for (const mod of existing.Mods) {
    if (!byId.has(mod.Id)) {
      byId.set(mod.Id, mod);
      order.push(mod.Id);
    }
  }

  let added = 0;
  let updated = 0;
  log(`Delta sync: checking mods changed since ${new Date(watermark * 1000).toISOString()}...`);

  await crawl(RANKED_BY_LAST_UPDATED, (batch, _total, page) => {
    let changed = 0;
    for (const mod of batch) {
      // Newest-updated first: anything at/after the watermark is new or changed; once we
      // drop below it there is nothing left on this page (or later ones) to pick up.
      if (mod.TimeUpdated < watermark) continue;
      changed++;
      if (byId.has(mod.Id)) updated++;
      else {
        order.push(mod.Id);
        added++;
      }
      byId.set(mod.Id, mod);
    }
    log(`  delta page ${page}: ${added} new, ${updated} updated so far`);
    return changed === 0; // a whole page older than the watermark means we are done
  });

  // Only write (and therefore publish) when something actually changed, so a quiet 15-minute
  // tick does not republish an identical asset. The watermark then simply stays put until the
  // next real change, which keeps each scan tiny.
  if (added === 0 && updated === 0) {
    log("Delta sync finished: no changes (nothing to publish).");
    return;
  }

  await writeCatalog({
    SyncedAtUnix: existing.SyncedAtUnix || 0, // unchanged: the last full crawl still stands
    PartialSyncedAtUnix: startedUnix,
    Mods: order.map((id) => byId.get(id)),
  });
  log(`Delta sync finished: ${added} new, ${updated} updated (${order.length} total).`);
}

if (!API_KEY) {
  console.error("STEAM_API_KEY is not set. Add it as a repository secret.");
  process.exit(1);
}

let task;
if (mode === "full") task = runFull();
else if (mode === "test") task = runFull(TEST_PAGES);
else task = runDelta();

task.catch((e) => {
  console.error(e);
  process.exit(1);
});
