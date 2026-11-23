"use strict";

const STATION_URL = "https://www.tides.gc.ca/en/stations/08258";
const REFRESH_MS = 15 * 60 * 1000;

/*
 * Strip tags and decode the HTML entities commonly used in this page.
 * This avoids requiring a DOM parser, which is not available in the
 * Pebble plugin runtime.
 */
function cellText(html) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(text) {
  const match = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function localDateTime(date, time) {
  // Interpret the source table’s PT time as Pacific Standard/Daylight time.
  // The JavaScript Date constructor below is used only as a sortable
  // representation; we calculate the UTC offset for the date separately.
  const [hour, minute] = time.split(":").map(Number);
  const utcGuess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);

  // Find the Pacific offset at the event time using Intl, which handles
  // standard/daylight time transitions.
  const guessed = new Date(utcGuess);
  const pacificParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(guessed);

  const p = {};
  for (const part of pacificParts) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }

  const pacificAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offsetMs = pacificAsUtc - utcGuess;

  return new Date(utcGuess - offsetMs);
}

function parseTideTables(html) {
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];
  const events = [];

  for (const table of tables) {
    const headerMatches = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)];
    const headers = headerMatches.map((m) => cellText(m[1]).toLowerCase());

    const timeColumn = headers.findIndex((h) => h.includes("time") && h.includes("pt"));
    const heightColumn = headers.findIndex((h) => h.includes("height") && h.includes("m"));

    // Only use the high/low table, not the separate minute-by-minute
    // predictions table.
    if (timeColumn < 0 || heightColumn < 0) continue;

    const captionMatch = table.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
    const date = captionMatch ? parseDate(cellText(captionMatch[1])) : null;
    if (!date) continue;

    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];

    for (const rowMatch of rows) {
      const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((m) => cellText(m[1]));

      if (cells.length <= Math.max(timeColumn, heightColumn)) continue;

      const timeMatch = cells[timeColumn].match(/\b([01]\d|2[0-3]):([0-5]\d)\b/);
      const height = Number(cells[heightColumn]);

      if (!timeMatch || !Number.isFinite(height)) continue;

      const time = `${timeMatch[1]}:${timeMatch[2]}`;
      events.push({
        time: localDateTime(date, time),
        timeText: time,
        height
      });
    }
  }

  events.sort((a, b) => a.time - b.time);

  // Each row in the high/low table is an alternating turning point.
  // Its height compared with the previous and next event identifies
  // high versus low.
  for (let i = 0; i < events.length; i++) {
    const previous = events[i - 1];
    const next = events[i + 1];

    if (!previous || !next) {
      events[i].type = null;
      continue;
    }

    events[i].type =
      events[i].height > previous.height && events[i].height > next.height
        ? "High"
        : "Low";
  }

  return events;
}

async function getTides() {
  const response = await fetch(STATION_URL, {
    method: "GET",
    headers: {
      Accept: "text/html"
    }
  });

  if (!response.ok) {
    throw new Error(`CHS request failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const events = parseTideTables(html);

  if (events.length < 3) {
    throw new Error("Could not find enough Lagoon Cove tide-table rows.");
  }

  return events;
}

Pebble.registerSourceHandler(async (request, respond) => {
  if (request.category !== "tides" || request.item !== "next") {
    respond.error("PLUGIN_UNAVAILABLE");
    return;
  }

  try {
    const events = await getTides();
    const now = new Date();

    const nextIndex = events.findIndex((event) => event.time > now);
    if (nextIndex < 1) {
      throw new Error("No current and upcoming tide events found.");
    }

    const previous = events[nextIndex - 1];
    const next = events[nextIndex];

    // Between a low tide and a high tide, the water is rising.
    // Between a high tide and a low tide, it is falling.
    const rising = previous.type === "Low";

    respond.data({
      validUntilMs: Date.now() + REFRESH_MS,
      instances: [
        {
          instanceId: "08258",
          properties: {
            rising: {
              boolean: {
                value: rising
              }
            },
            next_tide_time: {
              shortText: {
                text: next.timeText
              },
              longText: {
                text: next.timeText
              }
            },
            next_tide_type: {
              shortText: {
                text: next.type || ""
              },
              longText: {
                text: next.type || ""
              }
            }
          }
        }
      ]
    });
  } catch (error) {
    console.log(`Lagoon Cove Tides: ${error.message}`);
    respond.error("PLUGIN_UNAVAILABLE");
  }
});
