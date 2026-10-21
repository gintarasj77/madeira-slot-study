# Independent collection clock

This small Cloudflare Worker only decides whether to request a GitHub workflow run. The existing GitHub collector still does all SIMplifica reads, archiving and analysis. The clock has no public control endpoint, database, storage binding or paid add-on. Its checked-in configuration is a safe deployment template with no active timers or account-specific settings. Deployments keep their actual configuration outside the public repository.

## Behavior

A ten-minute clock checks for an active or recently started collection. With a 55-minute guard this normally starts collection about once per hour. Source recency comes from the exact start encoded in the v1 archive scan identifier; a skipped successful workflow does not reset source age. Recent failed attempts are paced separately. It checks the repository remains public, respects upstream cooldown and storage warnings, rejects unknown API schemas, and never retries an uncertain dispatch immediately. The collector's own recent-complete-scan guard protects against queued duplicates. Configure one primary clock; remove the native GitHub cron once the independent clock is verified.

## Deployment

Create a fine-grained GitHub token for just the public study repository, with Actions read/write, Contents read, and mandatory Metadata read. Store it only as the Worker's `GITHUB_ACTIONS_TOKEN` secret. Set `REPOSITORY` to the public repository path and leave `WORKFLOW` as `collect.yml`. Do not paste tokens into chat, source, reports or logs, and do not copy a broad existing GitHub CLI credential to Cloudflare. The token needs an expiry date and renewal before that date.

Create a private copy of `wrangler.jsonc` beside this template, set `vars.REPOSITORY` to the intended public repository, and keep `triggers.crons` empty initially. Using the official Wrangler CLI:

```sh
wrangler deploy --config clock/wrangler.live.json
wrangler secret put GITHUB_ACTIONS_TOKEN --config clock/wrangler.live.json
```

Enter the restricted token only at the secret prompt. Alternatively, add it in the Cloudflare dashboard with the **Secret** checkbox selected. Verify that Cloudflare displays **Value encrypted**. Never put it in the configuration file or command arguments. Set `triggers.crons` to `["*/10 * * * *"]` in the private configuration and deploy again. Keep `workers_dev`, `preview_urls` and observability disabled; no public URL is needed.

Verify a real Cloudflare scheduled invocation and the resulting GitHub run. Its GitHub event is `workflow_dispatch`; that alone does not prove it came from the timer, so correlate it with a Cloudflare scheduled event. A deliberate manual test is not automatic-operation evidence. Cloudflare says trigger changes can take up to 15 minutes to propagate. No paid plan, domain or billing change is required. A temporary Wrangler tail can show the clock's decision without persisting logs. The HTTP handler always returns 404 and cannot trigger collection.

## Cost

The clock makes 144 invocations per day, against the current Workers Free allowance of 100,000 daily requests and 10 milliseconds of CPU per invocation. The actual collection continues on a standard free public GitHub runner. Keep the account on Workers Free; do not enable paid plans or add-ons. Free limits may stop execution; no paid overage, usage or uptime guarantee is configured.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Cron propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [GitHub workflow dispatch permission](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

Run `npm test` with Node.js 22 or newer. No packages need installation. The project and configuration are generic; secrets and real account configuration must remain outside source control.
