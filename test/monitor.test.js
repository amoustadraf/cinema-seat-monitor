import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertExpectedShowtimes,
  buildDiscordFailurePayload,
  buildDiscordTestPayload,
  buildDiscordTicketPayload,
  buildDiscordTicketBatches,
  buildSeatPreviewUrl,
  buildWatchIdentity,
  discoverTargetShowtimes,
  extractPreferredAvailableSeats,
  findAdjacentGroups,
  formatExperienceLabel,
  getRescanIntervalMinutes,
  initializeStateForWatch,
  markAlertsDelivered,
  resolveConfiguredPath,
  resolveCineplexApiKey,
  shouldSendSeatAlert,
  validateConfig,
  validateDiscordWebhookUrl
} from "../monitor.js";

const config = {
  movie: { name: "The Odyssey", filmId: 37617, requiredExperienceTypes: ["IMAX", "70mm"], posterUrl: "https://example.com/poster.jpg" },
  theatre: { id: 9406, name: "Cinéma Banque Scotia Montréal", timezone: "America/Toronto" },
  seats: { preferredRows: ["G", "H", "I", "J"], minimumNumber: 9, maximumNumber: 25, minimumAdjacent: 2, bestAdjacent: 3, allowedTypes: ["Standard"] },
  monitoring: {
    hotRescanMinutes: 30,
    warmRescanMinutes: 30,
    coldRescanMinutes: 30,
    expectShowtimesUntil: "2026-09-17T03:59:59Z",
    stateFile: ".monitor-cache/monitor.state.json",
    logFile: ".monitor-cache/monitor.log"
  },
  notifications: { discord: { enabled: true } },
  api: { theatricalBaseUrl: "https://example.com/theatrical", ticketingBaseUrl: "https://example.com/ticketing" }
};

const shippedConfig = JSON.parse(readFileSync(new URL("../monitor.config.json", import.meta.url), "utf8"));

test("shipped configuration preserves the working Odyssey Montréal watch", () => {
  assert.equal(shippedConfig.movie.name, "The Odyssey: The IMAX Experience® in 70MM Film");
  assert.equal(shippedConfig.movie.filmId, 37617);
  assert.equal(shippedConfig.theatre.id, 9406);
  assert.equal(shippedConfig.theatre.name, "Cinéma Banque Scotia Montréal");
  assert.deepEqual(shippedConfig.movie.requiredExperienceTypes, ["IMAX", "70mm"]);
  assert.deepEqual(shippedConfig.seats.preferredRows, ["G", "H", "I", "J"]);
  assert.equal(shippedConfig.seats.minimumNumber, 9);
  assert.equal(shippedConfig.seats.maximumNumber, 25);
  assert.equal(shippedConfig.seats.minimumAdjacent, 2);
  assert.equal(shippedConfig.seats.bestAdjacent, 3);
  assert.equal(shippedConfig.monitoring.expectShowtimesUntil, "2026-09-17T03:59:59Z");
  assert.doesNotThrow(() => validateConfig(shippedConfig));
});

test("configuration validation rejects unsafe or inconsistent values", () => {
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, movie: { ...config.movie, name: "" } }), /movie.name/);
  assert.throws(() => validateConfig({ ...config, movie: { ...config.movie, name: "x".repeat(151) } }), /150 characters/);
  assert.throws(() => validateConfig({ ...config, seats: { ...config.seats, maximumNumber: 8 } }), /maximumNumber/);
  assert.throws(() => validateConfig({ ...config, seats: { ...config.seats, bestAdjacent: 1 } }), /bestAdjacent/);
  assert.throws(() => validateConfig({ ...config, theatre: { ...config.theatre, timezone: "Not\/A-Timezone" } }), /Invalid theatre.timezone/);
  assert.throws(() => validateConfig({ ...config, monitoring: { ...config.monitoring, timeoutSeconds: 0 } }), /timeout/);
  assert.throws(() => validateConfig({ ...config, seats: { ...config.seats, minimumAdjacent: 2.5 } }), /positive integer/);
  assert.throws(() => validateConfig({ ...config, api: { ...config.api, ticketingBaseUrl: "http:\/\/example.com" } }), /valid HTTPS URL/);
  assert.throws(() => validateConfig({ ...config, movie: { ...config.movie, posterUrl: "not-a-url" } }), /movie.posterUrl/);
  assert.throws(() => validateConfig({ ...config, monitoring: { ...config.monitoring, expectShowtimesUntil: "not-a-date" } }), /valid date-time/);
  assert.throws(() => validateConfig({ ...config, monitoring: { ...config.monitoring, retainPastSessionsDays: -1 } }), /non-negative integer/);
  assert.throws(() => validateConfig({ ...config, seats: { ...config.seats, minimumAdjacent: 18, bestAdjacent: 18 } }), /cannot exceed/);
  assert.throws(() => validateConfig({ ...config, seats: { ...config.seats, preferredRows: ["G", ""] } }), /non-empty strings/);
});

test("watch identity preserves legacy state and resets state after a deliberate watch change", () => {
  const fresh = initializeStateForWatch(null, config);
  assert.equal(fresh.adoptedLegacyState, false);
  assert.equal(fresh.reset, false);
  assert.deepEqual(fresh.state.sessions, {});

  const legacyState = { version: 1, lastCheckedAt: "2026-08-13T12:00:00Z", sessions: { abc: { lastAlertSignature: "G:9-11" } } };
  const adopted = initializeStateForWatch(legacyState, config);
  assert.equal(adopted.adoptedLegacyState, true);
  assert.equal(adopted.reset, false);
  assert.deepEqual(adopted.state.sessions, legacyState.sessions);
  assert.equal(adopted.state.watchIdentity, buildWatchIdentity(config));
  const resumed = initializeStateForWatch(adopted.state, config);
  assert.equal(resumed.reset, false);
  assert.equal(resumed.adoptedLegacyState, false);
  assert.deepEqual(resumed.state.sessions, legacyState.sessions);

  const reorderedConfig = {
    ...config,
    movie: { ...config.movie, requiredExperienceTypes: ["70mm", "IMAX"] },
    seats: { ...config.seats, preferredRows: ["J", "I", "H", "G"] }
  };
  assert.equal(buildWatchIdentity(reorderedConfig), buildWatchIdentity(config));

  const changedConfig = { ...config, movie: { ...config.movie, filmId: 99999, name: "Another Movie" } };
  const reset = initializeStateForWatch(adopted.state, changedConfig);
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.state.sessions, {});
  assert.notEqual(reset.state.watchIdentity, adopted.state.watchIdentity);
});

test("generic runtime paths prefer new names and accept legacy Odyssey overrides", () => {
  const generic = resolveConfiguredPath("fallback.json", "CINEMA_MONITOR_STATE_FILE", "ODYSSEY_STATE_FILE", {
    CINEMA_MONITOR_STATE_FILE: "generic.json",
    ODYSSEY_STATE_FILE: "legacy.json"
  });
  const legacy = resolveConfiguredPath("fallback.json", "CINEMA_MONITOR_STATE_FILE", "ODYSSEY_STATE_FILE", {
    ODYSSEY_STATE_FILE: "legacy.json"
  });
  assert.match(generic, /generic\.json$/);
  assert.match(legacy, /legacy\.json$/);
});

test("expected listing horizon turns a suspicious empty discovery into a failure", () => {
  assert.throws(
    () => assertExpectedShowtimes([], config.monitoring, Date.parse("2026-08-13T12:00:00Z")),
    /no target showtimes/
  );
  assert.doesNotThrow(() => assertExpectedShowtimes([{ showtimeId: "123" }], config.monitoring, Date.parse("2026-08-13T12:00:00Z")));
  assert.doesNotThrow(() => assertExpectedShowtimes([], config.monitoring, Date.parse("2026-09-17T04:00:00Z")));
});

test("Discord webhook validation accepts Discord and rejects unrelated destinations", () => {
  assert.equal(
    validateDiscordWebhookUrl("https://discord.com/api/webhooks/123456/token-value").hostname,
    "discord.com"
  );
  assert.throws(() => validateDiscordWebhookUrl("https://example.com/api/webhooks/123456/token-value"), /valid Discord HTTPS/);
  assert.throws(() => validateDiscordWebhookUrl("http://discord.com/api/webhooks/123456/token-value"), /valid Discord HTTPS/);
});

test("discovers only the target theatre, movie, and IMAX 70mm sessions", () => {
  const payload = [{ theatreId: 9406, dates: [{ movies: [{ id: 37617, experiences: [
    { experienceTypes: ["IMAX", "70mm"], sessions: [{ vistaSessionId: 123, showStartDateTime: "2026-09-01T19:00:00", isShowtimeEnabledOnline: true }] },
    { experienceTypes: ["70mm"], sessions: [{ vistaSessionId: 456, showStartDateTime: "2026-09-01T20:00:00" }] }
  ] }] }] }];
  const result = discoverTargetShowtimes(payload, config, Date.parse("2026-08-01T00:00:00Z"));
  assert.deepEqual(result.map((item) => item.showtimeId), ["123"]);
  assert.match(result[0].seatMapUrl, /showtimeId=123/);
});

test("a different Cineplex configuration drives discovery and Discord wording", () => {
  const alternate = {
    ...structuredClone(config),
    movie: { name: "Moonlight Redux", filmId: 555, requiredExperienceTypes: ["VIP"], posterUrl: "" },
    theatre: { id: 777, name: "Cineplex Example Theatre", timezone: "America/Vancouver" },
    seats: { ...config.seats, preferredRows: ["C", "D"], minimumNumber: 4, maximumNumber: 12 }
  };
  const showtimePayload = [{ theatreId: 777, dates: [{ movies: [{ id: 555, experiences: [{
    experienceTypes: ["VIP"],
    sessions: [{ vistaSessionId: 888, showStartDateTimeUtc: "2026-09-03T03:00:00Z", showStartDateTime: "2026-09-02T20:00:00" }]
  }] }] }] }];
  const sessions = discoverTargetShowtimes(showtimePayload, alternate, Date.parse("2026-08-01T00:00:00Z"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].showtimeId, "888");
  assert.match(sessions[0].seatMapUrl, /theatreId=777/);
  assert.equal(formatExperienceLabel(alternate), "VIP");

  const groups = [{ row: "D", count: 2, from: 6, to: 7, labels: ["D6", "D7"] }];
  const ticket = buildDiscordTicketPayload(alternate, sessions[0], groups);
  const batch = buildDiscordTicketBatches(alternate, [{ session: sessions[0], groups }])[0];
  const failure = buildDiscordFailurePayload(alternate, {});
  const connectionTest = buildDiscordTestPayload(alternate);
  const serialized = JSON.stringify({ ticket, batch, failure, connectionTest });
  assert.match(serialized, /Moonlight Redux/);
  assert.match(serialized, /Cineplex Example Theatre/);
  assert.match(serialized, /VIP/);
  assert.doesNotMatch(serialized, /Odyssey|IMAX 70mm/);
});

test("ignores malformed sessions without a start time", () => {
  const payload = [{ theatreId: 9406, dates: [{ movies: [{ id: 37617, experiences: [{
    experienceTypes: ["IMAX", "70mm"],
    sessions: [{ vistaSessionId: 123, isShowtimeEnabledOnline: true }]
  }] }] }] }];
  assert.deepEqual(discoverTargetShowtimes(payload, config, Date.parse("2026-08-01T00:00:00Z")), []);
});

test("ignores malformed sessions with an invalid start time", () => {
  const payload = [{ theatreId: 9406, dates: [{ movies: [{ id: 37617, experiences: [{
    experienceTypes: ["IMAX", "70mm"],
    sessions: [{ vistaSessionId: 123, showStartDateTime: "not-a-date", isShowtimeEnabledOnline: true }]
  }] }] }] }];
  assert.deepEqual(discoverTargetShowtimes(payload, config, Date.parse("2026-08-01T00:00:00Z")), []);
});

test("ignores sessions whose start time has already passed", () => {
  const payload = [{ theatreId: 9406, dates: [{ movies: [{ id: 37617, experiences: [{
    experienceTypes: ["IMAX", "70mm"],
    sessions: [{
      vistaSessionId: 123,
      showStartDateTime: "2026-08-12T22:15:00",
      showStartDateTimeUtc: "2026-08-13T02:15:00Z",
      isShowtimeEnabledOnline: true
    }]
  }] }] }] }];
  assert.deepEqual(discoverTargetShowtimes(payload, config, Date.parse("2026-08-13T03:00:00Z")), []);
});

test("Cineplex API key comes from the configured environment variable", () => {
  const apiConfig = { api: { subscriptionKeyEnvVar: "CINEPLEX_API_KEY" } };
  assert.equal(resolveCineplexApiKey(apiConfig, { CINEPLEX_API_KEY: "from-environment" }), "from-environment");
  assert.throws(() => resolveCineplexApiKey(apiConfig, {}), /CINEPLEX_API_KEY is required/);
  assert.throws(() => resolveCineplexApiKey({ api: { subscriptionKey: "legacy-inline-value" } }, {}), /CINEPLEX_API_KEY is required/);
});

test("filters preferred standard seats and finds adjacent runs", () => {
  const make = (label, type = "Standard") => ({ id: label, label, type });
  const layout = { standardSeats: { rows: [{ seats: [make("G8"), make("G9"), make("G10"), make("G11"), make("G13"), make("H20"), make("H21"), make("H22", "Wheelchair"), make("K15")] }] } };
  const availability = { seatAvailabilities: { G8: "Available", G9: "Available", G10: "Available", G11: "Available", G13: "Occupied", H20: "Available", H21: "Available", H22: "Available", K15: "Available" } };
  const seats = extractPreferredAvailableSeats(layout, availability, config.seats);
  assert.deepEqual(seats.map((seat) => seat.label), ["G9", "G10", "G11", "H20", "H21"]);
  assert.deepEqual(findAdjacentGroups(seats, 2), [
    { row: "G", count: 3, from: 9, to: 11, labels: ["G9", "G10", "G11"] },
    { row: "H", count: 2, from: 20, to: 21, labels: ["H20", "H21"] }
  ]);
});

test("Discord payload is friendly and links directly to the showtime seat map", () => {
  const session = { showtimeId: "123", startAtUtc: "2026-09-02T23:00:00Z", seatMapUrl: buildSeatPreviewUrl(9406, 123) };
  const groups = [{ row: "I", count: 3, from: 14, to: 16, labels: ["I14", "I15", "I16"] }];
  const payload = buildDiscordTicketPayload(config, session, groups, "<@123>");
  assert.match(payload.content, /<@123>/);
  assert.match(payload.content, /ticketing\/preview/);
  assert.equal(payload.embeds[0].url, session.seatMapUrl);
  assert.match(payload.embeds[0].description, /I14, I15, I16/);
  assert.match(payload.embeds[0].description, /buy tickets/);
});

test("Discord notifications batch large ticket drops into at most ten embeds", () => {
  const groups = [{ row: "I", count: 3, from: 14, to: 16, labels: ["I14", "I15", "I16"] }];
  const alerts = Array.from({ length: 12 }, (_, index) => ({
    session: {
      showtimeId: String(index),
      startAtUtc: `2026-09-${String(index + 1).padStart(2, "0")}T23:00:00Z`,
      seatMapUrl: buildSeatPreviewUrl(9406, index)
    },
    groups
  }));
  const batches = buildDiscordTicketBatches(config, alerts, "<@123>");
  assert.equal(batches.length, 2);
  assert.equal(batches[0].embeds.length, 10);
  assert.equal(batches[1].embeds.length, 2);
  assert.match(batches[0].content, /<@123>/);
  assert.doesNotMatch(batches[1].content, /<@123>/);
  assert.equal(batches[1].embeds[1].url, alerts[11].session.seatMapUrl);
});

test("Discord failure notification links directly to the failed Actions run", () => {
  const payload = buildDiscordFailurePayload(config, {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "amoustadraf/cinema-seat-monitor",
    GITHUB_RUN_ID: "123456",
    GITHUB_WORKFLOW: "Odyssey IMAX 70mm Seat Monitor",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: "abcdef1234567890"
  }, "<@123>");
  assert.match(payload.content, /<@123>/);
  assert.equal(payload.embeds[0].url, "https://github.com/amoustadraf/cinema-seat-monitor/actions/runs/123456");
  assert.match(payload.embeds[0].description, /failed GitHub Actions run/);
  assert.equal(payload.embeds[0].color, 0xE74C3C);
  assert.equal(payload.embeds[0].fields.find((field) => field.name === "Commit").value, "abcdef1");
});

test("seat alerts compare against successfully delivered notification state", () => {
  const groups = [{ row: "I", count: 3, from: 14, to: 16, labels: ["I14", "I15", "I16"] }];
  assert.equal(shouldSendSeatAlert("", groups), true);
  assert.equal(shouldSendSeatAlert("I:14-16", groups), false);
  assert.equal(shouldSendSeatAlert("I:14-15", groups), true);
  assert.equal(shouldSendSeatAlert("I:14-16", []), false);
  assert.equal(shouldSendSeatAlert("", groups), true);
});

test("successful Discord batches checkpoint only their delivered alert signatures", () => {
  const state = { sessions: {
    first: { qualifyingSignature: "G:9-11" },
    second: { qualifyingSignature: "H:14-15" }
  } };
  markAlertsDelivered(state, [{ session: { showtimeId: "first" } }], "2026-08-13T12:00:00Z");
  assert.equal(state.sessions.first.lastAlertSignature, "G:9-11");
  assert.equal(state.sessions.first.lastAlertAt, "2026-08-13T12:00:00Z");
  assert.equal(state.sessions.second.lastAlertSignature, undefined);
});

test("duplicate seat definitions do not create false adjacency", () => {
  const seats = [
    { row: "G", number: 9, label: "G9" },
    { row: "G", number: 9, label: "G9" },
    { row: "G", number: 10, label: "G10" }
  ];
  assert.deepEqual(findAdjacentGroups(seats, 2), [
    { row: "G", count: 2, from: 9, to: 10, labels: ["G9", "G10"] }
  ]);
});

test("rescan cadence checks every showtime every 30 minutes", () => {
  assert.equal(getRescanIntervalMinutes({ qualifyingGroups: [{ row: "G" }] }, config.monitoring), 30);
  assert.equal(getRescanIntervalMinutes({ availablePreferredSeats: ["G9"] }, config.monitoring), 30);
  assert.equal(getRescanIntervalMinutes({}, config.monitoring), 30);
});
