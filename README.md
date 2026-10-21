# Madeira slot study

A read-only historical study of **non-resident** trail-slot availability in Madeira's public SIMplifica booking service.

[Latest report](reports/SUMMARY.md) · [Official-route coverage](reports/INVENTORY.md) · [Methodology](METHODOLOGY.md)

The collector starts immediately and refreshes hourly at minute 27 UTC. Each scan discovers the current service-259 resource catalog, selects Madeira-island resources (excluding Porto Santo), visits every selected resource and every date in a rolling 30-day Madeira calendar window, and stores every returned slot, including 0% and 100%. Route variants remain separate. Once per Madeira calendar day it also samples 45, 60 and 90 days ahead. Past observations remain available as the window moves forward.

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

There are no third-party runtime dependencies, paid runners, Actions caches, retained Actions artifacts, Git LFS, paid databases or Cloudflare calls. Reports and compressed observations are ordinary repository files. No paid product or billing setting is enabled. The built-in short-lived `GITHUB_TOKEN` only writes this repository's generated data.

Free compute does **not** guarantee an hourly observation: [GitHub schedules can be delayed or dropped](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), and SIMplifica can fail, change schema or rate-limit access. The collector records partial scans, stops on rate limits, carries the cooldown into subsequent runs, and exposes stale data and gaps. Reports older than 90 minutes require attention. The default source pacing is one lookup per second, with at most three in flight; a lookup establishes a fresh anonymous session and reads availability. Do not run extra collectors in parallel.

Archives are compressed per scan to limit repository growth. At 750 MiB of compressed scans the collector stops with an explicit warning, preserving history. This is a storage review guard, not a paid overage. GitHub also has [repository and file size limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github). Public schedules may be disabled after 60 days without repository activity. No historical gap can be reconstructed after the fact.

If manual collection works but no automatic run appears, verify that the workflow is active and the cron file is on the default branch. An active maintainer should commit a change to the cron expression using their public GitHub identity and GitHub noreply email, following [GitHub's scheduled-workflow recovery guidance](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflow-stopped-running). Verify an actual run with event `schedule` afterward. An enabled setting or successful manual run alone is insufficient. On 21 October the initial automatic trigger produced no runs despite successful manual collection; its hourly expression was re-registered at minute 27. The precise cause was not established by the API.

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
