import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, "monitor.config.json");
const API_LANGUAGE = "en";
const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const dryRun = args.has("--dry-run");
const notifyTest = args.has("--notify-test");
const notifyFailure = args.has("--notify-failure");

const emptyState = {
  version: 1,
  lastCheckedAt: null,
  lastDiscoveryAt: null,
  sessions: {}
};

async function loadDotEnv() {
  try {
    const contents = await fs.readFile(path.join(ROOT, ".env"), "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function appendLog(config, level, message, details = {}) {
  const filePath = resolveConfiguredPath(config.monitoring.logFile, "ODYSSEY_LOG_FILE");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify({ at: new Date().toISOString(), level, message, ...details })}\n`, "utf8");
}

function resolveConfiguredPath(configPath, environmentVariable) {
  return path.resolve(ROOT, process.env[environmentVariable] || configPath);
}

function validateConfig(config) {
  const required = [
    [config.movie?.filmId, "movie.filmId"],
    [config.theatre?.id, "theatre.id"],
    [config.seats?.preferredRows?.length, "seats.preferredRows"],
    [config.seats?.minimumAdjacent, "seats.minimumAdjacent"],
    [config.api?.subscriptionKey, "api.subscriptionKey"]
  ];
  for (const [value, label] of required) {
    if (!value) throw new Error(`Missing required configuration: ${label}`);
  }
  if (config.seats.bestAdjacent < config.seats.minimumAdjacent) {
    throw new Error("seats.bestAdjacent must be at least seats.minimumAdjacent.");
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRetries(config, label, operation) {
  const attempts = config.monitoring.retryAttempts ?? 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      console.warn(`${label} failed (${attempt}/${attempts}): ${error.message}`);
      await sleep((config.monitoring.retryDelaySeconds ?? 4) * 1000 * attempt);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError.message}`, { cause: lastError });
}

async function fetchJson(config, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (config.monitoring.timeoutSeconds ?? 25) * 1000);
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Language": API_LANGUAGE,
        "Ocp-Apim-Subscription-Key": process.env.CINEPLEX_API_KEY || config.api.subscriptionKey,
        "User-Agent": "odyssey-cinema-monitor/1.0 (personal availability monitor)"
      },
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 300)}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`Expected JSON from ${url}; received ${body.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function showtimesUrl(config) {
  const query = new URLSearchParams({
    language: API_LANGUAGE,
    locationId: String(config.theatre.id),
    filmId: String(config.movie.filmId)
  });
  return `${config.api.theatricalBaseUrl}/v1/showtimes?${query}`;
}

function seatLayoutUrl(config, showtimeId) {
  return `${config.api.ticketingBaseUrl}/v1/theatre/${config.theatre.id}/showtime/${showtimeId}/seat-layout`;
}

function seatAvailabilityUrl(config, showtimeId) {
  return `${config.api.ticketingBaseUrl}/v1/theatre/${config.theatre.id}/showtime/${showtimeId}/seat-availability?preview=true`;
}

export function buildSeatPreviewUrl(theatreId, showtimeId) {
  return `https://www.cineplex.com/ticketing/preview?theatreId=${encodeURIComponent(theatreId)}&showtimeId=${encodeURIComponent(showtimeId)}&dbox=false`;
}

export function discoverTargetShowtimes(payload, config) {
  const required = config.movie.requiredExperienceTypes.map((value) => value.toLowerCase());
  const found = new Map();
  for (const theatre of Array.isArray(payload) ? payload : []) {
    if (String(theatre.theatreId) !== String(config.theatre.id)) continue;
    for (const date of theatre.dates || []) {
      for (const movie of date.movies || []) {
        if (Number(movie.id) !== Number(config.movie.filmId)) continue;
        for (const experience of movie.experiences || []) {
          const types = (experience.experienceTypes || []).map((value) => value.toLowerCase());
          if (!required.every((value) => types.includes(value))) continue;
          for (const session of experience.sessions || []) {
            if (!session.vistaSessionId || session.isInThePast || session.isShowtimeEnabledOnline === false) continue;
            const showtimeId = String(session.vistaSessionId);
            found.set(showtimeId, {
              showtimeId,
              startAt: session.showStartDateTime,
              startAtUtc: session.showStartDateTimeUtc,
              auditorium: session.auditorium || "IMAX",
              seatsRemaining: session.seatsRemaining ?? null,
              isSoldOut: session.isSoldOut === true,
              seatMapUrl: buildSeatPreviewUrl(config.theatre.id, showtimeId),
              experienceTypes: experience.experienceTypes
            });
          }
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

function allSeatDefinitions(layout) {
  const areas = [layout.standardSeats, layout.dboxSeats, layout.balconySeats].filter(Boolean);
  return areas.flatMap((area) => (area.rows || []).flatMap((row) => row.seats || []));
}

export function extractPreferredAvailableSeats(layout, availability, seatConfig) {
  const rows = new Set(seatConfig.preferredRows.map((row) => row.toUpperCase()));
  const types = new Set(seatConfig.allowedTypes.map((type) => type.toLowerCase()));
  const statusById = availability.seatAvailabilities || {};
  return allSeatDefinitions(layout)
    .map((seat) => {
      const match = String(seat.label || "").match(/^([A-Za-z]+)(\d+)$/);
      return match ? { ...seat, row: match[1].toUpperCase(), number: Number(match[2]) } : null;
    })
    .filter((seat) => seat
      && rows.has(seat.row)
      && seat.number >= seatConfig.minimumNumber
      && seat.number <= seatConfig.maximumNumber
      && types.has(String(seat.type).toLowerCase())
      && String(statusById[seat.id]).toLowerCase() === "available")
    .sort((a, b) => a.row.localeCompare(b.row) || a.number - b.number);
}

export function findAdjacentGroups(seats, minimumAdjacent) {
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const groups = [];
  for (const [row, rowSeats] of rows) {
    rowSeats.sort((a, b) => a.number - b.number);
    let run = [];
    const flush = () => {
      if (run.length >= minimumAdjacent) {
        groups.push({
          row,
          count: run.length,
          from: run[0].number,
          to: run.at(-1).number,
          labels: run.map((seat) => seat.label)
        });
      }
      run = [];
    };
    for (const seat of rowSeats) {
      if (run.length && seat.number !== run.at(-1).number + 1) flush();
      run.push(seat);
    }
    flush();
  }
  return groups.sort((a, b) => b.count - a.count || a.row.localeCompare(b.row) || a.from - b.from);
}

function groupSignature(groups) {
  return groups.map((group) => `${group.row}:${group.from}-${group.to}`).sort().join("|");
}

function minutesSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

export function getRescanIntervalMinutes(sessionState, monitoring) {
  if ((sessionState.qualifyingGroups || []).length > 0) return monitoring.hotRescanMinutes;
  if ((sessionState.availablePreferredSeats || []).length > 0) return monitoring.warmRescanMinutes;
  return monitoring.coldRescanMinutes;
}

function isSeatCheckDue(sessionState, config) {
  if (force || !sessionState?.lastSeatCheckAt) return true;
  return minutesSince(sessionState.lastSeatCheckAt) >= getRescanIntervalMinutes(sessionState, config.monitoring);
}

function formatShowtime(session, config) {
  const value = session.startAtUtc || session.startAt;
  const date = new Date(value);
  return {
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: config.theatre.timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    }).format(date),
    time: new Intl.DateTimeFormat("en-CA", {
      timeZone: config.theatre.timezone,
      hour: "numeric",
      minute: "2-digit"
    }).format(date)
  };
}

function summarizeGroups(groups, bestAdjacent) {
  return groups.slice(0, 8).map((group) => {
    const rating = group.count >= bestAdjacent ? "BEST" : "MATCH";
    return `**${rating} — Row ${group.row}: ${group.labels.join(", ")}** (${group.count} together)`;
  }).join("\n");
}

export function buildDiscordTicketPayload(config, session, groups, mention = "") {
  const when = formatShowtime(session, config);
  const best = Math.max(...groups.map((group) => group.count));
  const isBest = best >= config.seats.bestAdjacent;
  const title = isBest ? `🎟️ ${best} seats together found!` : `🎬 ${best} seats together found!`;
  const url = session.seatMapUrl || buildSeatPreviewUrl(config.theatre.id, session.showtimeId);
  return {
    content: [mention.trim(), `**Seats are available:** ${url}`].filter(Boolean).join("\n").slice(0, 2000),
    allowed_mentions: { parse: ["users", "roles"] },
    embeds: [{
      title,
      url,
      description: `${summarizeGroups(groups, config.seats.bestAdjacent)}\n\n[**Open the seat map and buy tickets →**](${url})`,
      color: isBest ? 0x2ECC71 : 0xF1C40F,
      fields: [
        { name: "📅 Date", value: when.date, inline: true },
        { name: "🕒 Time", value: when.time, inline: true },
        { name: "🎞️ Format", value: "IMAX 70mm", inline: true },
        { name: "📍 Cinema", value: config.theatre.name, inline: false },
        { name: "🎯 Preferred zone", value: `Rows ${config.seats.preferredRows.join("–")}, seats ${config.seats.minimumNumber}–${config.seats.maximumNumber}`, inline: false }
      ],
      thumbnail: config.movie.posterUrl ? { url: config.movie.posterUrl } : undefined,
      footer: { text: "Availability changes quickly. Open Cineplex to confirm the seats." },
      timestamp: new Date().toISOString()
    }]
  };
}

export function buildDiscordTicketBatches(config, alerts, mention = "") {
  const batches = [];
  for (let index = 0; index < alerts.length; index += 10) {
    const chunk = alerts.slice(index, index + 10);
    const embeds = chunk.map((alert) =>
      buildDiscordTicketPayload(config, alert.session, alert.groups).embeds[0]
    );
    batches.push({
      content: [
        index === 0 ? mention.trim() : "",
        `🎟️ **${alerts.length} Odyssey IMAX 70mm showtime${alerts.length === 1 ? " has" : "s have"} matching seats.** Open a showtime below to select seats and buy tickets.`
      ].filter(Boolean).join("\n").slice(0, 2000),
      allowed_mentions: { parse: ["users", "roles"] },
      embeds
    });
  }
  return batches;
}

export function buildDiscordFailurePayload(config, environment = process.env, mention = "") {
  const repository = environment.GITHUB_REPOSITORY || "amoustadraf/cinema-seat-monitor";
  const serverUrl = environment.GITHUB_SERVER_URL || "https://github.com";
  const runId = environment.GITHUB_RUN_ID || "";
  const runUrl = runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : `${serverUrl}/${repository}/actions`;
  const commit = (environment.GITHUB_SHA || "").slice(0, 7) || "Unknown";

  return {
    content: [mention.trim(), "🚨 **Odyssey monitor needs attention.**"].filter(Boolean).join("\n").slice(0, 2000),
    allowed_mentions: { parse: ["users", "roles"] },
    embeds: [{
      title: "Odyssey monitor failed",
      url: runUrl,
      description: `The scheduled cinema scan did not finish successfully.\n\n[**Open the failed GitHub Actions run →**](${runUrl})`,
      color: 0xE74C3C,
      fields: [
        { name: "Workflow", value: environment.GITHUB_WORKFLOW || "Odyssey IMAX 70mm Seat Monitor", inline: true },
        { name: "Branch", value: environment.GITHUB_REF_NAME || "Unknown", inline: true },
        { name: "Commit", value: commit, inline: true },
        { name: "Repository", value: repository, inline: false }
      ],
      footer: { text: "The next scheduled run will try again automatically." },
      timestamp: new Date().toISOString()
    }]
  };
}

function buildDiscordTestPayload(config) {
  const preview = buildSeatPreviewUrl(config.theatre.id, "SHOWTIME_ID");
  return {
    content: "✅ Odyssey monitor is connected to this Discord channel.",
    embeds: [{
      title: "Odyssey IMAX 70mm monitor test",
      description: "Discord notifications are configured correctly. Real alerts will include the date, time, exact adjacent seats, and a direct Cineplex seat-map link.",
      color: 0x3498DB,
      fields: [
        { name: "Cinema", value: config.theatre.name },
        { name: "Seat rule", value: `Minimum ${config.seats.minimumAdjacent} together; ${config.seats.bestAdjacent}+ is best` },
        { name: "Example link format", value: preview }
      ]
    }]
  };
}

function discordSettings(config) {
  const discord = config.notifications.discord;
  const enabledByEnvironment = process.env.DISCORD_ENABLED;
  const enabled = discord.enabled !== false && enabledByEnvironment !== "false";
  return {
    enabled,
    webhookUrl: process.env[discord.webhookUrlEnvVar || "DISCORD_WEBHOOK_URL"] || "",
    mention: process.env[discord.mentionEnvVar || "DISCORD_MENTION"] || ""
  };
}

async function sendDiscord(config, payload) {
  const settings = discordSettings(config);
  if (!settings.enabled) {
    console.log("Discord is disabled.");
    return false;
  }
  if (!settings.webhookUrl) throw new Error("DISCORD_WEBHOOK_URL is required when Discord is enabled.");
  const webhookEndpoint = new URL(settings.webhookUrl);
  webhookEndpoint.searchParams.set("wait", "true");
  const response = await fetch(webhookEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Discord webhook failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  return true;
}

async function fetchShowtimes(config) {
  return withRetries(config, "Showtime discovery", () => fetchJson(config, showtimesUrl(config)));
}

async function checkSeats(config, session, layoutCache) {
  const layoutKey = session.auditorium || session.showtimeId;
  if (!layoutCache.has(layoutKey)) {
    layoutCache.set(layoutKey, withRetries(config, `Seat layout ${session.showtimeId}`, () =>
      fetchJson(config, seatLayoutUrl(config, session.showtimeId))
    ));
  }
  const [layout, availability] = await Promise.all([
    layoutCache.get(layoutKey),
    withRetries(config, `Seat availability ${session.showtimeId}`, () => fetchJson(config, seatAvailabilityUrl(config, session.showtimeId)))
  ]);
  const preferredSeats = extractPreferredAvailableSeats(layout, availability, config.seats);
  return {
    preferredSeats,
    groups: findAdjacentGroups(preferredSeats, config.seats.minimumAdjacent),
    isSoldOut: availability.isSoldOut === true,
    isPostShowtime: availability.isPostShowtime === true
  };
}

function pruneState(state, config) {
  const cutoff = Date.now() - (config.monitoring.retainPastSessionsDays ?? 7) * 86400000;
  for (const [id, session] of Object.entries(state.sessions)) {
    const starts = new Date(session.startAtUtc || session.startAt).getTime();
    if (Number.isFinite(starts) && starts < cutoff) delete state.sessions[id];
  }
}

async function main() {
  await loadDotEnv();
  const config = await readJson(CONFIG_FILE, null);
  validateConfig(config);

  if (notifyTest) {
    await sendDiscord(config, buildDiscordTestPayload(config));
    console.log("Discord test notification sent.");
    return;
  }

  if (notifyFailure) {
    const settings = discordSettings(config);
    await sendDiscord(config, buildDiscordFailurePayload(config, process.env, settings.mention));
    console.log("Discord failure notification sent.");
    return;
  }

  const stateFile = resolveConfiguredPath(config.monitoring.stateFile, "ODYSSEY_STATE_FILE");
  const state = { ...structuredClone(emptyState), ...(await readJson(stateFile, emptyState)) };
  state.sessions ||= {};
  const checkedAt = new Date().toISOString();
  const discovered = discoverTargetShowtimes(await fetchShowtimes(config), config);
  const discoveredIds = new Set(discovered.map((session) => session.showtimeId));
  const newShowtimes = [];
  const alerts = [];
  const layoutCache = new Map();

  console.log(`Discovered ${discovered.length} upcoming IMAX 70mm showtime(s).`);

  for (const session of discovered) {
    const previous = state.sessions[session.showtimeId];
    if (!previous) newShowtimes.push(session);
    const next = {
      ...previous,
      ...session,
      firstSeenAt: previous?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt,
      unavailableFromDiscovery: false
    };

    if (!isSeatCheckDue(previous, config)) {
      state.sessions[session.showtimeId] = next;
      continue;
    }

    const result = await checkSeats(config, session, layoutCache);
    const signature = groupSignature(result.groups);
    const previousSignature = previous?.qualifyingSignature || "";
    Object.assign(next, {
      lastSeatCheckAt: checkedAt,
      lastSeatCheckStatus: result.isPostShowtime ? "past" : result.isSoldOut ? "sold_out" : "ok",
      availablePreferredSeats: result.preferredSeats.map((seat) => seat.label),
      qualifyingGroups: result.groups,
      qualifyingSignature: signature
    });

    console.log(`${session.startAt}: ${result.preferredSeats.length} preferred seat(s); ${result.groups.length} qualifying group(s).`);
    if (signature && signature !== previousSignature) {
      alerts.push({ session: next, groups: result.groups });
      next.lastAlertAt = checkedAt;
      next.lastAlertSignature = signature;
    }
    state.sessions[session.showtimeId] = next;
  }

  for (const [id, session] of Object.entries(state.sessions)) {
    if (!discoveredIds.has(id)) session.unavailableFromDiscovery = true;
  }

  state.lastCheckedAt = checkedAt;
  state.lastDiscoveryAt = checkedAt;
  state.lastResult = {
    discoveredShowtimes: discovered.length,
    newShowtimes: newShowtimes.length,
    seatChecks: discovered.filter((session) => state.sessions[session.showtimeId]?.lastSeatCheckAt === checkedAt).length,
    alerts: alerts.length
  };
  pruneState(state, config);

  if (newShowtimes.length > 0) {
    console.log(`Found ${newShowtimes.length} newly listed showtime(s). Every new showtime received an immediate seat scan.`);
  }

  if (dryRun) {
    console.log(`Dry run: ${alerts.length} Discord seat alert(s) would be sent; state was not written.`);
    for (const alert of alerts) {
      console.log(JSON.stringify(buildDiscordTicketPayload(config, alert.session, alert.groups), null, 2));
    }
    return;
  }

  const settings = discordSettings(config);
  const discordBatches = buildDiscordTicketBatches(config, alerts, settings.mention);
  for (let index = 0; index < discordBatches.length; index += 1) {
    await withRetries(config, `Discord alert batch ${index + 1}/${discordBatches.length}`, () =>
      sendDiscord(config, discordBatches[index])
    );
  }

  await writeJson(stateFile, state);
  await appendLog(config, "info", "Monitor completed", state.lastResult);
  console.log(`Completed. ${alerts.length} Discord alert(s) sent.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
