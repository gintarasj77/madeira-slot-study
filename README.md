# Madeira slot study

A read-only historical study of **non-resident** trail-slot availability in Madeira's public SIMplifica booking service.

[Latest report](reports/SUMMARY.md) · [Official-route coverage](reports/INVENTORY.md) · [Methodology](METHODOLOGY.md)

The collector starts immediately and aims to refresh about once per hour. An [independent Cloudflare clock](clock/README.md) checks every ten minutes and starts a collection when the preceding source scan is at least 55 minutes old and no collector is active. Each scan discovers the current service-259 resource catalog, selects Madeira-island resources (excluding Porto Santo), visits every selected resource and every date in a rolling 30-day Madeira calendar window, and stores every returned slot, including 0% and 100%. Route variants remain separate. Once per Madeira calendar day it also samples 45, 60 and 90 days ahead. Past observations remain available as the window moves forward.

The collection is generic: it contains public trail names, dates, source timestamps and quota percentages. It contains no traveler profiles, private trip dates, bookings, account information or credentials. Repository ownership and public GitHub activity remain visible.

## Reading the results

- `reports/SUMMARY.md`: freshness, complete/partial coverage, observation totals and links to all Madeira-island booking resources.
- `reports/CHANGES.md` and `reports/changes/RESOURCE_ID.md`: latest sell-outs, reopenings, drops of at least 10 points, new/missing slots and data failures/recovery, with real comparison timestamps and uncertainty.
- `reports/trails/RESOURCE_ID.md`: every slot and percentage in the latest window, plus historical statistics by exact entry time and weekday/weekend.
- `reports/INVENTORY.md`: daily IFCN route-status context and official routes missing from the booking catalog. A missing resource is not a claim that a route is closed or exempt from booking.
- `latest/trails/RESOURCE_ID.json`: normalized data. `slotColumns` names the four values in each compact slot row: exact start local time, exact end local time, IANA timezone and non-resident percentage.
- For a smaller scheduled-reader response, read `latest/index/RESOURCE_ID.json`, then its `latest/slots/RESOURCE_ID/YYYY-MM-DD.json` path **at the same Git commit**. Match `profileHash` and use the index's `sourceFetchedAt`, status and freshness limit. Slot payloads change only when their contents change; their file modification time is not observation freshness. Failed checks have no fresh payload reference.
- `analysis/summary.json` and `analysis/trails/RESOURCE_ID.json`: historical changes, bounded threshold crossings, reopenings, sample counts, lead-time comparisons and collection gaps.
- `reports/leads/RESOURCE_ID.md` and `reports/events/RESOURCE_ID.md`: smaller reader-friendly historical summaries, including quota medians, distinct-date sample counts, interval bounds, censoring and observed decline rates.
- `data/scans/YYYY-MM/*.json.gz`: immutable, losslessly compressed complete scans. `data/manifests/*.ndjson` records their SHA-256 hashes and coverage counts. Historical observations are never pruned.

Times preserve the source's timezone, currently `Europe/Lisbon`. The window uses `Atlantic/Madeira`. The analysis resolves their daylight saving rules explicitly; it never appends a false `Z` to local timestamps. Empty arrays, missing slots and failed requests are unknown availability, not inferred zero. Percentages are not ticket counts. Official trail status must be considered separately.

The current scope is Madeira island only. The live catalog currently has 32 Madeira booking resources and two excluded Porto Santo resources. This saves 60 availability lookups per ordinary 30-day scan (about 6%); all Madeira slots and variants remain covered. Earlier immutable scans retain the original wider catalog, while current reports and historical analysis use Madeira resources only. Older unlinked Porto Santo files are dated historical outputs, not active monitoring.

## Cost and reliability

The scheduled collector uses a **standard public `ubuntu-latest` GitHub runner**. [GitHub documents that public standard-runner compute is free](https://docs.github.com/en/billing/concepts/product-billing/github-actions). This avoids the monthly private-repository minute allowance. The job refuses to run when the repository is private.

There are no third-party runtime dependencies, paid runners, Actions caches, retained Actions artifacts, Git LFS or paid databases. Reports and compressed observations are ordinary repository files. The small Cloudflare clock uses Workers Free, makes 144 timer checks per day, and only calls GitHub; it never queries SIMplifica. [Workers Free currently includes 100,000 requests per day](https://developers.cloudflare.com/workers/platform/pricing/). It has no public trigger URL, database, storage binding or paid add-on. No paid product or billing setting is enabled. The built-in short-lived `GITHUB_TOKEN` alone writes this repository's generated data; the clock has a separate repository-limited dispatch credential stored only as a Cloudflare Worker secret.

Free compute does **not** guarantee an hourly observation: the independent clock, GitHub API/runners or SIMplifica can fail, credentials can expire, and the source can change schema or rate-limit access. The collector records partial scans, stops on rate limits, carries the cooldown into subsequent runs, and exposes stale data and gaps. Reports older than 90 minutes require attention. The default source pacing is one lookup per second, with at most three in flight; a lookup establishes a fresh anonymous session and reads availability. Do not run extra collectors in parallel.

Archives are compressed per scan to limit repository growth. At 750 MiB of compressed scans the collector stops with an explicit warning, preserving history. This is a storage review guard, not a paid overage. GitHub also has [repository and file size limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github). Public schedules may be disabled after 60 days without repository activity. No historical gap can be reconstructed after the fact.

On 21 October, GitHub's native scheduler produced no collection or diagnostic-probe runs despite successful manual collection, an active workflow, and an active maintainer re-registering its expression. [GitHub documents delays and dropped scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), but the precise cause here was not established. The independent Cloudflare clock avoids relying on that scheduler. Verify automatic operation by correlating a real Cloudflare scheduled event with the resulting GitHub `workflow_dispatch` run. A manual run or an enabled timer setting alone is insufficient. Renew the scoped clock credential before its expiry; do not replace it with a broader credential.

Queued duplicate triggers do not query SIMplifica again when a complete, verified scan began less than 55 minutes ago. This check preserves the original source timestamps; it never labels a skipped run as a new observation. Partial or failed scans do not satisfy this guard, and upstream cooldowns still take priority.

Publication imports immutable observations into a clean checkout of current main, verifies the combined history and rebuilds reports with the current code. A concurrent code or report update therefore cannot create a report merge conflict. A rejected push retries publication up to three times without making additional source requests. On 21 October a manual refresh collected successfully but its earlier report-rebase publisher failed; that unpublished interval remains a historical gap.

## Running locally

Use Node.js 22 or newer. No package installation is needed.

```sh
npm test
npm run collect
node scripts/context.mjs
npm run analyse
npm run verify
```

For Windows environments that require the system certificate store, use Node's `--use-system-ca` option. Never disable certificate verification. `npm run test:live -- YYYY-MM-DD RESOURCE_ID` compares every normalized slot with the exact live response using an independent category parser. It saves only public normalized evidence, never session cookies or tokens.

Resource `301` is **PR1 | Vereda do Areeiro - Pico Ruivo (sentido único)**. Resource `225` is the shorter PR1 booking option to Miradouro da Pedra Rija. IDs come from the live catalog, not a guessed numeric range.

The only upstream POST is `/api/resources/intervals`, a read-only query. No booking, login, payment or account change is implemented.

## Validation

The anonymous live flow and all 19 returned resource-301 slots were independently compared on 21 October 2026; [public validation evidence](validation/live.json) records the source time and exact normalized slots. Unit and fault tests cover XSRF refresh, date validation, timezone transitions, schema changes, rate-limit stops, archive integrity, missing observations, censored events and sample counting. The first full public hosted run on 21 October succeeded with 1,122/1,122 responses and 19,437 slots, including the three long-range dates; [hosted evidence](validation/hosted.json) records exact source timestamps and integrity counts. The initial 27 checks and full report reconstruction also passed on the hosted runtime; scope-filter tests were added subsequently. The generated report remains the current coverage source.
