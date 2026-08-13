# Cinema Seat Monitor

A reusable GitHub Actions monitor for cinema showtimes and preferred-seat availability. The current configuration watches every upcoming **The Odyssey** IMAX 70mm showtime at **Cinéma Banque Scotia Montréal** because screenings are heavily sold out. It sends a Discord alert when it finds adjacent standard seats in the preferred middle section.

The project is intended to support additional films and cinemas through configuration in the future.

## Seat rules

- Cinema: Cinéma Banque Scotia Montréal (`9406`)
- Format: IMAX and 70mm together
- Preferred section: rows G–J, seats 9–25
- Minimum alert: 2 adjacent seats
- Best alert: 3 or more adjacent seats
- Wheelchair and companion positions are excluded
- Date and time do not matter

Every newly listed IMAX 70mm showtime is scanned immediately. Every existing showtime, including a fully occupied preferred section, is rescanned every 30 minutes so short-lived refunds and newly released seat blocks can be detected.

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

If a workflow run fails, Discord receives one red failure alert with the branch, commit, and a direct link to the failed GitHub Actions run. The next scheduled run retries automatically. A broken Discord webhook cannot report its own failure, so GitHub's Actions status remains the fallback.

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

Push-triggered and manually dispatched runs force-scan every currently listed IMAX 70mm date and time, which verifies deployments end to end. Scheduled runs always rediscover showtimes and scan every showtime that is due. Monitor state is kept in the GitHub Actions cache to prevent duplicate alerts.

The included workflow runs every 30 minutes. A public repository can use standard GitHub-hosted runners without consuming private-repository Actions minutes. If this repository is private, check the account's Actions allowance and reduce the cron frequency if needed.

## Safety and scope

The monitor performs read-only availability checks. It never selects or reserves seats, creates a cart, signs in, bypasses queues, or purchases tickets. A Discord alert opens Cineplex so the purchase remains fully manual.
