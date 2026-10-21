# Read-only public study

- Only read public SIMplifica data. The only upstream POST allowed is `/api/resources/intervals`, a read-only availability query. Never book, pay, log in or change an account.
- Anonymous cookies and XSRF tokens stay in memory. Never log or persist request headers, cookies, credentials or raw service-page HTML.
- Public files contain generic code and public trail availability only. No names, email addresses, itineraries, user instructions, local paths or account identifiers. The GitHub repository owner is necessarily public.
- Collect all current Madeira-island booking-catalog resources, all returned slots and every non-resident percentage, including 0 and 100. Exclude Porto Santo before creating availability jobs, including on catalog fallback. Preserve route variants and exact source local timestamps with their IANA timezone. Keep older archives intact; derived analysis and official-status context cover Madeira only.
- Empty arrays, missing slots, schema errors, stale data and network failures are unknown, never inferred zero. Percentage is not a ticket count or proof of a booking.
- Keep immutable compressed scans and their SHA-256 manifests. Never prune historical observations to reduce size. Stop with an explicit storage warning before the configured size guard instead.
- Respect source rate limits; stop on 429 and persist the cooldown. Do not add retry loops or increase request speed to fill gaps.
- Use standard public Ubuntu GitHub runners, no Actions artifacts/caches, no LFS, no paid services. Only the built-in short-lived GITHUB_TOKEN may write generated data.
- Keep the reporting reader aware of freshness and collection gaps. Hourly scheduling is best effort.
- Register or recover cron schedules with an active maintainer's public GitHub identity and GitHub noreply email. Use bot authorship for generated observation commits. Verify a run whose event is `schedule`; successful manual runs do not establish automatic operation.
- Analysis must distinguish first-seen low availability from observed threshold crossings, mark gap-spanning intervals, exclude observations after slot entry, and count distinct visit dates rather than repeated hourly checks as independent samples.
- Run `npm test` and `npm run verify` after changes. Validate the live anonymous flow when changing upstream access. Keep README and analysis limitations accurate; commit and push completed authorized changes.
