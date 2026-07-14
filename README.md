# DZMGWSM

Scheduled sync of the DayZ Steam Workshop catalog for DZMG. A GitHub Actions workflow crawls
Steam's `IPublishedFileService/QueryFiles` on a schedule and publishes `workshop-catalog.json`
(gzipped) as a **Release asset**. DZMG downloads that asset instead of crawling Steam itself,
so users do not need their own Steam Web API key just to browse mods.

- **Full sync** (daily, ~04:07 UTC): rebuilds the whole catalog from scratch by paging every
  DayZ mod. Because it is a fresh crawl, mods removed from the Workshop drop out automatically.
- **Delta sync** (every 15 min): tops up only the mods added or changed since the last sync,
  reading the previous catalog back from the release asset.

The JSON is written in the exact shape DZMG's `WorkshopCatalog` model reads (System.Text.Json
PascalCase, with unmapped Steam fields inlined per mod).

## Why a Release asset instead of a committed file

The full catalog is ~175 MB uncompressed, over GitHub's 100 MB per-file push limit. It is
gzipped (~15 MB) and uploaded to a fixed release (tag `catalog`) with `--clobber`, which:

- sidesteps the 100 MB limit (release assets allow up to 2 GB),
- keeps the full catalog (nothing trimmed),
- and never bloats the repo, since the data is not committed.

**Download URL** (stable): `https://github.com/PrawnCocktail/DZMGWSM/releases/download/catalog/workshop-catalog.json.gz`

## Setup

1. Make this repo **public** (Actions minutes are then free and unlimited).
2. Add your Steam Web API key as a secret: **Settings > Secrets and variables > Actions >
   New repository secret**, named `STEAM_API_KEY`. Get a key at
   https://steamcommunity.com/dev/apikey if you do not have one.
3. Push these files.
4. Open the **Actions** tab, select **workshop-catalog-sync**, and click **Run workflow**
   (leave mode on `full`) to build the catalog the first time. The full crawl takes a few
   minutes; watch it publish the asset to the `catalog` release.
5. After that first run, the schedules take over automatically.

The Steam API key never appears in the repo or the published JSON. GitHub encrypts the secret
and masks it in logs, and pull requests from forks do not receive it. The release upload uses
the automatic `GITHUB_TOKEN`, so no extra secret is needed.

## Changing the schedule

Edit the `cron` lines in `.github/workflows/sync.yml` (both are **UTC**). Cron cannot run more
often than every 5 minutes, and GitHub's scheduler is best-effort (runs can be delayed several
minutes), which is fine for a catalog.

## Running locally

```
STEAM_API_KEY=xxxx node sync.mjs full     # writes workshop-catalog.json.gz
STEAM_API_KEY=xxxx node sync.mjs delta    # reads the published asset, then tops it up
```

Needs Node 18+ (uses the built-in `fetch` and `node:zlib`). No dependencies.
