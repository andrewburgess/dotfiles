// State every copy of the mod shares (the panel, each space's diff tab, the send dialog),
// and the git reads they both need.
import { spaces, panes, focused, exec, shared, setShared, settings } from "herdr";

/** This mod's folder name, for overlays, tabs and icons. */
export const MOD = "review";
/** Shared key: per-agent turn snapshots `{ [address]: { current, last } }`. */
export const TURNS = "changes.turns";
/** Shared key: per-repo base branch overrides `{ [root]: ref }`. */
export const BASES = "changes.base";
/** Shared key: draft review comments `{ [reviewKey]: Comment[] }`. */
export const DRAFTS = "changes.drafts";
/** Shared key the send dialog sets to the send time once a review went out. */
export const SENT = "changes.reviewSent";
/** Shared key: settings that follow the person to every space and launch. */
export const PREFS = "review.prefs";
/** Shared key: what each space's panel shows `{ [space]: Session }`, read by that space's diff tab. */
export const SESSIONS = "review.sessions";
/** Shared key: open diff tabs `{ [tabId]: { space, cwd, on } }`. */
export const TABS = "review.tabs";
/** Shared key: the latest request to show a file in a diff tab `{ id, at, space, path, comment }`. */
export const OPEN = "review.open";
/** Shared key: the file each space's diff tab shows `{ [space]: path }`. */
export const CURRENT = "review.current";
/** Shared key: files marked reviewed `{ [reviewKey]: { [path]: { sig, at } } }`. */
export const REVIEWED = "review.reviewed";
/** Shared key: reviews sent to an agent `{ [reviewKey]: Round[] }`, newest last. */
export const HISTORY = "review.history";
/** Shared key: the review waiting on the send dialog `{ key, at, round }`. */
export const PENDING = "review.pending";
/** Shared key: the icon each diff tab shows in the tab bar `{ [tabId]: path }`, for the open file's type. */
export const TAB_ICONS = "review.tabIcons";

/** Diff sources the panel can show. */
export const MODES = [
  { id: "worktree", label: "Uncommitted" },
  { id: "base", label: "Branch" },
  { id: "turn", label: "Last turn" },
];

const DEFAULTS = { view: "unified", listing: "flat", hideReviewed: false, whitespace: false, mode: "worktree", collapsed: {} };

/** Settings kept across spaces and restarts: view, listing, hideReviewed, whitespace, mode, collapsed. */
export function prefs() { return { ...DEFAULTS, ...(shared(PREFS) ?? {}) }; }

export function setPref(key, value) { setShared(PREFS, { ...prefs(), [key]: value }); }

/**
 * The app's zoom. Element sizes in a mod are in zoomed units, but mouse positions, element
 * bounds and `on_size_change` report unzoomed window pixels; divide those by this.
 */
export const zoom = () => Number(settings().zoom) || 1;

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

/** Runs a read-only git command in a repo. */
export const git = (root, on, args) => exec("git", [...READ, ...args], { cwd: root, on });

/** Live tab ids in every space. */
export const liveTabs = () => new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));

/**
 * The folder and machine the panel shows. With a diff tab focused, the checkout it is
 * reviewing; else the focused pane's.
 * @returns `{ cwd, on, space }`
 */
export function location() {
  const f = focused(), reg = f?.tab ? (shared(TABS) ?? {})[f.tab] : null;
  if (reg?.cwd) return { cwd: reg.cwd, on: reg.on ?? null, space: reg.space };
  const space = spaces().find((s) => s.active);
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id ?? f?.space ?? null };
}

const LOCKS = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|uv\.lock|go\.sum|Podfile\.lock|flake\.lock|mix\.lock)$/;
const BUILT = /\.(min\.js|min\.css|map|snap)$|(^|\/)(__generated__|generated)\/|\.pb\.(go|ts)$|_pb2\.py$|\.g\.dart$/;

const chunks = (list, n = 300) => Array.from({ length: Math.ceil(list.length / n) }, (_v, i) => list.slice(i * n, i * n + n));

/**
 * Lockfiles and generated files: known names, plus anything `.gitattributes` marks
 * `linguist-generated`.
 * @returns The paths that are generated
 */
export async function generatedPaths(root, on, paths) {
  const out = new Set(paths.filter((p) => LOCKS.test(p) || BUILT.test(p)));
  for (const part of chunks(paths)) {
    const r = await git(root, on, ["check-attr", "-z", "linguist-generated", "--", ...part]).catch(() => null);
    if (r?.code !== 0) continue;
    const f = r.stdout.split("\0");
    for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] === "set" || f[i + 2] === "true") out.add(f[i]);
  }
  return out;
}

/**
 * Each file's content as a blob id, so a reviewed mark can tell when the file changed.
 * Deleted files are "deleted".
 * @param files Changed files `{ path, status }`
 * @param tree The snapshot tree to read instead of the working tree (last-turn mode)
 * @returns `{ [path]: sig }`
 */
export async function signatures(root, on, files, tree = null) {
  const sigs = {}, live = [];
  for (const f of files) if (f.status === "D") sigs[f.path] = "deleted"; else live.push(f.path);
  for (const part of chunks(live)) {
    if (tree) {
      const r = await git(root, on, ["ls-tree", "-r", "-z", tree, "--", ...part]);
      if (r.code !== 0) continue;
      for (const entry of r.stdout.split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab > 0) sigs[entry.slice(tab + 1)] = entry.slice(0, tab).split(" ")[2];
      }
    } else {
      const r = await git(root, on, ["hash-object", "--", ...part]);
      if (r.code !== 0) continue;
      r.stdout.trim().split("\n").forEach((h, i) => { sigs[part[i]] = h; });
    }
  }
  return sigs;
}

/**
 * Stores a file's current content as a blob (so a later diff against it works) and returns its id.
 * @returns The blob id, "deleted", or null when it couldn't be read
 */
export async function storeBlob(session, file) {
  if (file.status === "D") return "deleted";
  if (session.mode === "turn") return file.sig ?? null;
  const r = await exec("git", ["hash-object", "-w", "--", file.path], { cwd: session.root, on: session.on }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : null;
}

/** Whether a file is reviewed: "none", "done", or "changed" (marked, then its content changed). */
export function reviewState(session, file) {
  const mark = (shared(REVIEWED) ?? {})[session?.key]?.[file.path];
  return !mark ? "none" : mark.sig === file.sig ? "done" : "changed";
}

export const reviewMark = (session, path) => (shared(REVIEWED) ?? {})[session?.key]?.[path] ?? null;

/**
 * Marks or unmarks a file as reviewed in a session.
 * @param done True to mark it with its current content, false to clear the mark
 */
export async function setReviewed(session, file, done) {
  const sig = done ? await storeBlob(session, file) : null;
  const all = { ...(shared(REVIEWED) ?? {}) }, marks = { ...(all[session.key] ?? {}) };
  if (done && sig) marks[file.path] = { sig, at: Date.now() }; else delete marks[file.path];
  if (Object.keys(marks).length) all[session.key] = marks; else delete all[session.key];
  const month = Date.now() - 30 * 86400000;
  for (const [k, m] of Object.entries(all)) if (Object.values(m).every((x) => x.at < month)) delete all[k];
  setShared(REVIEWED, all);
}

export const draftsOf = (key) => key ? (shared(DRAFTS) ?? {})[key] ?? [] : [];

export function setDrafts(key, list) {
  if (!key) return;
  const drafts = { ...(shared(DRAFTS) ?? {}) };
  if (list.length) drafts[key] = list; else delete drafts[key];
  setShared(DRAFTS, drafts);
}

export const historyOf = (key) => key ? (shared(HISTORY) ?? {})[key] ?? [] : [];

/** Records a sent review; at most 20 are kept per review key. Sending the same round twice is a no-op. */
export function pushHistory(key, round) {
  const all = { ...(shared(HISTORY) ?? {}) }, list = all[key] ?? [];
  if (list.some((r) => r.id === round.id)) return;
  all[key] = [...list, round].slice(-20);
  setShared(HISTORY, all);
}

/** Hides one sent comment from the diff (it stays in the panel's history). */
export function dismissSent(key, roundId, commentId) {
  const all = { ...(shared(HISTORY) ?? {}) };
  all[key] = (all[key] ?? []).map((r) => r.id !== roundId ? r : { ...r, dismissed: [...new Set([...(r.dismissed ?? []), commentId])] });
  setShared(HISTORY, all);
}

/**
 * Once the send dialog reports the pending review went out, its drafts move to the history.
 * Every copy runs this on render; the round id keeps it from being recorded twice.
 */
export function pendingSent() {
  const pending = shared(PENDING), sentAt = shared(SENT);
  return Boolean(pending) && (Date.now() - pending.at > 3600000 || (typeof sentAt === "number" && sentAt >= pending.at));
}

export function settlePending() {
  const pending = shared(PENDING), sentAt = shared(SENT);
  if (!pending) return;
  if (Date.now() - pending.at > 3600000) { setShared(PENDING, null); return; }
  if (typeof sentAt !== "number" || sentAt < pending.at) return;
  setShared(PENDING, null);
  pushHistory(pending.key, pending.round);
  const sent = new Set(pending.round.comments.map((c) => c.id));
  setDrafts(pending.key, draftsOf(pending.key).filter((c) => !sent.has(c.id)));
}

/** A file's change in words: "added, binary", "modified, +3 −1". */
export function describe(session, path) {
  const f = session?.files.find((f) => f.path === path);
  if (!f) return "no longer changed";
  const what = f.status === "A" ? "added" : f.status === "D" ? "deleted" : f.status === "U" ? "conflict" : "modified";
  return f.binary ? `${what}, binary` : f.add || f.del ? `${what}, +${f.add} −${f.del}` : what;
}

export const where = (session, path) => `${session.root}/${path}${session.on ? ` (on ${session.on})` : ""}`;

/**
 * Every draft comment, with its quoted lines, as one review message.
 * @returns `{ title, context, round }`, where round is what the history keeps once it is sent
 */
export function reviewMessage(session, comments) {
  const list = [...comments].sort((a, b) => a.path.localeCompare(b.path) || (a.from?.number ?? -1) - (b.from?.number ?? -1));
  const parts = list.map((c) => {
    if (c.whole) return `### ${c.path}, whole file (${describe(session, c.path)})\n\nComment: ${c.text}`;
    const span = c.from.number === c.to.number ? `line ${c.from.number}` : `lines ${c.from.number}-${c.to.number}`;
    const body = c.quote ?? `${String(c.from.number).padStart(5)} ${c.from.kind} ${c.from.text}`;
    return `### ${c.path}, ${span}${c.since ? " (in the changes since the last review)" : ""}\n${body}\n\nComment: ${c.text}`;
  });
  const n = list.length, s = n > 1 ? "s" : "";
  const context = `Code review of ${session.root}${session.on ? ` (on ${session.on})` : ""}: ${session.scope?.words ?? "the shown changes"}. ${n} comment${s}. Line numbers are new-file numbers; "-" lines are removed.\n\n${parts.join("\n\n")}`;
  const round = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), comments: list };
  return { title: `Review · ${n} comment${s}`, context, round };
}
