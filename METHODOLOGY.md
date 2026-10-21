# Learning when slots fill

The question is how early a visitor should consider booking a particular trail and entry time. The study measures the publicly reported **Não residentes** quota percentage. It cannot observe individual reservations, seat counts, purchases or cancellations.

## Sampling

Collect every current SIMplifica service-259 resource, including route variants and Porto Santo resources, all returned slots, and all percentages. Discover the catalog anew each scan so newly introduced resources join automatically; report additions and removals. Compare the catalog with the official island-specific IFCN route list daily. Keep official status context separate: availability alone does not establish that a route is open.

The main window is the current Madeira calendar day plus the following 29 days, sampled hourly. An additional daily sample covers dates 45, 60 and 90 days ahead, providing coarse evidence before they enter the hourly window. Daily samples do not provide hourly event timing, and their coverage is not continuous between the sampled horizons. A source may not have released slots that far ahead; empty responses remain unknown.

Every observation records when the source response completed. A scan takes about 17–20 minutes at the default pacing, so its entries have different timestamps. Preserve exact local start/end timestamps and the upstream IANA timezone, including fractional seconds. Resolve timezone offsets using the rules in effect on the visit date. Ambiguous or nonexistent DST times remain archived but are excluded from lead-time calculations.

## Historical record

Full normalized scans are compressed losslessly and retained permanently. A daily append-only manifest contains scan identifiers, hashes, byte sizes and coverage counts. Archive writes are idempotent and refuse conflicting replacement. Reports are derived views that can be rebuilt from those archives.

Successful unchanged checks are retained: they establish how long a percentage remained visible. Small increases and decreases are retained as well as large ones. Errors, skipped checks, catalog failures and empty arrays are recorded explicitly. No interpolation inserts a fictional percentage into a missing observation. A soft scan-time limit and source-error circuit breaker preserve partial results instead of hammering the service.

## Events and uncertainty

- Observe downward crossings at 50%, 20% and 0%. The crossing lies between the last observation above the threshold and the next observation at or below it; both timestamp and lead-time bounds are retained.
- If the first observation is already at or below a threshold, it is **left-censored**. For example, a first observation at 0% three weeks ahead proves only that it was already full at that check. It does not establish that it filled three weeks ahead.
- Treat a 0% → positive transition as a reopening of quota. It can reflect cancellation, quota adjustment or another upstream change; the cause is unknown.
- Mark crossings over missing/empty checks or intervals exceeding two hours as gap-spanning. They remain useful bounds but cannot support precise timing.
- Retain observations after slot entry but exclude them from booking-pressure analysis. Expiry must not be interpreted as demand.
- A date first seen above a threshold with no initial crossing recorded is right-censored at its last pre-entry check. Do not force it into a sell-out-time distribution.
- Summaries of observed initial crossing bounds exclude dates already low at first sight and count each visit date once. Medians of those observed bounds are descriptive of that cohort, not an unbiased estimate across all visit dates. Report left/right censor counts alongside them. Maximum gap-free percentage-point decline rates describe observed changes, not ticket sales.

## Comparing lead times

For each route variant, exact entry interval and timezone, compare weekday and weekend visit dates separately. Take the observation closest to 1, 3, 7, 14, 21 and 28 days before entry within 90 minutes; for daily 45-, 60- and 90-day samples use a 12.5-hour tolerance. One visit date contributes at most once to each time/day/lead group. Repeated hourly observations do not inflate the independent sample count.

Publish all and mature distinct-date sample counts separately. A date is mature once its slot entry has passed. For mature dates, report median, lower-quintile and minimum percentage, the share with any availability, the share above 20%, and sampling coverage. Coverage counts only sampling opportunities after the study began; future visit dates do not count as missed opportunities. Still report first-seen censoring alongside these summaries.

A cautious exploratory suggestion is allowed only when a group has at least **14 mature visit dates** sampled at a lead bucket, at least **85% sampling coverage**, and more than 20% quota on at least **90%** of those dates. Select the shortest supported sampled lead bucket. This is a descriptive planning aid, not a probability guarantee, causal model or claim that an exact number of days is sufficient. Sparse daily buckets require the same evidence gate and have coarser timing. Display “insufficient evidence” until the gate is met.

Weather, closures, holidays, day of week, season, quota changes and transport constraints can influence demand or usability. Daily official status snapshots provide context; they are not automatically treated as evidence of booking demand. Weather forecasts and trip-specific decisions belong in the private planning task. Avoid extrapolating autumn patterns confidently to another season. The early weeks are also a test period for schema, pacing, freshness and reporting.

## Failure monitoring

Expected cadence is hourly. Report gaps over 90 minutes between scan starts and expose per-pair source timestamps. Stop starting requests on HTTP 429, preserve Retry-After and do not start another scan during its cooldown. Up to two already-running lookups may finish after the first failure. Stop on schema drift or five consecutive source failures. Missing data stays unknown; a later successful check does not repair a lost historical interval.

There is no guarantee of uninterrupted collection. GitHub's schedule, runner availability and the upstream service are external dependencies. The reader must flag persistent stale data or coverage failures and flag recovery once, rather than reporting “no changes” when the data is unverified.
