# Cineplex Seat Monitor

A configurable GitHub Actions monitor for Cineplex showtimes and preferred-seat availability. It discovers every matching date and time, checks the live seat map, and sends a Discord alert with exact adjacent seats and a direct Cineplex purchase link.

The repository ships ready to run with **The Odyssey** IMAX 70mm at **Cinéma Banque Scotia Montréal**. Edit `monitor.config.json` to use one different Cineplex movie, theatre, format, or seat zone.

## Included Odyssey watch

- Cinema: Cinéma Banque Scotia Montréal (`9406`)
- Format: IMAX and 70mm together
- Preferred section: rows G–J, seats 9–25
- Minimum alert: 2 adjacent seats
- Best alert: 3 or more adjacent seats
- Wheelchair and companion positions are excluded
- Date and time do not matter

Every newly listed matching showtime is scanned immediately. Every existing showtime, including a fully occupied preferred section, is rescanned every 30 minutes so short-lived refunds and newly released seat blocks can be detected.

Until the configured September 16 listing horizon has passed, an empty target-showtime response is treated as a monitor failure and reported to Discord. This prevents an API or filtering break from appearing as a quiet successful scan.

## Customize your Cineplex watch

This version supports one active Cineplex watch per deployment. Update these values in `monitor.config.json`:

| Setting | Purpose |
| --- | --- |
| `movie.name` | Movie name used in logs and Discord alerts |
| `movie.filmId` | Cineplex film ID used by the showtime API |
| `movie.pageUrl` | Public movie page kept as a reference |
| `movie.posterUrl` | Optional image displayed in Discord alerts |
| `movie.requiredExperienceTypes` | Every required format marker, such as `IMAX` and `70mm` |
| `theatre.id` | Cineplex theatre ID |
| `theatre.name` and `theatre.timezone` | Alert display name and local showtime timezone |
| `seats.preferredRows` | Acceptable auditorium rows |
| `seats.minimumNumber` / `maximumNumber` | Inclusive acceptable seat-number range |
| `seats.minimumAdjacent` | Smallest adjacent group that triggers an alert |
| `seats.bestAdjacent` | Group size that receives the green `BEST` treatment |
| `seats.allowedTypes` | Allowed Cineplex seat types, normally `Standard` |
| `monitoring.expectShowtimesUntil` | ISO date-time through which zero matching showtimes should be considered suspicious |

The `theatreId` appears in Cineplex seat-preview URLs. To find a `filmId` and the exact format names, open the target Cineplex movie or showtime, inspect the browser developer tools **Network** tab, and examine the `v1/showtimes` request and response.

After editing the configuration:

```powershell
npm test
npm run dry-run
```

Confirm that the dry run discovers only the intended Cineplex movie, theatre, and formats. It performs live read-only checks without saving state or sending Discord messages. A deliberate change to the movie, theatre, formats, or seat criteria receives a fresh state identity automatically; the included Odyssey deployment retains its existing legacy state during this upgrade.

## Secrets and Discord setup

The monitor needs a Discord webhook and the current Cineplex frontend API subscription key. Keep both values out of committed files.

1. In Discord, open the target channel's **Edit Channel → Integrations → Webhooks**.
2. Create a webhook and copy its URL.
3. In the browser's developer tools, inspect a normal Cineplex showtime or seat-preview request and copy its `Ocp-Apim-Subscription-Key` request-header value. Cineplex may rotate this public-frontend key over time.
4. Copy `.env.example` to `.env` for local use.
5. Put the values after `DISCORD_WEBHOOK_URL=` and `CINEPLEX_API_KEY=`.

`DISCORD_MENTION` is optional. Use `<@USER_ID>` for a user or `<@&ROLE_ID>` for a role.

For GitHub Actions:

1. Open the GitHub repository's **Settings → Secrets and variables → Actions**.
2. Create a repository secret named `DISCORD_WEBHOOK_URL`.
3. Create a repository secret named `CINEPLEX_API_KEY`.
4. Optionally create a repository variable named `DISCORD_MENTION`.

The alert includes the exact adjacent seats, date, time, cinema, format, and a clickable direct link to the correct Cineplex seat-selection page.

If a workflow run fails or times out, an independent GitHub job sends one red Discord alert with the branch, commit, and a direct link to the failed run. The next scheduled run retries automatically. A broken Discord webhook cannot report its own failure, so GitHub's Actions status remains the fallback.

## Run locally

Node.js 20 or newer is required. GitHub Actions currently runs the monitor on Node.js 24.

```powershell
npm test
npm run dry-run
npm run check:now
npm run notify-test
```

`dry-run` performs a full live scan without writing state or sending Discord messages. `notify-test` sends one harmless connection-test message to Discord.

## GitHub Actions

The workflow runs every 30 minutes on GitHub's servers, so the computer that created this repository can be off. GitHub's scheduler may occasionally start a run late.

Every push-triggered, manually dispatched, and scheduled run force-scans every date and time matching the configuration. This avoids scheduler-delay edge cases and verifies deployments end to end. Monitor state is kept in the GitHub Actions cache to prevent duplicate alerts.

The included workflow runs every 30 minutes. A public repository can use standard GitHub-hosted runners without consuming private-repository Actions minutes. If this repository is private, check the account's Actions allowance and reduce the cron frequency if needed.

## Safety and scope

The monitor performs read-only availability checks. It never selects or reserves seats, creates a cart, signs in, bypasses queues, or purchases tickets. A Discord alert opens Cineplex so the purchase remains fully manual.
