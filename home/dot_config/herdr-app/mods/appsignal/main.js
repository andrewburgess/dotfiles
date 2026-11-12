// Open and WIP AppSignal exception and anomaly incidents for one app, with incident details and a
// few confirmed write actions. Everything goes through `appsignal-cli`, which holds the login.

import { View, div, svg, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, theme, notify, shared, setShared, readTextFile, home } from "herdr";

const CLI = "appsignal-cli";
const DEFAULT_APP = { id: "6386678fd2a5e4772f8e68a1", name: "Hugolith", environment: "production" };
const DEFAULT_ORG = "popular-lab-co";
const APP_KEY = "appsignal.app";
const REFRESH_MS = 150 * 1000;
const CLOCK_MS = 60 * 1000;
const LIMIT = 50;
const SAMPLES = 5;
const AUTH_HINT = "AppSignal login expired or missing: run `appsignal-cli auth login` in a terminal, then Refresh.";
const AUTH_RE = /auth|log ?in|unauthori[sz]ed|unauthenticated|token|credential|\b401\b|\b403\b/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DASH_KEY = "appsignal.dashboards";
const GRAPHQL = "https://appsignal.com/graphql";
const TOKEN_FILE = "Library/Application Support/appsignal/config.toml";
const TIMEFRAMES = [["R1H", "1h"], ["R4H", "4h"], ["R8H", "8h"], ["R12H", "12h"], ["R24H", "24h"], ["R48H", "48h"], ["R7D", "7d"], ["R30D", "30d"]];
const DEFAULT_TIMEFRAME = "R24H";
const MAX_SERIES = 8;
const CHART_H = 120;
const PLOT_TOP = 6;
const PLOT_BOTTOM = 97;
const TIMESERIES_QUERY = `query($appId: String!, $tf: TimeframeEnum, $q: [MetricTimeseries]) {
  app(id: $appId) { metrics { timeseries(timeframe: $tf, query: $q) {
    start end resolution
    keys { digest name fields tags { key value } }
    points { timestamp values { key value } }
  } } }
}`;
const NOTIFICATION_QUERY = `query($appId: String!, $n: Int!) {
  app(id: $appId) { incident(incidentNumber: $n) {
    ... on ExceptionIncident { state severity notificationFrequency notificationThreshold }
  } }
}`;
const STATES = [["OPEN", "Open"], ["WIP", "WIP"], ["CLOSED", "Closed"]];
/** Incident states the lists show; anything else (CLOSED) drops out of them. */
const LIST_STATES = ["OPEN", "WIP"];
const FREQUENCIES = [
  ["ALWAYS", "every occurrence"],
  ["FIRST_IN_DEPLOY", "first in each deploy"],
  ["FIRST_AFTER_CLOSE", "first after close"],
  ["NTH_IN_HOUR", "every Nth in an hour"],
  ["NTH_IN_DAY", "every Nth in a day"],
  ["NEVER", "never"],
];
const NTH = new Set(["NTH_IN_HOUR", "NTH_IN_DAY"]);
const VIEWER_QUERY = "{ viewer { id name email } }";
const MINE_KEY = "appsignal.mine";
const PAGE = 200;
const MAX_PAGES = 25;
const MAX_THRESHOLD = 2 ** 31 - 1;

/**
 * Turns a failed CLI run into one readable line. The CLI writes `{ "error": ... }` to stdout
 * and status text (plus an update banner drawn with `|` and `+`) to stderr.
 * @param r Result of `exec`
 * @returns Error message, replaced by a login hint when it looks like an auth failure
 */
function cliError(r) {
  let msg = "";
  try {
    msg = JSON.parse(r.stdout)?.error ?? "";
  } catch {}
  if (!msg) msg = r.stderr.split("\n").filter((l) => l.trim() && !/^\s*[|+]/.test(l)).join(" ").trim();
  if (!msg) msg = `appsignal-cli exited ${r.code}`;
  return AUTH_RE.test(msg) ? AUTH_HINT : msg;
}

/**
 * Runs `appsignal-cli --output json <args>` and parses its stdout.
 * @param args Command and flags after the global output flag
 * @returns Parsed JSON
 */
async function cli(args) {
  let r;
  try {
    r = await exec(CLI, ["--output", "json", ...args]);
  } catch (e) {
    throw new Error(`Couldn't run ${CLI}: ${e?.message ?? e}`);
  }
  if (r.code !== 0) throw new Error(cliError(r));
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`Unexpected output from ${CLI} ${args.slice(0, 2).join(" ")}`);
  }
}

/**
 * @param e Anything thrown
 * @returns Its message as a string
 */
function message(e) {
  return String(e?.message ?? e);
}

/**
 * Formats an ISO timestamp as a compact age ("45m", "3h", "12d", "4mo").
 * @param iso ISO 8601 timestamp
 * @returns Compact age, or "" when missing
 */
function age(iso) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return "";
  const mins = Math.max(0, (Date.now() - t) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${Math.floor(mins)}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  if (mins < 43200) return `${Math.floor(mins / 1440)}d`;
  if (mins < 525600) return `${Math.floor(mins / 43200)}mo`;
  return `${Math.floor(mins / 525600)}y`;
}

/**
 * Formats an ISO timestamp as local date and time with its age.
 * @param iso ISO 8601 timestamp
 * @returns "Nov 5, 16:39 (3h ago)", or "—" when missing
 */
function stamp(iso) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const month = MONTHS[d.getMonth()];
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const a = age(iso);
  return `${month} ${d.getDate()}${year}, ${hm} (${a === "now" ? "just now" : `${a} ago`})`;
}

/**
 * @param ms Duration in milliseconds
 * @returns "850ms", "32.8s" or "2.1m"
 */
function duration(ms) {
  if (typeof ms !== "number") return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * @param n Occurrence count
 * @returns Count with thousands separators
 */
function count(n) {
  return typeof n === "number" ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "?";
}

/**
 * Escapes text for literal display in a TextView.html block.
 * @param s Raw text
 * @returns Text with HTML-significant characters replaced by entities
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * @param tags Anomaly tags as `[{ key, value }]`
 * @returns "key=value, key=value"
 */
function tagText(tags) {
  return (tags ?? []).map((g) => `${g.key}=${g.value}`).join(", ");
}

/**
 * @param people Incident assignees; their shape isn't documented, so any name-like field is used
 * @returns Display names
 */
function assigneeNames(people) {
  return (people ?? []).map((p) => (typeof p === "string" ? p : p?.name ?? p?.email ?? p?.username ?? p?.id ?? "?"));
}

/**
 * Collects the newest error samples across an exception incident's digests.
 * @param r Output of `samples incident`
 * @returns Up to SAMPLES traces, newest first
 */
function latestSamples(r) {
  return (r?.digests ?? []).flatMap((d) => d.traces ?? [])
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, SAMPLES);
}

/**
 * @param v A value read from shared state
 * @returns The value when it looks like a saved app, else null
 */
function savedApp(v) {
  return v && typeof v === "object" && typeof v.id === "string" && v.name ? v : null;
}

/**
 * Reads the OAuth access token `appsignal-cli` keeps in its config file.
 * @returns The token; never log or display it
 */
async function readToken() {
  const text = await readTextFile(`${home().replace(/\/$/, "")}/${TOKEN_FILE}`);
  const section = text?.split(/^\[oauth\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const token = section.match(/^access_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!token) throw new Error(AUTH_HINT);
  return token;
}

/**
 * Makes a cheap CLI call so the CLI refreshes an expiring token, then reads the token.
 * @param appId App the call is made against
 * @returns A current access token
 */
async function freshToken(appId) {
  await cli(["apps", "info", "--app-id", appId]);
  return readToken();
}

/**
 * @returns An error flagged as an auth failure, so the caller can refresh the token once
 */
function authError() {
  return Object.assign(new Error(AUTH_HINT), { auth: true });
}

/**
 * Runs one query against AppSignal's GraphQL API.
 * @param token OAuth access token
 * @param query GraphQL query text
 * @param variables Query variables
 * @returns The response's `data`; auth failures throw an error flagged `auth`
 */
async function graphql(token, query, variables) {
  let r;
  try {
    r = await fetch(GRAPHQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new Error(`Couldn't reach AppSignal: ${message(e)}`);
  }
  if (r.status === 401 || r.status === 403) throw authError();
  let body = null;
  try {
    body = JSON.parse(await r.text());
  } catch {}
  const errors = (body?.errors ?? []).map((e) => e?.message).filter(Boolean).join("; ");
  if (errors) throw AUTH_RE.test(errors) ? authError() : new Error(errors);
  if (!r.ok) throw new Error(`AppSignal returned ${r.status}`);
  return body?.data;
}

/**
 * Fetches one chart's data points from AppSignal's GraphQL API.
 * @param token OAuth access token
 * @param appId App id
 * @param timeframe A TimeframeEnum value such as "R24H"
 * @param metrics The visual's `metrics`, passed through unchanged
 * @returns `{ start, end, resolution, keys, points }`
 */
async function timeseries(token, appId, timeframe, metrics) {
  const ts = (await graphql(token, TIMESERIES_QUERY, { appId, tf: timeframe, q: metrics }))?.app?.metrics?.timeseries;
  if (!ts) throw new Error("AppSignal returned no data for this chart");
  return ts;
}

/**
 * Runs a GraphQL query with the saved token, refreshing it through the CLI only after an auth failure.
 * @param appId App used for the CLI refresh call
 * @param query GraphQL query text
 * @param variables Query variables
 * @returns The response's `data`
 */
async function authed(appId, query, variables) {
  try {
    return await graphql(await readToken(), query, variables);
  } catch (e) {
    if (!e?.auth && e?.message !== AUTH_HINT) throw e;
    return graphql(await freshToken(appId), query, variables);
  }
}

/**
 * @param appId App used for the CLI refresh call, should the token need one
 * @returns The signed-in AppSignal user, `{ id, name, email }`
 */
async function viewer(appId) {
  const v = (await authed(appId, VIEWER_QUERY, {}))?.viewer;
  if (!v?.id) throw new Error("AppSignal didn't say who you are");
  return v;
}

/**
 * Merges incident lists fetched per state into one list. An incident that changed state between
 * fetches can be in two lists; the copy updated last wins.
 * @param lists Incident arrays
 * @returns Incidents, one per number, newest activity first
 */
function mergeIncidents(lists) {
  const seen = new Map();
  for (const i of lists.flat()) {
    const prev = seen.get(i.number);
    if (!prev || (Date.parse(i.updatedAt) || 0) > (Date.parse(prev.updatedAt) || 0)) seen.set(i.number, i);
  }
  return [...seen.values()].sort((a, b) => (Date.parse(b.lastOccurredAt) || 0) - (Date.parse(a.lastOccurredAt) || 0));
}

/**
 * Fetches the most recently active open and WIP incidents of one kind. The CLI filters by one
 * state per call, so each state is fetched in parallel and the newest LIMIT of the union are kept.
 * @param command "list-exceptions" or "list-anomalies"
 * @param appId App id
 * @returns `{ incidents, complete, open }`: `complete` is false when either state may have more;
 *   `open` is the OPEN-state list alone, as the CLI returned it
 */
async function latestIncidents(command, appId) {
  const [open, wip] = await Promise.all(LIST_STATES.map((state) => cli(["incidents", command, "--app-id", appId,
    "--state", state, "--order", "LAST", "--limit", String(LIMIT)]).then((r) => r?.incidents ?? [])));
  const merged = mergeIncidents([open, wip]);
  return {
    incidents: merged.slice(0, LIMIT),
    complete: open.length < LIMIT && wip.length < LIMIT && merged.length <= LIMIT,
    open,
  };
}

/**
 * Pages through every exception incident in one state. Pages go in creation order so an incident
 * that recurs mid-fetch doesn't shift the pages and get skipped.
 * @param appId App id
 * @param state "OPEN" or "WIP"
 * @returns `{ incidents, complete }`; `complete` is false when MAX_PAGES ran out first
 */
async function allExceptionsIn(appId, state) {
  const incidents = [];
  let complete = false;
  for (let page = 0; page < MAX_PAGES && !complete; page++) {
    const r = await cli(["incidents", "list-exceptions", "--app-id", appId, "--state", state, "--order", "ID",
      "--limit", String(PAGE), "--offset", String(page * PAGE)]);
    const list = r?.incidents ?? [];
    incidents.push(...list);
    complete = list.length < PAGE;
  }
  return { incidents, complete };
}

/**
 * Pages through every open and WIP exception incident, both states in parallel.
 * @param appId App id
 * @returns `{ incidents, complete }`, incidents newest activity first; `complete` is false when
 *   either state ran out of pages first
 */
async function allExceptions(appId) {
  const results = await Promise.all(LIST_STATES.map((state) => allExceptionsIn(appId, state)));
  return { incidents: mergeIncidents(results.map((r) => r.incidents)), complete: results.every((r) => r.complete) };
}

/**
 * Whether an incident is assigned to the user. The CLI's assignees carry `id` and `name`; `email`
 * is matched too in case a version adds it, and a bare string is taken as either.
 * @param incident Exception incident
 * @param me The viewer, `{ id, email }`
 * @returns True when one of its assignees is the viewer
 */
function assignedTo(incident, me) {
  const email = me.email?.toLowerCase();
  return (incident.assignees ?? []).some((p) => typeof p === "string"
    ? p === me.id || (Boolean(email) && p.toLowerCase() === email)
    : p?.id === me.id || (Boolean(email) && p?.email?.toLowerCase() === email));
}

/**
 * Reads an exception incident's notification setting, which `incidents show` doesn't return.
 * Uses the saved token first and refreshes it through the CLI only after an auth failure.
 * @param appId App id
 * @param n Incident number
 * @returns `{ frequency, threshold }`; either may be null
 */
async function notificationSetting(appId, n) {
  const incident = (await authed(appId, NOTIFICATION_QUERY, { appId, n }))?.app?.incident;
  if (!incident?.notificationFrequency) throw new Error("AppSignal didn't return a notification setting");
  return { frequency: incident.notificationFrequency, threshold: incident.notificationThreshold ?? null };
}

/**
 * @param n Positive integer
 * @returns "1st", "2nd", "50th", "111th"
 */
function ordinal(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * @param frequency A notification frequency value such as "NTH_IN_HOUR"
 * @param threshold N for the NTH_* frequencies
 * @returns Friendly label, with N filled in when known ("every 50th in an hour")
 */
function frequencyLabel(frequency, threshold) {
  const label = FREQUENCIES.find(([f]) => f === frequency)?.[1] ?? String(frequency).toLowerCase().replace(/_/g, " ");
  return NTH.has(frequency) && threshold ? label.replace("Nth", ordinal(threshold)) : label;
}

/**
 * Validates a notification threshold typed by the user.
 * @param text Raw input
 * @returns `{ value }` for a positive integer, else `{ error }`
 */
function parseThreshold(text) {
  const s = String(text ?? "").trim();
  if (!/^\d+$/.test(s)) return { error: "Enter a whole number of 1 or more" };
  const value = Number(s);
  if (value < 1) return { error: "Enter a whole number of 1 or more" };
  if (value > MAX_THRESHOLD) return { error: "That number is too large" };
  return { value };
}

/**
 * @param visuals Dashboard visuals
 * @returns Visuals in reading order of the dashboard grid (top to bottom, then left to right)
 */
function readingOrder(visuals) {
  return [...visuals].sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0));
}

/**
 * Fills a visual's `lineLabel` template (`%name%`, `%field%`, `%<tag key>%`) for one series.
 * @param template The visual's lineLabel, may be empty
 * @param s Series with `name`, `field` and `tags`
 * @returns Display label
 */
function seriesLabel(template, s) {
  const tags = Object.fromEntries((s.tags ?? []).map((g) => [g.key, g.value]));
  const fallback = [s.name, ...Object.values(tags)].join(" ");
  if (!template) return fallback;
  const label = template.replace(/%([^%]+)%/g, (_m, k) => (k === "name" ? s.name : k === "field" ? s.field.toLowerCase() : tags[k] ?? ""))
    .replace(/\s+/g, " ").replace(/^[\s\-–—·,|:]+|[\s\-–—·,|:]+$/g, "");
  return label || fallback;
}

/**
 * Turns a GraphQL timeseries into chart series. Point value keys are `<digest>;<field lowercased>`.
 * AREA_RELATIVE values become each series' share of the total at that time.
 * @param v Dashboard visual
 * @param ts GraphQL timeseries result
 * @returns `{ times, resolution, series }`, series sorted by total, largest first
 */
function buildChart(v, ts) {
  const points = [...(ts.points ?? [])].sort((a, b) => a.timestamp - b.timestamp);
  const times = points.map((p) => p.timestamp);
  const series = (ts.keys ?? []).flatMap((k) => (k.fields ?? []).map((field) => ({
    key: `${k.digest};${String(field).toLowerCase()}`, name: k.name, field: String(field), tags: k.tags ?? [],
    values: new Array(points.length).fill(null),
  })));
  const byKey = new Map(series.map((s) => [s.key, s]));
  points.forEach((p, i) => {
    for (const x of p.values ?? []) {
      const s = byKey.get(x.key);
      if (s && typeof x.value === "number") s.values[i] = x.value;
    }
  });
  const relative = v.display === "AREA_RELATIVE";
  if (v.drawNullAsZero || relative || v.display === "AREA") {
    for (const s of series) s.values = s.values.map((x) => x ?? 0);
  }
  if (relative) {
    const sums = times.map((_t, i) => series.reduce((a, s) => a + s.values[i], 0));
    for (const s of series) s.values = s.values.map((x, i) => (sums[i] ? (x / sums[i]) * 100 : 0));
  }
  for (const s of series) {
    s.label = seriesLabel(v.lineLabel, s);
    s.total = s.values.reduce((a, x) => a + (x ?? 0), 0);
    s.last = [...s.values].reverse().find((x) => x != null) ?? null;
  }
  series.sort((a, b) => b.total - a.total);
  return { times, resolution: ts.resolution, series };
}

/**
 * @param v A positive number
 * @returns The next "nice" axis maximum at or above it (1, 2, 2.5, 5 times a power of ten)
 */
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/**
 * @param n Number
 * @param digits Maximum decimals
 * @returns Number rounded to at most `digits` decimals, without trailing zeros
 */
function trimmed(n, digits) {
  return String(Number(n.toFixed(digits)));
}

/**
 * @param n Number
 * @returns Compact number: "1,234", "12.5k", "3.2M", "0.42"
 */
function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${trimmed(n / 1e9, 1)}B`;
  if (a >= 1e6) return `${trimmed(n / 1e6, 1)}M`;
  if (a >= 1e4) return `${trimmed(n / 1e3, 1)}k`;
  if (Number.isInteger(n)) return count(n);
  return trimmed(n, a < 10 ? 2 : 1);
}

const SIZE_UNITS = { bit: 1 / 8, byte: 1, kilobyte: 1024, megabyte: 1024 ** 2, gigabyte: 1024 ** 3, terabyte: 1024 ** 4 };
const RESOLUTION_UNITS = { MINUTELY: "min", HOURLY: "h", DAILY: "d" };

/**
 * Formats a metric value the way the visual's `format` asks.
 * @param x Value; durations are milliseconds and percents already 0 to 100
 * @param v Dashboard visual (`format`, `formatInput`)
 * @param resolution Timeseries resolution, for throughput units
 * @returns Display text, or "—" when there is no value
 */
function formatMetric(x, v, resolution) {
  if (typeof x !== "number" || Number.isNaN(x)) return "—";
  switch (v.format) {
    case "duration":
      return x < 1 ? `${trimmed(x, 2)}ms` : duration(x);
    case "percent":
      return `${trimmed(x, Math.abs(x) < 10 ? 1 : 0)}%`;
    case "size": {
      let bytes = x * (SIZE_UNITS[String(v.formatInput ?? "byte").toLowerCase()] ?? 1);
      const units = ["B", "KB", "MB", "GB", "TB"];
      let u = 0;
      while (Math.abs(bytes) >= 1024 && u < units.length - 1) { bytes /= 1024; u++; }
      return `${trimmed(bytes, bytes < 10 && u > 0 ? 1 : 0)} ${units[u]}`;
    }
    case "throughput":
      return `${compact(x)}/${RESOLUTION_UNITS[resolution] ?? "min"}`;
    default:
      return compact(x);
  }
}

/**
 * @param sec Unix seconds
 * @param span Seconds the chart covers, to choose how much of the date to show
 * @returns "14:00", "Nov 4 14:00" or "Nov 4"
 */
function chartTime(sec, span) {
  const d = new Date(sec * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (span <= 26 * 3600) return hm;
  return span <= 3 * 86400 ? `${day} ${hm}` : day;
}

/**
 * @param f Fraction of the plot height, 0 at the bottom
 * @returns Path y coordinate inside the plot's vertical padding
 */
function plotY(f) {
  return `${(PLOT_BOTTOM - Math.min(1, Math.max(0, f)) * (PLOT_BOTTOM - PLOT_TOP)).toFixed(3)}%`;
}

/**
 * @param f Fraction of the plot width
 * @returns Path x coordinate
 */
function plotX(f) {
  return `${(f * 100).toFixed(3)}%`;
}

/**
 * Builds a stroked line through the points, broken at nulls. Runs of a single point are skipped.
 * @param xs X fractions
 * @param ys Y fractions, or null for a gap
 * @returns The path, or null when there is nothing to draw
 */
function linePath(xs, ys) {
  let p = PathBuilder.stroke(1.5);
  let any = false;
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      p = p.move_to(plotX(run[0][0]), plotY(run[0][1]));
      for (const [x, y] of run.slice(1)) p = p.line_to(plotX(x), plotY(y));
      any = true;
    }
    run = [];
  };
  ys.forEach((y, i) => (y == null ? flush() : run.push([xs[i], y])));
  flush();
  return any ? p.build() : null;
}

/**
 * Builds a filled band between two lines, for stacked areas.
 * @param xs X fractions
 * @param lower Y fractions of the band's bottom
 * @param upper Y fractions of the band's top
 * @returns The path, or null with fewer than two points
 */
function bandPath(xs, lower, upper) {
  if (xs.length < 2) return null;
  const top = xs.map((x, i) => [plotX(x), plotY(upper[i])]);
  const bottom = xs.map((x, i) => [plotX(x), plotY(lower[i])]).reverse();
  return PathBuilder.fill().add_polygon([...top, ...bottom], true).build();
}

/**
 * Lays out a chart's visible series as paths. Built once per data load and reused on redraws.
 * @param v Dashboard visual
 * @param d Output of buildChart
 * @returns `{ shown, hidden, lo, hi, grid, lines, bands }`
 */
function chartGeometry(v, d) {
  const shown = d.series.slice(0, MAX_SERIES);
  const n = d.times.length;
  const xs = d.times.map((_t, i) => (n > 1 ? i / (n - 1) : 0.5));
  const stacked = v.display === "AREA" || v.display === "AREA_RELATIVE";
  let tops = shown.map((s) => s.values);
  if (stacked) {
    const acc = new Array(n).fill(0);
    tops = shown.map((s) => s.values.map((x, i) => (acc[i] += x ?? 0)));
  }
  const all = tops.flat().filter((x) => x != null);
  const max = all.length ? Math.max(...all) : 0;
  const min = all.length ? Math.min(...all) : 0;
  const hi = v.display === "AREA_RELATIVE" ? 100 : niceCeil(max);
  const lo = typeof v.minYAxis === "number" ? v.minYAxis : min < 0 ? -niceCeil(-min) : 0;
  const frac = (x) => (x == null ? null : (x - lo) / (hi - lo || 1));
  const fracs = tops.map((ys) => ys.map(frac));
  const bands = stacked ? fracs.map((ys, k) => bandPath(xs, k ? fracs[k - 1] : ys.map(() => frac(Math.max(lo, 0))), ys)) : [];
  let grid = PathBuilder.stroke(1).dash_array([3, 3]);
  for (const f of [0, 0.5, 1]) grid = grid.move_to("0%", plotY(f)).line_to("100%", plotY(f));
  return { shown, hidden: d.series.length - shown.length, lo, hi, xs, grid: grid.build(), lines: fracs.map((ys) => linePath(xs, ys)), bands };
}

export default class AppSignal extends View {
  init(_props, cx) {
    this.app = savedApp(shared(APP_KEY)) ?? DEFAULT_APP;
    this.org = DEFAULT_ORG;
    this.apps = null;
    this.appsError = null;
    this.picking = false;
    this.tab = "exceptions";
    this.exceptions = [];
    this.exceptionsAll = false;
    this.exceptionsMine = false;
    this.alerts = [];
    this.errors = { exceptions: null, alerts: null };
    this.mine = shared(MINE_KEY) === true;
    this.me = null;
    this.meLoading = false;
    this.meError = null;
    this.gen = 0;
    this.loadSeq = 0;
    this.loading = null;
    this.loadedAt = null;
    this.firing = null;
    this.detail = null;
    this.confirm = null;
    this.busy = null;
    this.noting = false;
    this.filter = "";
    this.dashboards = null;
    this.dashboardsError = null;
    this.dashLoading = null;
    this.dashId = null;
    this.pickingDash = false;
    this.timeframe = DEFAULT_TIMEFRAME;
    this.chart = null;
    this.chartGen = 0;
    this.hover = null;
    this.input = InputState.new({ placeholder: "Filter by name, message, action, metric, or #number…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.note = TextareaState.new({ placeholder: "Note (Markdown)…", rows: 3 });
    this.note.set_auto_grow(3, 10);
    this.note.on("submit", (_e, cx) => { this.askNote(); cx.notify(); });
    this.notifyPicking = false;
    this.notifyChoice = null;
    this.thresholdError = null;
    this.threshold = InputState.new({ placeholder: "N" });
    this.threshold.on("change", (_e, cx) => { if (this.thresholdError) { this.thresholdError = null; cx.notify(); } });
    this.threshold.on("submit", (_e, cx) => { this.askNotify(); cx.notify(); });
    cx.spawn(async (cx) => {
      try {
        const r = await cli(["apps", "show-org"]);
        if (r?.org) { this.org = r.org; cx.notify(); }
      } catch {}
    });
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.timer.every(CLOCK_MS, (cx) => cx.notify());
  }

  /** Reloads both incident lists for the current app. Results for an app no longer shown are dropped. */
  refresh(cx) {
    if (this.tab === "charts" || !this.dashboards) this.refreshCharts(cx);
    if (this.loading === this.gen) return;
    const gen = this.gen, app = this.app;
    // A write forces a reload while an older one may still be running; only the newest may land.
    const seq = ++this.loadSeq;
    this.loading = gen;
    cx.notify();
    const mine = this.mine;
    if (mine && !this.me) this.loadViewer(cx);
    cx.spawn(async (cx) => {
      const [exc, ano] = await Promise.allSettled([
        mine ? allExceptions(app.id) : latestIncidents("list-exceptions", app.id),
        latestIncidents("list-anomalies", app.id),
      ]);
      if (gen !== this.gen || seq !== this.loadSeq) return;
      if (mine !== this.mine) {
        // The toggle changed mid-load: this list is the wrong kind, so load again.
        this.loading = null;
        return this.refresh(cx);
      }
      if (exc.status === "fulfilled") {
        this.exceptions = exc.value?.incidents ?? [];
        this.exceptionsAll = exc.value?.complete ?? false;
        this.exceptionsMine = mine;
        this.errors.exceptions = null;
      } else this.errors.exceptions = message(exc.reason);
      if (ano.status === "fulfilled") {
        // Toasts follow OPEN incidents only, as before WIP was listed.
        this.announceFiring(app, ano.value.open);
        this.alerts = ano.value.incidents;
        this.errors.alerts = null;
      } else this.errors.alerts = message(ano.reason);
      if (exc.status === "fulfilled" || ano.status === "fulfilled") this.loadedAt = Date.now();
      this.loading = null;
      cx.notify();
    });
  }

  /**
   * Posts a toast for each alert that started firing since the last load of the same app.
   * The first load of an app only records what is already firing.
   */
  announceFiring(app, alerts) {
    const firing = alerts.filter((a) => a.alertState === "OPEN");
    if (this.firing?.appId === app.id) {
      const fresh = firing.filter((a) => !this.firing.numbers.has(a.number));
      const where = `${app.name} ${app.environment}`;
      if (fresh.length > 3) {
        notify({ title: `${fresh.length} AppSignal alerts firing`, body: where, level: "warning", timeout: 12000 });
      } else {
        for (const a of fresh) {
          const detail = [a.trigger?.metricName, tagText(a.tags)].filter(Boolean).join(" · ");
          notify({ title: `Alert firing: ${a.trigger?.name ?? `#${a.number}`}`, body: `${where}${detail ? ` · ${detail}` : ""}`, level: "warning", timeout: 12000 });
        }
      }
    }
    this.firing = { appId: app.id, numbers: new Set(firing.map((a) => a.number)) };
  }

  /** Learns who the signed-in user is, for the "Assigned to me" toggle. */
  loadViewer(cx) {
    if (this.me || this.meLoading) return;
    this.meLoading = true;
    this.meError = null;
    const appId = this.app.id;
    cx.spawn(async (cx) => {
      try {
        this.me = await viewer(appId);
      } catch (e) {
        this.meError = message(e);
      } finally {
        this.meLoading = false;
        cx.notify();
      }
    });
  }

  /** Flips "Assigned to me", which needs every open and WIP exception rather than the latest page. */
  toggleMine(cx) {
    this.mine = !this.mine;
    setShared(MINE_KEY, this.mine);
    if (this.mine) this.loadViewer(cx);
    if (this.loading !== this.gen) this.refresh(cx);
  }

  loadApps(cx) {
    if (this.apps || this.appsLoading) return;
    this.appsLoading = true;
    this.appsError = null;
    cx.spawn(async (cx) => {
      try {
        this.apps = (await cli(["apps", "list"]))?.apps ?? [];
      } catch (e) {
        this.appsError = message(e);
      } finally {
        this.appsLoading = false;
        cx.notify();
      }
    });
  }

  selectApp(app, cx) {
    this.picking = false;
    if (app.id === this.app.id) return cx.notify();
    this.app = { id: app.id, name: app.name, environment: app.environment };
    setShared(APP_KEY, this.app);
    this.gen++;
    this.exceptions = [];
    this.exceptionsAll = false;
    this.exceptionsMine = false;
    this.alerts = [];
    this.errors = { exceptions: null, alerts: null };
    this.loadedAt = null;
    this.firing = null;
    this.detail = null;
    this.dashboards = null;
    this.dashboardsError = null;
    this.dashId = null;
    this.pickingDash = false;
    this.chart = null;
    this.chartGen++;
    this.hover = null;
    this.refresh(cx);
  }

  open(url) {
    exec("open", [url]).catch((e) => notify({ title: "Couldn't open link", body: message(e), level: "error" }));
  }

  /**
   * @param kind "exception" or "anomaly"
   * @param n Incident number
   * @returns The incident's page in AppSignal
   */
  url(kind, n) {
    const area = kind === "exception" ? "exceptions" : "anomalies";
    return `https://appsignal.com/${this.org}/sites/${this.app.id}/${area}/incidents/${n}`;
  }

  /** Replaces the list with one incident, loading its details, notes and (for exceptions) samples. */
  show(kind, item, cx) {
    const d = { kind, number: item.number, item, appId: this.app.id, incident: null, notes: null, samples: null, notification: null, errors: {} };
    this.detail = d;
    this.confirm = null;
    this.noting = false;
    this.note.set_value("");
    this.closeNotifyPicker();
    this.loadDetail(d, cx);
    cx.notify();
  }

  loadDetail(d, cx) {
    const target = ["--app-id", d.appId, "--number", String(d.number)];
    const part = (key, args, pick) => cx.spawn(async (cx) => {
      try {
        d[key] = pick(await cli(args));
        d.errors[key] = null;
      } catch (e) {
        d.errors[key] = message(e);
      }
      cx.notify();
    });
    part("incident", ["incidents", "show", ...target], (r) => r?.incident ?? null);
    part("notes", ["incidents", "list-notes", ...target], (r) => r?.notes ?? []);
    if (d.kind !== "exception") return;
    part("samples", ["samples", "incident", ...target, "--limit", String(SAMPLES)], latestSamples);
    cx.spawn(async (cx) => {
      try {
        d.notification = await notificationSetting(d.appId, d.number);
        d.errors.notification = null;
      } catch (e) {
        d.errors.notification = message(e);
      }
      cx.notify();
    });
  }

  /**
   * @param d Incident detail
   * @returns "#123 in Hugolith production"
   */
  where(d) {
    return `#${d.number} in ${this.app.name} ${this.app.environment}`;
  }

  /** Stages a write for confirmation; nothing runs until the user confirms it. */
  ask(kind) {
    const d = this.detail;
    if (!d || this.busy) return;
    const target = ["--app-id", d.appId, "--number", String(d.number)];
    if (kind === "assign") this.confirm = { kind, prompt: `Assign ${this.where(d)} to you?`, verb: "Assigned", label: "Assign me",
      args: ["incidents", "update", ...target, "--assign-me"] };
  }

  /**
   * Stages a state change for confirmation.
   * @param state "OPEN", "WIP" or "CLOSED"
   */
  askState(state) {
    const d = this.detail;
    if (!d || this.busy) return;
    const current = (d.incident ?? d.item).state;
    if (state === current) return;
    const prompt = state === "CLOSED" ? `Close ${this.where(d)}?`
      : state === "WIP" ? `Mark ${this.where(d)} as work in progress?`
      : `Reopen ${this.where(d)}?`;
    const [verb, label] = { CLOSED: ["Closed", "Close incident"], WIP: ["Marked WIP", "Mark WIP"], OPEN: ["Reopened", "Reopen"] }[state];
    this.closeNotifyPicker();
    this.confirm = { kind: "state", state, prompt, verb, label, danger: state === "CLOSED",
      args: ["incidents", "update", "--app-id", d.appId, "--number", String(d.number), "--state", state] };
  }

  /**
   * Picks a notification frequency. The NTH_* ones wait for a threshold; the others go
   * straight to confirmation.
   * @param frequency A FREQUENCIES value
   */
  pickFrequency(frequency) {
    const d = this.detail;
    if (!d || this.busy) return;
    this.notifyChoice = frequency;
    this.thresholdError = null;
    if (NTH.has(frequency)) {
      const current = d.notification?.threshold;
      this.threshold.set_value(current ? String(current) : "");
      this.threshold.focus();
      return;
    }
    this.askNotify();
  }

  /** Validates the picked notification setting and stages it for confirmation. */
  askNotify() {
    const d = this.detail, frequency = this.notifyChoice;
    if (!d || !frequency || this.busy) return;
    const args = ["incidents", "update", "--app-id", d.appId, "--number", String(d.number), "--notification-frequency", frequency];
    let threshold = null;
    this.thresholdError = null;
    if (NTH.has(frequency)) {
      const r = parseThreshold(this.threshold.value());
      if (r.error) {
        this.thresholdError = r.error;
        return;
      }
      threshold = r.value;
      args.push("--notification-threshold", String(threshold));
    }
    const current = d.notification;
    if (current && current.frequency === frequency && (!threshold || current.threshold === threshold)) {
      this.closeNotifyPicker();
      return;
    }
    this.confirm = { kind: "notify", prompt: `Change notifications for ${this.where(d)} to "${frequencyLabel(frequency, threshold)}"?`,
      verb: "Changed notifications for", label: "Save setting", args };
  }

  closeNotifyPicker() {
    this.notifyPicking = false;
    this.notifyChoice = null;
    this.thresholdError = null;
  }

  askNote() {
    const d = this.detail;
    const text = this.note.value().trim();
    if (!d || !text || this.busy) return;
    // `--content=` keeps a note starting with "-" from being read as a flag.
    this.confirm = { kind: "note", prompt: `Add this note to ${this.where(d)}?`, verb: "Added note to", label: "Add note",
      args: ["incidents", "add-note", "--app-id", d.appId, "--number", String(d.number), `--content=${text}`] };
  }

  /**
   * Shows a state change made from the detail view before the lists reload: the incident gets
   * its new state, or leaves the lists when it is no longer in LIST_STATES.
   * @param d Incident detail the change was made on
   * @param state New state, such as "WIP" or "CLOSED"
   */
  applyState(d, state) {
    if (d.appId !== this.app.id) return;
    const patch = (list) => (LIST_STATES.includes(state)
      ? list.map((i) => (i.number === d.number ? { ...i, state } : i))
      : list.filter((i) => i.number !== d.number));
    if (d.kind === "exception") this.exceptions = patch(this.exceptions);
    else this.alerts = patch(this.alerts);
    d.item = { ...d.item, state };
    if (d.incident) d.incident = { ...d.incident, state };
  }

  /** Runs the confirmed write, then reloads the incident and the lists. */
  runConfirmed(cx) {
    const d = this.detail, c = this.confirm;
    if (!d || !c || this.busy) return;
    this.busy = c.kind;
    this.confirm = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await cli(c.args);
        notify({ title: `${c.verb} #${d.number}`, body: `${this.app.name} ${this.app.environment}`, level: "success", timeout: 4000 });
        if (c.kind === "note") { this.note.set_value(""); this.noting = false; }
        if (c.kind === "notify") this.closeNotifyPicker();
        if (c.kind === "state") this.applyState(d, c.state);
        if (this.detail === d) this.loadDetail(d, cx);
      } catch (e) {
        notify({ title: `Couldn't update #${d.number}`, body: message(e), level: "error" });
      } finally {
        this.busy = null;
        this.loading = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  // #region charts

  /** Reloads the dashboard list; when the Charts tab shows, also the selected dashboard's charts. */
  refreshCharts(cx) {
    if (this.dashLoading === this.gen) return;
    const gen = this.gen, app = this.app;
    this.dashLoading = gen;
    cx.spawn(async (cx) => {
      try {
        const list = (await cli(["dashboards", "list", "--app-id", app.id]))?.dashboards ?? [];
        if (gen !== this.gen) return;
        this.dashboards = list;
        this.dashboardsError = null;
        if (!list.some((d) => d.id === this.dashId)) {
          const saved = shared(DASH_KEY)?.[app.id];
          this.dashId = list.some((d) => d.id === saved) ? saved : list[0]?.id ?? null;
        }
        if (this.tab === "charts") this.loadDashboard(cx);
      } catch (e) {
        if (gen === this.gen) this.dashboardsError = message(e);
      } finally {
        if (this.dashLoading === gen) this.dashLoading = null;
        cx.notify();
      }
    });
  }

  /**
   * Loads the selected dashboard's visuals, then each chart's points in parallel. A refresh of the
   * same dashboard and timeframe keeps the charts on screen until new data arrives.
   */
  loadDashboard(cx) {
    const app = this.app, dashId = this.dashId, tf = this.timeframe;
    if (!dashId) return;
    const key = ++this.chartGen;
    const live = () => this.chartGen === key;
    const c = this.chart?.appId === app.id && this.chart.dashId === dashId && this.chart.tf === tf
      ? this.chart
      : { appId: app.id, dashId, tf, visuals: null, data: {}, errors: {}, error: null, loadedAt: null };
    this.chart = c;
    c.loading = true;
    this.hover = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [shown, token] = await Promise.all([cli(["dashboards", "show", "--app-id", app.id, "--id", dashId]), freshToken(app.id)]);
        if (!live()) return;
        c.visuals = readingOrder(shown?.dashboard?.visuals ?? []);
        c.error = null;
        cx.notify();
        let retry = null;
        const query = async (v) => {
          try {
            return await timeseries(token, app.id, tf, v.metrics);
          } catch (e) {
            if (!e?.auth) throw e;
            retry ??= freshToken(app.id);
            return timeseries(await retry, app.id, tf, v.metrics);
          }
        };
        await Promise.all(c.visuals.map(async (v) => {
          try {
            if (!Array.isArray(v.metrics) || v.metrics.length === 0) throw new Error("This chart has no metrics to show");
            const d = buildChart(v, await query(v));
            if (!live()) return;
            d.geometry = v.__typename === "VisualNumber" ? null : chartGeometry(v, d);
            c.data[v.id] = d;
            c.errors[v.id] = null;
          } catch (e) {
            if (!live()) return;
            c.errors[v.id] = message(e);
          }
          cx.notify();
        }));
        if (live()) c.loadedAt = Date.now();
      } catch (e) {
        if (live()) c.error = message(e);
      } finally {
        if (live()) {
          c.loading = false;
          cx.notify();
        }
      }
    });
  }

  showCharts(cx) {
    this.tab = "charts";
    const c = this.chart;
    if (!c || c.appId !== this.app.id || c.dashId !== this.dashId || c.tf !== this.timeframe || (!c.loading && !c.loadedAt)) this.loadDashboard(cx);
  }

  selectDashboard(d, cx) {
    this.pickingDash = false;
    if (d.id === this.dashId) return;
    this.dashId = d.id;
    const saved = shared(DASH_KEY);
    setShared(DASH_KEY, { ...(saved && typeof saved === "object" ? saved : {}), [this.app.id]: d.id });
    this.loadDashboard(cx);
  }

  selectTimeframe(tf, cx) {
    if (tf === this.timeframe) return;
    this.timeframe = tf;
    this.loadDashboard(cx);
  }

  renderDashPicker(t) {
    const groups = new Map();
    for (const d of this.dashboards ?? []) {
      const slash = d.title.indexOf("/");
      const group = slash > 0 ? d.title.slice(0, slash) : "";
      groups.set(group, [...(groups.get(group) ?? []), d]);
    }
    return v_flex().id("dash-picker").max_h(320).overflow_y_scrollbar().gap(6).p(8).rounded(8).bg(t.background).border_1().border_color(t.border)
      .children([...groups.entries()].map(([group, list], gi) => v_flex().gap(4)
        .when(Boolean(group), (el) => el.child(div().text_size(13).font_semibold().text_color(t.muted).child(group)))
        .child(h_flex().gap(4).flex_wrap().children(list.map((d, di) => this.chip(t, `dash-${gi}-${di}`,
          group ? d.title.slice(group.length + 1) : d.title, d.id === this.dashId, (cx) => this.selectDashboard(d, cx)))))));
  }

  renderChartControls(t) {
    const dash = this.dashboards?.find((d) => d.id === this.dashId);
    return v_flex().gap(8)
      .child(h_flex().gap(6).items_center()
        .child(h_flex().id("dash-button").min_w(0).flex_1().px(8).h(26).gap(4).items_center().rounded(7).text_size(13)
          .text_color(t.foreground).bg(this.pickingDash ? t.selected : t.raised).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.pickingDash = !this.pickingDash; cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().child(dash?.title ?? "Choose a dashboard"))
          .child(div().flex_none().text_color(t.dim).child("▾"))))
      .when(this.pickingDash, (el) => el.child(this.renderDashPicker(t)))
      .child(h_flex().gap(3).flex_wrap().children(TIMEFRAMES.map(([tf, label]) => div().id(`tf-${tf}`).px(7).h(22).flex().items_center()
        .rounded(6).text_size(12).text_color(tf === this.timeframe ? t.accent_foreground : t.muted)
        .bg(tf === this.timeframe ? t.accent : t.surface).hover((s) => s.bg(tf === this.timeframe ? t.accent : t.hover))
        .on_click((_e, cx) => { this.selectTimeframe(tf, cx); cx.notify(); })
        .child(label))));
  }

  chartStatus() {
    const c = this.chart;
    const dash = this.dashboards?.find((d) => d.id === this.dashId);
    if (c?.error) return { text: c.error, error: true };
    if (!dash) return { text: this.dashboardsError ?? "No dashboards for this app", error: Boolean(this.dashboardsError) };
    if (!c?.visuals) return { text: `Loading ${dash.title}…` };
    const n = c.visuals.length;
    const charts = `${n} chart${n === 1 ? "" : "s"}`;
    return { text: c.loadedAt ? `${charts} · updated ${this.ago(c.loadedAt)}` : `${charts} · loading…` };
  }

  /** Series colors drawn from the theme, so charts follow the user's palette. */
  palette(t) {
    return [t.accent, t.ansi2, t.ansi3, t.ansi5, t.ansi1, t.ansi6, t.ansi10, t.ansi9];
  }

  renderChart(t, v, d, error) {
    const number = v.__typename === "VisualNumber";
    const g = d?.geometry;
    const hoverAt = g && this.hover?.id === v.id ? this.hover.i : null;
    const at = (s) => (hoverAt == null ? s.last : s.values[hoverAt]);
    const single = d?.series.length === 1;
    const span = d && d.times.length > 1 ? d.times[d.times.length - 1] - d.times[0] : 0;
    const head = hoverAt != null ? chartTime(d.times[hoverAt], Infinity) : single && !number ? formatMetric(d.series[0].last, v, d.resolution) : "";
    const colors = this.palette(t);
    const card = v_flex().p(10).gap(6).flex_none().rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(v.title ?? "Untitled"))
        .when(Boolean(head), (el) => el.child(div().flex_none().text_size(13).text_color(hoverAt != null ? t.muted : t.foreground).child(head))))
      .when(Boolean(error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(error)));
    if (!d) return card.when(!error, (el) => el.child(div().h(number ? 32 : CHART_H).flex().items_center().justify_center()
      .text_size(12).text_color(t.dim).child("Loading…")));
    if (d.series.length === 0) return card.child(div().text_size(12).text_color(t.dim).child("No data in this timeframe"));
    if (number) return card.child(div().text_size(28).font_semibold().text_color(t.foreground).child(formatMetric(d.series[0].last, v, d.resolution)));
    const paint = (path, color) => window.paint_path(path, color).absolute().top(0).left(0).size_full();
    const plot = div().id(`plot-${v.id}`).relative().w_full().h(CHART_H)
      .child(paint(g.grid, t.border))
      .children(g.bands.map((b, k) => b && paint(b, Background.solid(colors[k % colors.length]).opacity(0.22))).filter(Boolean))
      .children(g.lines.map((l, k) => l && paint(l, colors[k % colors.length])).filter(Boolean))
      .when(hoverAt != null, (el) => el.child(paint(PathBuilder.stroke(1).move_to(plotX(g.xs[hoverAt]), "0%").line_to(plotX(g.xs[hoverAt]), "100%").build(), t.muted)))
      .child(div().absolute().top(0).left(0).text_size(10).text_color(t.dim).child(formatMetric(g.hi, v, d.resolution)))
      .on_mouse_move((e, cx) => {
        const w = e.bounds?.width;
        if (!w || d.times.length === 0) return;
        const i = Math.max(0, Math.min(d.times.length - 1, Math.round((e.local_position.x / w) * (d.times.length - 1))));
        if (this.hover?.id === v.id && this.hover.i === i) return;
        this.hover = { id: v.id, i };
        cx.notify();
      })
      .on_hover((hovered, cx) => {
        if (hovered || this.hover?.id !== v.id) return;
        this.hover = null;
        cx.notify();
      });
    const axis = h_flex().justify_between().text_size(10).text_color(t.dim)
      .child(div().child(d.times.length ? chartTime(d.times[0], span) : ""))
      .child(div().child(d.times.length > 2 ? chartTime(d.times[Math.floor((d.times.length - 1) / 2)], span) : ""))
      .child(div().child(d.times.length > 1 ? chartTime(d.times[d.times.length - 1], span) : ""));
    const legend = v_flex().gap(1)
      .when(!single, (el) => el.children(g.shown.map((s, k) => h_flex().gap(6).items_center().text_size(12)
        .child(div().size(8).rounded(2).flex_none().bg(colors[k % colors.length]))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.label))
        .child(div().flex_none().text_color(t.foreground).child(formatMetric(at(s), v, d.resolution))))))
      .when(single && hoverAt != null, (el) => el.child(h_flex().gap(6).items_center().text_size(12)
        .child(div().size(8).rounded(2).flex_none().bg(colors[0]))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(d.series[0].label))
        .child(div().flex_none().text_color(t.foreground).child(formatMetric(at(d.series[0]), v, d.resolution)))))
      .when(g.hidden > 0, (el) => el.child(div().pl(14).text_size(12).text_color(t.dim).child(`+${g.hidden} more`)));
    return card.child(v_flex().gap(2).child(plot).child(axis)).child(legend);
  }

  renderCharts(t) {
    const c = this.chart;
    const visuals = c?.visuals ?? [];
    return v_flex().id("chart-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8)
      .children(visuals.map((v) => this.renderChart(t, v, c.data[v.id], c.errors[v.id])))
      .when(Boolean(c?.visuals) && visuals.length === 0, (el) => el.child(div().p(10).text_size(13).text_color(t.dim).child("This dashboard has no charts")));
  }

  // #endregion

  // #region list

  /**
   * @param ms Epoch milliseconds
   * @returns "just now" or "5m ago"
   */
  ago(ms) {
    const a = age(new Date(ms).toISOString());
    return a === "now" ? "just now" : `${a} ago`;
  }

  matches(i) {
    const f = this.filter.trim().toLowerCase();
    if (!f) return true;
    if (/^#\d+$/.test(f)) return String(i.number).startsWith(f.slice(1));
    return [String(i.number), i.exceptionName, i.exceptionMessage, i.namespace, ...(i.actionNames ?? []),
      i.trigger?.name, i.trigger?.metricName, tagText(i.tags)]
      .some((s) => s && String(s).toLowerCase().includes(f));
  }

  severityColor(t, s) {
    return { CRITICAL: t.blocked, HIGH: t.working, LOW: t.muted, UNTRIAGED: t.accent }[s] ?? t.dim;
  }

  button(t, id, label, action, color) {
    return div().id(id).px(8).h(24).flex().flex_none().items_center().rounded(6).text_size(13)
      .text_color(color ?? t.muted).bg(t.raised).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
      .on_click((_e, cx) => { action(cx); cx.notify(); })
      .child(label);
  }

  chip(t, id, label, on, action) {
    return div().id(id).px(9).h(26).flex().flex_none().items_center().gap(6).rounded(7)
      .text_size(13).text_color(on ? t.accent_foreground : t.muted).bg(on ? t.accent : t.raised)
      .hover((s) => s.bg(on ? t.accent : t.hover))
      .on_click((_e, cx) => { action(cx); cx.notify(); })
      .child(label);
  }

  /**
   * @param t Theme colors
   * @returns A small outlined "WIP" pill for incidents marked work in progress
   */
  wipBadge(t) {
    return div().flex_none().px(5).h(16).flex().items_center().rounded(8).border_1().border_color(t.accent)
      .text_size(11).font_semibold().text_color(t.accent).child("WIP");
  }

  renderException(t, i) {
    const showMessage = i.exceptionMessage && i.exceptionMessage !== i.exceptionName;
    const actions = i.actionNames ?? [];
    const people = assigneeNames(i.assignees);
    return v_flex().id(`exc-${i.number}`).px(8).py(6).gap(3).rounded(7).flex_none()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.show("exception", i, cx))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().flex_none().w(66).gap(6).items_center()
          .child(div().size(7).rounded(4).flex_none().bg(this.severityColor(t, i.severity)))
          .child(div().text_color(t.dim).child(`#${i.number}`)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(i.exceptionName ?? "Exception"))
        .when(i.state === "WIP", (row) => row.child(this.wipBadge(t)))
        .child(div().flex_none().text_size(13).text_color(t.dim).child(age(i.lastOccurredAt))))
      .when(Boolean(showMessage), (el) => el.child(div().pl(74).text_size(13).truncate().text_color(t.muted).child(i.exceptionMessage)))
      .child(h_flex().pl(74).gap(10).min_w(0).text_size(13).text_color(t.dim)
        .child(div().flex_none().text_color(t.muted).child(`${count(i.count)}×`))
        .when(Boolean(i.namespace), (row) => row.child(div().flex_none().child(i.namespace)))
        .when(people.length > 0, (row) => row.child(div().flex_none().text_color(t.accent).child(people.join(", "))))
        .when(actions.length > 0, (row) => row.child(div().flex_1().min_w(0).truncate()
          .child(actions.length > 1 ? `${actions[0]} +${actions.length - 1}` : actions[0]))));
  }

  renderAlert(t, a) {
    const firing = a.alertState === "OPEN";
    const tags = tagText(a.tags);
    return v_flex().id(`ano-${a.number}`).px(8).py(6).gap(3).rounded(7).flex_none()
      .border_l(3).border_color(firing ? t.blocked : "#00000000")
      .when(firing, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.show("anomaly", a, cx))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().flex_none().w(66).gap(6).items_center()
          .child(div().size(7).rounded(4).flex_none().bg(firing ? t.blocked : t.dim)
            .when(firing, (d) => d.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
          .child(div().text_color(t.dim).child(`#${a.number}`)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(firing, (d) => d.font_semibold())
          .child(a.trigger?.name ?? "Anomaly"))
        .when(a.state === "WIP", (row) => row.child(this.wipBadge(t)))
        .child(div().flex_none().text_size(13).text_color(firing ? t.blocked : t.dim).child(firing ? "firing" : age(a.lastOccurredAt))))
      .child(h_flex().pl(74).gap(10).min_w(0).text_size(13).text_color(t.dim)
        .child(div().flex_none().text_color(t.muted).child(`${count(a.count)}×`))
        .when(Boolean(tags), (row) => row.child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(tags)))
        .when(Boolean(a.trigger?.metricName), (row) => row.child(div().flex_shrink(3).min_w(0).truncate().child(a.trigger.metricName))));
  }

  renderPicker(t) {
    const byName = new Map();
    for (const a of this.apps ?? []) byName.set(a.name, [...(byName.get(a.name) ?? []), a]);
    return v_flex().gap(6).p(8).rounded(8).bg(t.background).border_1().border_color(t.border)
      .when(!this.apps, (el) => el.child(div().text_size(13).text_color(this.appsError ? t.blocked : t.dim)
        .child(this.appsError ?? "Loading apps…")))
      .children([...byName.entries()].map(([name, envs], gi) => v_flex().gap(4)
        .child(div().text_size(13).font_semibold().text_color(t.muted).child(name))
        .child(h_flex().gap(4).flex_wrap().children(envs.map((a, ei) =>
          this.chip(t, `app-${gi}-${ei}`, a.environment ?? "default", a.id === this.app.id, (cx) => this.selectApp(a, cx)))))));
  }

  renderList(t) {
    const firing = this.alerts.filter((a) => a.alertState === "OPEN").length;
    const charts = this.tab === "charts" && Boolean(this.dashboards);
    const tab = this.tab === "charts" && !charts ? "exceptions" : this.tab;
    const mine = tab === "exceptions" && this.mine;
    const mineReady = mine && this.exceptionsMine && Boolean(this.me);
    const all = mine ? (mineReady ? this.exceptions.filter((i) => assignedTo(i, this.me)) : [])
      : tab === "exceptions" ? this.exceptions : this.alerts;
    const items = tab === "exceptions"
      ? all.filter((i) => this.matches(i))
      : this.alerts.filter((a) => this.matches(a)).sort((a, b) =>
        (b.alertState === "OPEN") - (a.alertState === "OPEN") || Date.parse(b.lastOccurredAt) - Date.parse(a.lastOccurredAt));
    const chartStatus = charts ? this.chartStatus() : null;
    const error = charts ? (chartStatus.error ? chartStatus.text : null)
      : this.errors[tab === "exceptions" ? "exceptions" : "alerts"] ?? (mine && this.meError ? `Couldn't tell who you are: ${this.meError}` : null);
    const many = (n) => (n >= LIMIT ? `${n}+` : String(n));
    const excCount = this.exceptionsAll ? String(this.exceptions.length) : many(this.exceptions.length);
    const total = tab === "exceptions" ? excCount : many(all.length);
    const status = charts ? chartStatus.text
      : error ? error
      : !this.loadedAt ? `Loading ${this.app.name} ${this.app.environment}…`
      : mine && !mineReady ? "Loading every open and WIP exception…"
      : mine ? `${items.length === all.length ? all.length : `${items.length} of ${all.length}`} assigned to you of ${excCount} open + WIP · updated ${this.ago(this.loadedAt)}`
      : `${items.length === all.length ? total : `${items.length} of ${total}`} open + WIP · updated ${this.ago(this.loadedAt)}`;
    const refreshing = this.loading === this.gen || (charts && Boolean(this.chart?.loading));
    const empty = mine ? "Nothing assigned to you" : tab === "exceptions" ? "No open or WIP exceptions" : "No open or WIP alerts";
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_size(15)
      .child(v_flex().p(10).gap(8).flex_none().border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(svg("mods/appsignal/appsignal.svg").size(16).flex_none().text_color(t.muted))
          .child(div().flex_none().font_semibold().text_color(t.foreground).child("AppSignal"))
          .child(h_flex().id("app-picker").min_w(0).px(8).h(24).gap(4).items_center().rounded(6).text_size(13)
            .text_color(t.muted).bg(this.picking ? t.selected : t.surface).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.picking = !this.picking; if (this.picking) this.loadApps(cx); cx.notify(); })
            .child(div().min_w(0).truncate().child(`${this.app.name} · ${this.app.environment}`))
            .child(div().flex_none().text_color(t.dim).child("▾")))
          .child(div().flex_1())
          .child(div().id("refresh").flex_none().px(8).h(24).flex().items_center().rounded(6).text_size(13)
            .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.refresh(cx))
            .child(refreshing ? "Refreshing…" : "Refresh")))
        .when(this.picking, (el) => el.child(this.renderPicker(t)))
        .child(h_flex().gap(5).flex_wrap().items_center()
          .child(this.chip(t, "tab-exceptions", `Exceptions ${this.loadedAt ? excCount : ""}`.trim(),
            tab === "exceptions", () => { this.tab = "exceptions"; }))
          .child(this.chip(t, "tab-alerts", h_flex().gap(6).items_center()
            .child(`Alerts ${this.loadedAt ? many(this.alerts.length) : ""}`.trim())
            .when(firing > 0, (el) => el.child(h_flex().gap(4).items_center().px(5).h(16).rounded(8).bg(t.blocked)
              .text_size(11).font_semibold().text_color(t.background).child(`${firing} firing`))),
            tab === "alerts", () => { this.tab = "alerts"; }))
          .when(Boolean(this.dashboards), (el) => el.child(this.chip(t, "tab-charts", "Charts", charts, (cx) => this.showCharts(cx))))
          .when(tab === "exceptions" && !charts, (el) => el.child(div().flex_1())
            .child(this.chip(t, "mine", h_flex().gap(5).items_center()
              .child(div().size(10).flex_none().rounded(3).border_1().border_color(this.mine ? t.accent_foreground : t.dim)
                .when(this.mine, (b) => b.bg(t.accent_foreground)))
              .child("Assigned to me"), this.mine, (cx) => this.toggleMine(cx)))))
        .child(charts ? this.renderChartControls(t)
          : Input.new(this.input).h(32).flex_none().px(10).rounded(8).border_1().border_color(t.input)
            .bg(t.background).text_size(14).text_color(t.foreground))
        .child(div().text_size(13).text_color(error ? t.blocked : t.dim).child(status)))
      .child(charts ? this.renderCharts(t) : v_flex().id("incident-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).py(6).gap(2)
        .children(items.map((i) => (tab === "exceptions" ? this.renderException(t, i) : this.renderAlert(t, i))))
        .when(Boolean(this.loadedAt) && !error && (!mine || mineReady) && items.length === 0,
          (el) => el.child(div().p(10).text_size(13).text_color(t.dim).child(all.length ? "No matching incidents" : empty))));
  }

  // #endregion

  // #region detail

  meta(t, label, value) {
    return h_flex().gap(8).items_start().text_size(13)
      .child(div().flex_none().w(84).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_color(t.muted).child(value));
  }

  section(t, title, extra) {
    return h_flex().gap(6).items_center().pt(4)
      .child(div().text_size(13).font_semibold().text_color(t.muted).child(title))
      .when(extra != null, (el) => el.child(div().text_size(13).text_color(t.dim).child(extra)));
  }

  /** Open / WIP / Closed, with the incident's current state selected. */
  renderStateControl(t, state) {
    return h_flex().id("state-control").flex_none().p(2).gap(2).rounded(7).bg(t.raised)
      .children(STATES.map(([value, label]) => {
        const on = value === state;
        return div().id(`state-${value}`).px(9).h(20).flex().items_center().rounded(5).text_size(13)
          .text_color(on ? t.accent_foreground : t.muted).bg(on ? t.accent : t.raised)
          .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => { this.askState(value); cx.notify(); })
          .child(label);
      }));
  }

  /** The notification setting of an exception incident, and the picker that changes it. */
  renderNotification(t, d) {
    const n = d.notification;
    const current = n ? frequencyLabel(n.frequency, n.threshold)
      : d.errors.notification ? "current setting unknown" : "loading…";
    const choice = this.notifyChoice;
    const picker = v_flex().gap(6).p(8).rounded(8).bg(t.background).border_1().border_color(t.border)
      .child(h_flex().gap(4).flex_wrap().children(FREQUENCIES.map(([f]) => {
        const label = frequencyLabel(f, n?.frequency === f ? n.threshold : null);
        return this.chip(t, `notify-${f}`, label, choice ? choice === f : n?.frequency === f, () => this.pickFrequency(f));
      })))
      .when(NTH.has(choice), (el) => el.child(v_flex().gap(4)
        .child(h_flex().gap(6).items_center().text_size(13)
          .child(div().flex_none().text_color(t.muted).child("Notify on occurrence"))
          .child(Input.new(this.threshold).w(72).h(26).flex_none().px(8).rounded(6).border_1()
            .border_color(this.thresholdError ? t.blocked : t.input).bg(t.surface).text_size(13).text_color(t.foreground))
          .child(div().flex_none().text_color(t.muted).child(choice === "NTH_IN_HOUR" ? "in an hour" : "in a day"))
          .child(div().flex_1())
          .child(this.button(t, "notify-save", "Save…", () => this.askNotify(), t.foreground)))
        .when(Boolean(this.thresholdError), (c) => c.child(div().text_size(12).text_color(t.blocked).child(this.thresholdError)))));
    return v_flex().gap(6)
      .child(h_flex().min_w(0).gap(6).items_center().text_size(13)
        .child(div().flex_none().text_color(t.dim).child("Notify"))
        .child(h_flex().id("notify-current").min_w(0).px(8).h(24).gap(4).items_center().rounded(6)
          .text_color(n ? t.muted : t.dim).bg(this.notifyPicking ? t.selected : t.raised)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            if (this.notifyPicking) this.closeNotifyPicker();
            else this.notifyPicking = true;
            cx.notify();
          })
          .child(div().min_w(0).truncate().child(current))
          .child(div().flex_none().text_color(t.dim).child("▾"))))
      .when(this.notifyPicking, (el) => el.child(picker));
  }

  renderActions(t, d) {
    if (this.busy) return div().text_size(13).text_color(t.dim).child("Working…");
    if (this.confirm) {
      const c = this.confirm;
      return v_flex().gap(6).p(8).rounded(8).border_1().border_color(c.danger ? t.blocked : t.accent).bg(t.background)
        .child(div().text_size(13).text_color(t.foreground).child(c.prompt))
        .child(h_flex().gap(5)
          .child(div().id("confirm-yes").px(10).h(24).flex().items_center().rounded(6).text_size(13).font_semibold()
            .bg(c.danger ? t.blocked : t.solid).text_color(c.danger ? t.background : t.solid_foreground)
            .hover((s) => s.opacity(0.88))
            .on_click((_e, cx) => this.runConfirmed(cx))
            .child(c.label))
          .child(this.button(t, "confirm-no", "Cancel", () => { this.confirm = null; })));
    }
    return v_flex().gap(6)
      .child(h_flex().gap(5).flex_wrap().items_center()
        .child(this.renderStateControl(t, (d.incident ?? d.item).state))
        .child(this.button(t, "act-assign", "Assign me", () => this.ask("assign")))
        .child(this.button(t, "act-note", this.noting ? "Cancel note" : "Add note", () => {
          this.noting = !this.noting;
          if (this.noting) this.note.focus();
        })))
      .when(d.kind === "exception", (el) => el.child(this.renderNotification(t, d)))
      .when(this.noting, (el) => el.child(v_flex().gap(5)
        .child(Textarea.new(this.note).w_full().px(9).py(6).rounded(7).border_1().border_color(t.input)
          .bg(t.background).text_size(14).text_color(t.foreground))
        .child(h_flex().justify_end().child(this.button(t, "note-save", "Save note…", () => this.askNote(), t.foreground)))));
  }

  renderSample(t, s, i) {
    const tags = Object.entries(s.tags ?? {});
    return v_flex().gap(3).py(6).border_t(1).border_color(t.border)
      .child(h_flex().gap(10).text_size(13)
        .child(div().flex_none().text_color(t.foreground).child(stamp(s.time)))
        .child(div().flex_none().text_color(t.muted).child(duration(s.duration)))
        .when(Boolean(s.revision), (el) => el.child(div().flex_none().text_color(t.dim).child(s.revision))))
      .when(Boolean(s.action_name), (el) => el.child(div().text_size(13).truncate().text_color(t.muted).child(s.action_name)))
      .when(tags.length > 0, (el) => el.child(div().text_size(12).text_color(t.dim)
        .child(TextView.html(`sample-tags-${i}`, escapeHtml(tags.map(([k, v]) => `${k}=${v}`).join("  ·  "))).selectable(true))));
  }

  renderDetail(t) {
    const d = this.detail;
    const i = d.incident ?? d.item;
    const exception = d.kind === "exception";
    const firing = !exception && i.alertState === "OPEN";
    const title = exception ? i.exceptionName ?? "Exception" : i.trigger?.name ?? "Anomaly";
    const people = assigneeNames(i.assignees);
    const actions = i.actionNames ?? [];
    const notes = d.notes ?? [];
    const rows = exception
      ? [
        ["namespace", i.namespace],
        ...actions.map((a, k) => [k === 0 ? (actions.length > 1 ? "actions" : "action") : "", a]),
        ["backtrace", i.firstBacktraceLine],
        ["digests", (i.digests ?? []).join(", ")],
      ]
      : [
        ["metric", i.trigger?.metricName],
        ["tags", tagText(i.tags)],
        ["trigger kind", i.trigger?.kind],
        ["alert", i.alertState === "OPEN" ? "firing now" : "not firing"],
      ];
    const common = [
      ["assignees", people.length ? people.join(", ") : "nobody"],
      ["last seen", stamp(i.lastOccurredAt)],
      ["first seen", stamp(i.createdAt)],
      ["updated", i.updatedAt ? stamp(i.updatedAt) : null],
    ];
    const metaRows = [...rows, ...common].filter(([, v]) => v);
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_size(15)
      .child(v_flex().p(10).gap(8).flex_none().border_b(1).border_color(t.border)
        .child(h_flex().items_center().justify_between()
          .child(this.button(t, "back", exception ? "← Exceptions" : "← Alerts", () => { this.detail = null; this.confirm = null; }))
          .child(this.button(t, "open-appsignal", "Open in AppSignal", () => this.open(this.url(d.kind, d.number)))))
        .child(h_flex().gap(8).items_start()
          .child(div().flex_none().text_color(t.dim).child(`#${d.number}`))
          .child(div().flex_1().min_w(0).font_semibold().text_color(firing ? t.blocked : t.foreground)
            .child(TextView.html(`title-${d.number}`, escapeHtml(title)).selectable(true))))
        .child(h_flex().gap(8).flex_wrap().items_center().text_size(13)
          .when(firing, (el) => el.child(div().px(6).h(18).flex().items_center().rounded(9).bg(t.blocked)
            .text_size(11).font_semibold().text_color(t.background).child("FIRING")))
          .child(h_flex().gap(5).items_center()
            .child(div().size(7).rounded(4).bg(this.severityColor(t, i.severity)))
            .child(div().text_color(t.muted).child((i.severity ?? "").toLowerCase())))
          .child(div().text_color(t.muted).child(`${count(i.count)} occurrences`)))
        .when(Boolean(d.errors.incident), (el) => el.child(div().text_size(13).text_color(t.blocked).child(d.errors.incident)))
        .child(this.renderActions(t, d)))
      .child(v_flex().id("detail-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8)
        .when(exception && Boolean(i.exceptionMessage) && i.exceptionMessage !== i.exceptionName, (el) => el.child(div().px(10).py(8).rounded(8).border_1()
          .border_color(t.border).bg(t.background).text_size(13).text_color(t.foreground)
          .child(TextView.html(`message-${d.number}`, escapeHtml(i.exceptionMessage)).selectable(true))))
        .when(Boolean(i.description), (el) => el.child(div().px(10).py(8).rounded(8).border_1().border_color(t.border)
          .text_size(13).text_color(t.foreground).child(TextView.markdown(`desc-${d.number}`, i.description).selectable(true)
            .on_link_click((url) => this.open(url)))))
        .child(v_flex().gap(3).children(metaRows.map(([k, v]) => this.meta(t, k, v))))
        .child(this.section(t, "Notes", d.notes ? String(notes.length) : null))
        .child(div().text_size(13).text_color(d.errors.notes ? t.blocked : t.dim)
          .when(!d.notes || d.errors.notes || notes.length === 0, (el) => el.child(d.errors.notes ?? (d.notes ? "No notes yet" : "Loading notes…"))))
        .children(notes.map((n, k) => v_flex().gap(4).pl(8).border_l(2).border_color(t.border)
          .child(h_flex().gap(6).text_size(12)
            .child(div().text_color(t.muted).child(n.author?.name ?? "someone"))
            .child(div().text_color(t.dim).child(stamp(n.createdAt))))
          .child(div().text_size(14).text_color(t.foreground)
            .child(TextView.markdown(`note-${d.number}-${k}`, n.content ?? "").selectable(true).on_link_click((url) => this.open(url))))))
        .when(exception, (el) => el
          .child(this.section(t, "Recent samples", d.samples ? String(d.samples.length) : null))
          .when(!d.samples || d.errors.samples || d.samples.length === 0, (c) => c.child(div().text_size(13)
            .text_color(d.errors.samples ? t.blocked : t.dim)
            .child(d.errors.samples ?? (d.samples ? "No samples in the last 24 hours" : "Loading samples…"))))
          .children((d.samples ?? []).map((s, k) => this.renderSample(t, s, k)))));
  }

  // #endregion

  render(_cx) {
    const t = theme();
    return this.detail ? this.renderDetail(t) : this.renderList(t);
  }
}
