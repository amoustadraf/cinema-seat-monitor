import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscordTicketPayload,
  buildDiscordTicketBatches,
  buildSeatPreviewUrl,
  discoverTargetShowtimes,
  extractPreferredAvailableSeats,
  findAdjacentGroups,
  getRescanIntervalMinutes
} from "../monitor.js";

const config = {
  movie: { filmId: 37617, requiredExperienceTypes: ["IMAX", "70mm"], posterUrl: "https://example.com/poster.jpg" },
  theatre: { id: 9406, name: "Cinéma Banque Scotia Montréal", timezone: "America/Toronto" },
  seats: { preferredRows: ["G", "H", "I", "J"], minimumNumber: 9, maximumNumber: 25, minimumAdjacent: 2, bestAdjacent: 3, allowedTypes: ["Standard"] },
  monitoring: { hotRescanMinutes: 10, warmRescanMinutes: 30, coldRescanMinutes: 360 }
};

test("discovers only the target theatre, movie, and IMAX 70mm sessions", () => {
  const payload = [{ theatreId: 9406, dates: [{ movies: [{ id: 37617, experiences: [
    { experienceTypes: ["IMAX", "70mm"], sessions: [{ vistaSessionId: 123, showStartDateTime: "2026-09-01T19:00:00", isShowtimeEnabledOnline: true }] },
    { experienceTypes: ["70mm"], sessions: [{ vistaSessionId: 456, showStartDateTime: "2026-09-01T20:00:00" }] }
  ] }] }] }];
  const result = discoverTargetShowtimes(payload, config);
  assert.deepEqual(result.map((item) => item.showtimeId), ["123"]);
  assert.match(result[0].seatMapUrl, /showtimeId=123/);
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

test("rescan cadence prioritizes showtimes with promising seats", () => {
  assert.equal(getRescanIntervalMinutes({ qualifyingGroups: [{ row: "G" }] }, config.monitoring), 10);
  assert.equal(getRescanIntervalMinutes({ availablePreferredSeats: ["G9"] }, config.monitoring), 30);
  assert.equal(getRescanIntervalMinutes({}, config.monitoring), 360);
});
