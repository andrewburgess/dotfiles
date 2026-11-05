// Review comments, the send dialog and syntax colors are adapted from herdr-reviewer
// by Vytas Gavelis, MIT License (LICENSE-herdr-reviewer).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, agents, focused, exec, readTextFile, watchFolder, theme, settings, shared, setShared, props, nextCommand, run } from "herdr";
import { tokenize, languageOf } from "./highlight.js";
import { palette } from "./palette.js";
import { ask, pickAgent } from "./ask.js";
import { Dialog } from "./dialog.js";

/** Diff sources the panel can show. */
const MODES = [
  { id: "worktree", label: "Uncommitted" },
  { id: "base", label: "Branch" },
  { id: "turn", label: "Last turn" },
];
/** Shared key: per-agent turn snapshots `{ [address]: { current, last } }`. */
const TURNS = "changes.turns";
/** Shared key: per-repo base branch overrides `{ [root]: ref }`. */
const BASES = "changes.base";
/** Shared key: draft review comments `{ [draftKey]: Comment[] }`, kept across reloads and restarts. */
const DRAFTS = "changes.drafts";
/** Shared key the send dialog sets to the send time once a review went out. */
const SENT = "changes.reviewSent";
/** Shared key: open full review tabs `{ [tabId]: { cwd, on } }`. */
const FULL_TABS = "changes.fullTabs";
/** Tried in order when no PR base is known; the one with the fewest commits ahead of it wins. */
const BASE_CANDIDATES = ["origin/dev", "origin/develop", "origin/main", "origin/master", "origin/staging", "dev", "develop", "main", "master"];

/** Diff text size and row height, px. */
const FONT = 14, ROW = 24;
/** Approximate advance of one monospace character at the diff's text size. */
const CHAR_W = 8.7;
/** Width of the +/− column beside the line numbers. */
const SIGN_W = 16;
/** Width of the full review tab's file sidebar. */
const SIDEBAR = 340;
/** Approximate height of the comment box, for flipping it above the clicked line near the bottom. */
const BOX_H = 200;
/** Shared key: the latest "open in a full tab" request `{ id, at, cwd, on, mode, file, view }`. */
const FULL_OPEN = "changes.fullOpen";
const NONE = "#00000000";
/**
 * The app's zoom. Element sizes in a mod are in zoomed units, but mouse positions, element
 * bounds and `on_size_change` report unzoomed window pixels; divide those by this.
 */
const zoom = () => Number(settings().zoom) || 1;

/** The folder and machine shown: a full review tab's pinned checkout, else the focused pane's. */
function location() {
  const pin = props()?.full ? props() : null;
  if (pin?.cwd) return { cwd: pin.cwd, on: pin.on ?? null };
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// A throwaway index keeps the user's staging area untouched; copying the real one first
// lets `add -A` reuse its stat cache. Includes untracked files, skips ignored ones.
const SNAPSHOT = `idx="\${TMPDIR:-/tmp}/herdr-changes-$$.idx"
cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || rm -f "$idx"
GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git write-tree; rc=$?
rm -f "$idx"; exit $rc`;

/**
 * Records the whole working tree as a git tree object without touching refs or the index.
 * @param {string} cwd Any folder inside the repository
 * @param {string | null} on Machine to run on, null for this one
 * @returns {Promise<{ root: string, tree: string } | null>} null outside a repository or on failure
 */
async function snapshot(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (top.code !== 0) return null;
  const root = top.stdout.trim(), r = await exec("sh", ["-c", SNAPSHOT], { cwd: root, on });
  return r.code === 0 && r.stdout.trim() ? { root, tree: r.stdout.trim() } : null;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

function parseNumstat(stdout, stats = {}) {
  for (const entry of stdout.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
    stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  return stats;
}

function parseNameStatus(stdout) {
  const parts = stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) out.push({ code: parts[i], path: parts[i + 1] });
  return out;
}

const letter = (code) => code[0] === "U" ? "U" : code[0] === "D" ? "D" : code[0] === "A" ? "A" : "M";

/**
 * Numbers and tokenizes each diff line once, so a frame only draws the rows on screen.
 * @param lines Diff lines from the first hunk header on
 * @param lang Tokenizer language from `languageOf`, or null for plain text
 * @returns Rows `{ kind, number, oldNo, newNo, text, hunk, spans }`; `number` is the new-file
 *   line for added and context rows and the old-file line for removed rows
 */
function diffRows(lines, lang) {
  let old = 0, next = 0, state = null, hunk = -1;
  return lines.map((line, i) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; state = null; hunk = i; return { kind: "@", text: line, hunk: i, spans: [{ text: line, cls: "" }] }; }
    const kind = line[0];
    let row;
    if (kind === "-") row = { kind, number: old, oldNo: old++, text: line.slice(1) || " " };
    else if (kind === "+") row = { kind, number: next, newNo: next++, text: line.slice(1) || " " };
    else if (kind === " ") row = { kind, number: next, oldNo: old++, newNo: next++, text: line.slice(1) || " " };
    else row = { kind: "", text: line };
    row.hunk = hunk;
    if (row.kind) { const tk = tokenize(row.text.replace(/\t/g, "    "), lang, state); row.spans = tk.spans; state = tk.state; }
    else row.spans = [{ text: row.text, cls: "" }];
    return row;
  });
}

/**
 * Pairs unified rows into side-by-side rows: context on both sides, each run of removals
 * beside the additions that follow it.
 * @param rows Rows from `diffRows`
 * @returns `{ l, r }` row indexes (null for an empty side), or `{ full }` for rows spanning both sides
 */
function splitPairs(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const kind = rows[i].kind;
    if (kind === "-" || kind === "+") {
      const dels = [], adds = [];
      while (i < rows.length && rows[i].kind === "-") dels.push(i++);
      while (i < rows.length && rows[i].kind === "+") adds.push(i++);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ l: dels[k] ?? null, r: adds[k] ?? null });
      continue;
    }
    out.push(kind === " " ? { l: i, r: i } : { full: i });
    i++;
  }
  return out;
}

/** A row's identity across reloads: its kind, number and text. */
const desc = (r) => ({ kind: r.kind, number: r.number ?? null, text: r.text });
const descKey = (d) => `${d.kind}|${d.number}|${d.text}`;

export default class Changes extends View {
  init(_props, cx) {
    if (props()?.dialog) { this.dialog = Object.create(Dialog.prototype); this.dialog.init(_props, cx); return; }
    this.full = Boolean(props()?.full);
    this.files = []; this.rows = []; this.index = new Map(); this.items = []; this.sizes = []; this.gutter = 30;
    this.diffWidth = 0; this.scrollX = 0; this.diffView = 0; this.width = 0; this.message = ""; this.handle = cx.focus_handle();
    this.statuses = {}; this.detected = {}; this.branches = []; this.filter = "";
    this.comments = []; this.draftsJson = "[]"; this.composer = null; this.noteText = ""; this.press = null; this.shiftHeld = false;
    this.scroll = VirtualListScrollHandle.new();
    this.boxAt = null; this.pendingOpen = null;
    try { this.sidebarOpen = localStorage.getItem("sidebar") !== "closed"; } catch { this.sidebarOpen = true; }
    try { this.mode = MODES.some(m => m.id === localStorage.getItem("mode")) ? localStorage.getItem("mode") : "worktree"; } catch { this.mode = "worktree"; }
    try { this.view = localStorage.getItem("view") ?? (this.full ? "split" : "unified"); } catch { this.view = this.full ? "split" : "unified"; }
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.search = InputState.new({ placeholder: "Filter branches" });
    this.search.on("change", (_e, cx) => { this.filter = this.search.value(); cx.notify(); });
    this.note = TextareaState.new({ placeholder: "Leave a comment on these lines…", rows: 3 });
    this.note.set_auto_grow(3, 12);
    // Enter adds; shift-enter is the textarea's own newline, so its submit is ignored.
    this.note.on("submit", (e, cx) => { if (!e?.shift) this.addComment(cx); });
    this.note.on("change", (_e, cx) => { this.noteText = this.note.value(); if (this.composer?.editing) this.rebuild(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "submit") this.submit(cx);
        else if (c === "ask") this.askAbout(null, cx);
        else if (c === "clear") this.setComments([], cx);
        else if (c === "full") this.openFull(cx);
        else if (c === "view") this.setView(this.view === "split" ? "unified" : "split", cx);
        cx.notify();
      }
    });
  }

  /** Everything the shown list depends on; a change discards in-flight results and reloads. */
  key() {
    return JSON.stringify({ ...location(), mode: this.mode, base: this.mode === "base" ? shared(BASES) ?? null : null, turns: this.mode === "turn" ? shared(TURNS) ?? null : null });
  }

  // #region Turn tracking

  /** Snapshots the tree when an agent starts working and again when it goes idle, so a turn's edits can be diffed later. */
  track(cx) {
    const busy = (s) => s === "working" || s === "blocked";
    for (const agent of agents()) {
      const was = this.statuses[agent.address], now = agent.status;
      this.statuses[agent.address] = now;
      if (was === undefined || was === now) continue;
      if (busy(now) && !busy(was)) this.turnStart(agent, cx);
      else if (!busy(now) && busy(was)) this.turnEnd(agent, cx);
    }
  }

  agentPlace(agent) {
    const cwd = panes().find(p => p.pane === agent.pane)?.cwd;
    const on = agent.address.includes("/") ? agent.address.split("/")[0] : spaces().find(s => s.id === agent.space)?.machine ?? null;
    return { cwd, on };
  }

  updateTurn(address, change) {
    const turns = { ...(shared(TURNS) ?? {}) };
    turns[address] = change({ ...(turns[address] ?? {}) });
    const week = Date.now() - 7 * 86400000;
    for (const [a, rec] of Object.entries(turns)) if ((rec.last?.endedAt ?? 0) < week && (rec.current?.startedAt ?? 0) < week) delete turns[a];
    setShared(TURNS, turns);
  }

  turnStart(agent, cx) {
    const { cwd, on } = this.agentPlace(agent), rec = (shared(TURNS) ?? {})[agent.address];
    // Every copy of this mod sees the same transition; the first one claims it.
    if (!cwd || (rec?.current && Date.now() - rec.current.startedAt < 5000)) return;
    const startedAt = Date.now(), label = [agent.program?.name, agent.tab_name].filter(Boolean).join(" · ");
    this.updateTurn(agent.address, (r) => ({ ...r, current: { startedAt, label, on } }));
    cx.spawn(async () => {
      const snap = await snapshot(cwd, on).catch(() => null);
      this.updateTurn(agent.address, (r) => r.current?.startedAt !== startedAt ? r
        : snap ? { ...r, current: { ...r.current, root: snap.root, start: snap.tree } } : { ...r, current: null });
    });
  }

  turnEnd(agent, cx) {
    const { cwd, on } = this.agentPlace(agent), current = (shared(TURNS) ?? {})[agent.address]?.current;
    if (!cwd || !current?.start || current.ending) return;
    this.updateTurn(agent.address, (r) => ({ ...r, current: { ...r.current, ending: true } }));
    cx.spawn(async () => {
      const snap = await snapshot(cwd, on).catch(() => null);
      this.updateTurn(agent.address, (r) => {
        const same = r.current?.startedAt === current.startedAt;
        const last = snap ? { root: current.root, on, label: current.label, start: current.start, end: snap.tree, startedAt: current.startedAt, endedAt: Date.now() } : r.last;
        return { ...r, last, current: same ? null : r.current };
      });
    });
  }

  /** The finished turn to show for this repo: the focused agent's if it has one here, else the latest. */
  turnFor(root) {
    const turns = shared(TURNS) ?? {}, mine = turns[focused()?.terminal ?? ""];
    if (mine?.last?.root === root) return { turn: mine.last, running: Boolean(mine.current) };
    const last = Object.values(turns).map(r => r.last).filter(t => t?.root === root).sort((a, b) => b.endedAt - a.endedAt)[0];
    return { turn: last ?? null, running: Object.values(turns).some(r => r.current?.root === root) };
  }

  // #endregion

  // #region Base branch

  async detectBase(git, root, on) {
    const branch = (await git(["branch", "--show-current"])).stdout.trim(), cacheKey = `${root}\0${branch}`;
    if (this.detected[cacheKey]) return this.detected[cacheKey];
    const exists = async (ref) => (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;
    let found = null;
    if (branch) {
      const pr = await exec("gh", ["pr", "view", branch, "--json", "baseRefName", "-q", ".baseRefName"], { cwd: root, on }).catch(() => null);
      const name = pr?.code === 0 ? pr.stdout.trim() : "";
      if (name) found = (await exists(`origin/${name}`)) ? `origin/${name}` : (await exists(name)) ? name : null;
    }
    if (!found) {
      const head = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
      let best = null;
      for (const ref of [...new Set([head, ...BASE_CANDIDATES])].filter(r => r && r !== branch && r !== `origin/${branch}`)) {
        const count = await git(["rev-list", "--count", `${ref}..HEAD`]);
        if (count.code === 0 && (best === null || +count.stdout < best.count)) best = { ref, count: +count.stdout };
      }
      found = best?.ref ?? null;
    }
    // On a base branch itself (main, master, dev) every candidate is skipped; compare against
    // its own remote so the panel shows unpushed work instead of nothing.
    if (!found && branch) {
      const upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim();
      found = upstream && (await exists(upstream)) ? upstream : (await exists(`origin/${branch}`)) ? `origin/${branch}` : null;
    }
    if (found) this.detected[cacheKey] = found;
    return found;
  }

  openPicker(cx) {
    this.picking = !this.picking; this.filter = ""; this.search.set_value("");
    if (!this.picking || !this.root) return cx.notify();
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, "for-each-ref", "--format=%(refname:short)", "refs/remotes", "refs/heads"], { cwd: root, on });
      this.branches = r.code === 0 ? r.stdout.split("\n").filter(b => b && !b.endsWith("/HEAD") && b !== "origin") : [];
      cx.notify();
    });
    cx.notify();
  }

  chooseBase(ref, cx) {
    const bases = { ...(shared(BASES) ?? {}) };
    if (ref) bases[this.root] = ref; else delete bases[this.root];
    this.picking = false;
    setShared(BASES, bases);
    cx.notify();
  }

  // #endregion

  setMode(mode, cx) {
    if (mode === this.mode) return;
    this.mode = mode; this.picking = false; this.composer = null;
    try { localStorage.setItem("mode", mode); } catch {}
    this.refresh(cx);
    cx.notify();
  }

  setView(view, cx) {
    if (view === this.view) return;
    this.view = view;
    try { localStorage.setItem("view", view); } catch {}
    this.scrollX = 0; this.rebuild(); cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = this.key(), place = JSON.stringify({ cwd, on });
    if (context !== this.context) {
      if (place !== this.place) { this.message = ""; this.input.set_value(""); this.watched = null; this.picking = false; }
      this.context = context; this.place = place; this.root = null; this.files = []; this.open = null; this.info = null; this.scope = null;
      this.setLines([]); this.error = null; this.note_ = null; this.closed = false; this.limited = false; this.composer = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (this.key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const found = this.mode === "worktree" ? await this.worktreeFiles(git, head.code === 0)
          : this.mode === "base" ? await this.baseFiles(git, root, on, head.code === 0)
          : await this.turnFiles(git, root);
        if (this.key() !== context) return;
        const { files, diffArgs, info, empty, scope } = found;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.diffArgs = diffArgs; this.info = info; this.empty = empty; this.scope = scope;
        this.files = files.slice(0, 1000); this.limited = files.length > 1000; this.error = null;
        this.watch(root, cx);
        this.syncDrafts();
        if (this.pendingOpen) { if (this.files.some((f) => f.path === this.pendingOpen)) { this.open = this.pendingOpen; this.closed = false; } this.pendingOpen = null; }
        if (this.open && !this.files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && this.files.length) this.open = this.files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.key() === context) this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async worktreeFiles(git, hasHead) {
    const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr);
    const stats = {};
    const results = hasHead ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
    for (const result of results) {
      if (result.code !== 0) throw new Error(result.stderr);
      parseNumstat(result.stdout, stats);
    }
    const files = status.stdout.split("\0").filter(Boolean).map((entry) => {
      const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
      const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
      const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
      return { path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) };
    });
    return { files, diffArgs: hasHead ? ["HEAD"] : [], info: null, empty: "No uncommitted changes", scope: { id: "", words: "uncommitted changes" } };
  }

  async baseFiles(git, root, on, hasHead) {
    const none = (text, empty, pick = false) => ({ files: [], diffArgs: [], info: { text, pick }, empty, scope: null });
    if (!hasHead) return none("No commits yet", "No commits yet");
    const chosen = (shared(BASES) ?? {})[root], base = chosen ?? await this.detectBase(git, root, on);
    if (!base) return none("Base: none found", "Pick a base branch to compare against", true);
    const mb = await git(["merge-base", base, "HEAD"]);
    if (mb.code !== 0) return none(`Base: ${base}`, `No common history with ${base}`, true);
    const from = mb.stdout.trim();
    const [num, names, untracked, branch] = await Promise.all([
      git(["diff", from, "--numstat", "-z", "--no-renames"]),
      git(["diff", from, "--name-status", "-z", "--no-renames"]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
      git(["branch", "--show-current"]),
    ]);
    for (const r of [num, names, untracked]) if (r.code !== 0) throw new Error(r.stderr);
    const stats = parseNumstat(num.stdout);
    const files = parseNameStatus(names.stdout).map(({ code, path }) => ({ path, status: letter(code), fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) }))
      .concat(untracked.stdout.split("\0").filter(Boolean).map((path) => ({ path, status: "A", fresh: true, add: 0, del: 0 })));
    const name = branch.stdout.trim() || "HEAD";
    return { files, diffArgs: [from], info: { text: `Base: ${base}${chosen ? "" : " (auto)"}`, pick: true }, empty: `No changes against ${base}`,
      scope: { id: base, words: `all changes on ${name} since it left ${base} (merge base ${from.slice(0, 7)}), committed or not` } };
  }

  async turnFiles(git, root) {
    const { turn, running } = this.turnFor(root);
    const suffix = running ? " · agent working" : "";
    if (!turn) return { files: [], diffArgs: [], info: { text: `No finished agent turn here yet${suffix}` }, empty: "Changes appear after an agent in this repo finishes a turn", scope: null };
    const label = `${turn.label || "Agent"} · ${ago(turn.endedAt)}${suffix}`;
    const [num, names] = await Promise.all([
      git(["diff", turn.start, turn.end, "--numstat", "-z", "--no-renames"]),
      git(["diff", turn.start, turn.end, "--name-status", "-z", "--no-renames"]),
    ]);
    const scope = { id: `${turn.start}..${turn.end}`, words: `the changes made during the last agent turn (${turn.label || "agent"}, ended ${ago(turn.endedAt)})` };
    // Snapshot trees are unreferenced, so `git gc` may eventually prune old ones.
    if (num.code !== 0 || names.code !== 0) return { files: [], diffArgs: [], info: { text: label }, empty: "This turn's snapshot is no longer available", scope };
    const stats = parseNumstat(num.stdout);
    const files = parseNameStatus(names.stdout).map(({ code, path }) => ({ path, status: letter(code), fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) }));
    return { files, diffArgs: [turn.start, turn.end], info: { text: label }, empty: "The last turn changed no files", scope };
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (this.mode === "worktree" && !this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...this.diffArgs, "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line), path);
  }

  setLines(lines, path) {
    const same = this.lines && this.linesPath === path && lines.length === this.lines.length && lines.every((l, i) => l === this.lines[i]);
    if (same) return;
    this.lines = lines; this.linesPath = path;
    this.rows = diffRows(lines, languageOf(path));
    this.index = new Map();
    this.rows.forEach((r, i) => { const k = descKey(desc(r)); if (!this.index.has(k)) this.index.set(k, i); });
    const digits = String(Math.max(0, ...this.rows.map((r) => Math.max(r.oldNo ?? 0, r.newNo ?? 0)))).length;
    this.gutter = Math.max(30, Math.ceil(digits * CHAR_W + 10));
    this.diffWidth = Math.max(0, ...lines.map((line) => line.replace(/\t/g, "    ").length)) * CHAR_W + 24;
    this.scrollX = 0;
    this.rebuild();
  }

  // #region Horizontal scrolling

  /** Width of the line-number and sign columns, which stay put while the text scrolls sideways. */
  lead() { return this.gutter + SIGN_W + 2; }

  /** Width of the text area beside the gutter: one side of the split view, or the whole row. */
  visible() { return this.view === "split" ? (this.diffView - 1) / 2 - this.lead() : this.diffView - this.lead(); }

  maxScrollX() { return Math.max(0, this.diffWidth - this.visible()); }

  /** The horizontal bar's geometry: track width, thumb width and the thumb's offset in the track. */
  thumb() {
    const track = Math.max(0, this.diffView - this.lead()), max = this.maxScrollX();
    const thumb = Math.min(track, Math.max(24, track * this.visible() / this.diffWidth));
    return { track, thumb, left: max ? (this.scrollX / max) * (track - thumb) : 0 };
  }

  /** A press on the bar: off the thumb it jumps there first, then dragging moves the text with the pointer. */
  startDrag(e, cx) {
    cx.stop_propagation();
    const { track, thumb, left } = this.thumb(), x = e.local_position ? e.local_position.x / zoom() : undefined;
    if (x !== undefined && (x < left || x > left + thumb) && track > thumb) {
      this.scrollX = Math.min(1, Math.max(0, (x - thumb / 2) / (track - thumb))) * this.maxScrollX();
    }
    this.dragging = { x: e.position.x, scroll: this.scrollX };
    cx.notify();
  }

  drag(e, cx) {
    if (!this.dragging) return;
    const { track, thumb } = this.thumb();
    if (track <= thumb) return;
    const moved = (e.position.x - this.dragging.x) / zoom() * this.maxScrollX() / (track - thumb);
    this.scrollX = Math.min(this.maxScrollX(), Math.max(0, this.dragging.scroll + moved));
    cx.notify();
  }

  endDrag(cx) {
    if (!this.dragging) return;
    this.dragging = null;
    cx.notify();
  }

  /**
   * Scrolls the diff text sideways. The virtual list only scrolls vertically and keeps its
   * rows at its own width, so the panel offsets the text itself.
   */
  scrollDiff(e, cx) {
    const { x, y } = e.delta;
    const dx = e.modifiers.shift && x === 0 ? y : Math.abs(x) >= Math.abs(y) ? x : 0;
    if (!dx) return;
    cx.stop_propagation();
    const next = Math.min(this.maxScrollX(), Math.max(0, this.scrollX - dx));
    if (next === this.scrollX) return;
    this.scrollX = next;
    cx.notify();
  }

  // #endregion

  // #region Review comments

  /** Drafts are kept per machine, repo, mode and what the mode compares (base ref, turn). */
  draftKey() { return this.root && this.scope ? `${this.on ?? ""}:${this.root}:${this.mode}:${this.scope.id}` : null; }

  /** Picks up drafts saved by another copy of the panel (the sidebar and a full tab share them). */
  syncDrafts() {
    const k = this.draftKey(), list = k ? (shared(DRAFTS) ?? {})[k] ?? [] : [], json = JSON.stringify(list);
    if (json === this.draftsJson) return;
    this.draftsJson = json; this.comments = list;
    if (this.composer?.editing && !list.some((c) => c.id === this.composer.editing)) this.composer = null;
    this.rebuild();
  }

  setComments(list, cx) {
    const k = this.draftKey();
    if (!k) return;
    this.comments = list; this.draftsJson = JSON.stringify(list); this.rebuild();
    const drafts = { ...(shared(DRAFTS) ?? {}) };
    if (list.length) drafts[k] = list; else delete drafts[k];
    setShared(DRAFTS, drafts);
    cx?.notify();
  }

  /** Where a row descriptor is in the open diff, or -1. */
  at(d) { return d ? (this.index.get(descKey(d)) ?? -1) : -1; }

  /**
   * The list's items: diff rows (or side-by-side pairs), with each comment under its last
   * line; whole-file comments come first. The comment being edited previews what is typed.
   */
  rebuild() {
    const base = this.view === "split"
      ? splitPairs(this.rows).map((p, j) => p.full !== undefined
        ? { key: `r:${p.full}`, kind: "row", i: p.full, rows: [p.full] }
        : { key: `p:${j}`, kind: "pair", l: p.l, r: p.r, rows: [p.l, p.r].filter((x) => x !== null) })
      : this.rows.map((_r, i) => ({ key: `r:${i}`, kind: "row", i, rows: [i] }));
    const pos = new Map();
    base.forEach((it, j) => it.rows.forEach((r) => pos.set(r, j)));
    const under = new Map(), top = [], editing = this.composer?.editing ?? null;
    for (const c of this.comments) {
      if (c.path !== this.open) continue;
      const live = c.id === editing, text = live ? this.noteText : c.text;
      const it = { key: `c:${c.id}`, kind: "comment", id: c.id, live, text, height: this.commentHeight(text) };
      if (c.whole) { top.push({ ...it, whole: true }); continue; }
      const from = this.at(c.from), to = this.at(c.to);
      if (from < 0 || to < 0 || to < from) continue;
      const j = Math.max(pos.get(from) ?? -1, pos.get(to) ?? -1);
      if (j < 0) continue;
      (under.get(j) ?? under.set(j, []).get(j)).push({ ...it, from, to });
    }
    this.items = [...top];
    base.forEach((it, j) => { this.items.push({ ...it, height: ROW }); for (const c of under.get(j) ?? []) this.items.push(c); });
    this.sizes = this.items.map((it) => it.height);
  }

  commentHeight(text) {
    const cpl = Math.max(24, Math.floor(((this.diffView || 366) - this.lead() - 48) / CHAR_W));
    const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0);
    return 44 + lines * 20;
  }

  /** The comment box's target rows in the open diff, or null (also for a whole-file comment). */
  target() {
    if (!this.composer || this.composer.whole || this.composer.path !== this.open) return null;
    const from = this.at(this.composer.from), to = this.at(this.composer.to);
    return from < 0 || to < 0 ? null : { from: Math.min(from, to), to: Math.max(from, to) };
  }

  /** A click on a list item; the press before it says which split side and whether shift was held. */
  clickItem(k, cx) {
    const press = this.press;
    this.press = null;
    // The box opens beside where the click landed; the list's scroll offset can't be read.
    this.boxAt = press?.y !== undefined ? { y: press.y, h: press.h } : null;
    if (k.startsWith("c:")) { if (k.slice(2) !== this.composer?.editing) this.editComment(k.slice(2), cx); return; }
    let i;
    if (k.startsWith("p:")) {
      const it = this.items.find((x) => x.key === k);
      if (!it) return;
      const left = press ? press.x < this.diffView / 2 : false;
      i = left ? it.l ?? it.r : it.r ?? it.l;
    } else i = Number(k.slice(2));
    this.clickRow(i, Boolean(press?.shift || this.shiftHeld), cx);
  }

  /**
   * Targets a line (or a hunk header's whole hunk) with the comment box. Shift extends the
   * current selection to it; a plain click on the selection that is already there clears it.
   */
  clickRow(i, extend, cx) {
    const row = this.rows[i];
    if (!row || row.kind === "") return;
    let from = i, to = i;
    if (row.kind === "@") {
      const members = this.rows.map((_r, j) => j).filter((j) => j !== i && this.rows[j].hunk === i && this.rows[j].kind !== "");
      if (!members.length) return;
      from = members[0]; to = members[members.length - 1];
    }
    const t = this.target();
    if (extend && t) { from = Math.min(t.from, from); to = Math.max(t.to, to); }
    else if (t && from === t.from && to === t.to && !this.composer.editing && !this.noteText.trim()) { this.closeComposer(cx); return; }
    // Editing a line comment keeps its identity when retargeted; a whole-file comment stays what it is.
    const editing = this.composer?.editing && !this.composer.whole && this.composer.path === this.open ? this.composer.editing : null;
    this.composer = { path: this.open, from: desc(this.rows[from]), to: desc(this.rows[to]), editing };
    this.openBox(cx);
  }

  // The list is not scrolled when the box opens: what was clicked is on screen already,
  // and a scroll would make the rows jump. Only a whole-file comment scrolls to the top.
  openBox(cx, scrollTo = -1) {
    this.rebuild();
    this.note.focus();
    if (scrollTo >= 0) this.scroll.scroll_to_item(scrollTo);
    cx.timer.after(300, () => this.note.focus());
    cx.notify();
  }

  /** Comments on a file as a whole (an image, a deleted file, anything without lines to click). */
  commentFile(path, cx) {
    if (this.composer?.whole && this.composer.path === path && !this.composer.editing && !this.noteText.trim()) { this.closeComposer(cx); return; }
    if (this.open !== path) this.pick(path, cx);
    this.composer = { path, whole: true, editing: null }; this.boxAt = null;
    this.openBox(cx, 0);
  }

  editComment(id, cx) {
    const c = this.comments.find((c) => c.id === id);
    if (!c) return;
    this.composer = c.whole ? { path: c.path, whole: true, editing: id } : { path: c.path, from: c.from, to: c.to, editing: id };
    this.note.set_value(c.text); this.noteText = c.text;
    this.openBox(cx);
  }

  closeComposer(cx) {
    this.composer = null; this.note.set_value(""); this.noteText = ""; this.rebuild(); this.handle.focus(); cx.notify();
  }

  addComment(cx) {
    const text = this.note.value().trim(), c = this.composer;
    if (!c || !text) return;
    const list = this.comments.filter((x) => x.id !== c.editing);
    const id = c.editing ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const comment = c.whole ? { id, path: c.path, whole: true, text } : { id, path: c.path, from: c.from, to: c.to, text };
    const t = this.target();
    // The quoted lines go with the comment, so it is still sent with what was reviewed after the code moves.
    if (t) { comment.from = desc(this.rows[t.from]); comment.to = desc(this.rows[t.to]); comment.quote = this.quote(this.rows.slice(t.from, Math.min(t.to, t.from + 60) + 1)); }
    else if (c.editing) { const old = this.comments.find((x) => x.id === c.editing); if (old?.quote) comment.quote = old.quote; }
    list.push(comment);
    this.setComments(list);
    this.closeComposer(cx);
  }

  deleteComment(cx) {
    const id = this.composer?.editing;
    if (id) this.setComments(this.comments.filter((c) => c.id !== id));
    this.closeComposer(cx);
  }

  /** The text the agent gets for a set of rows. */
  quote(rows) {
    return rows.map((r) => r.kind === "@" ? r.text : `${r.number === undefined ? "" : String(r.number).padStart(5)} ${r.kind || " "} ${r.text}`).join("\n");
  }

  span(rows) {
    const nums = rows.filter((r) => r.number !== undefined && r.kind !== "-").map((r) => r.number), olds = rows.filter((r) => r.kind === "-").map((r) => r.number);
    const range = (a) => a.length > 1 ? `lines ${Math.min(...a)}-${Math.max(...a)}` : `line ${a[0]}`;
    return nums.length ? range(nums) : olds.length ? `removed ${range(olds)}` : "";
  }

  where(path) { return `${this.root}/${path}${this.on ? ` (on ${this.on})` : ""}`; }

  /** A file's change in words, for a whole-file comment: "added, binary". */
  describe(path) {
    const f = this.files.find((f) => f.path === path);
    if (!f) return "no longer changed";
    const what = f.status === "A" ? "added" : f.status === "D" ? "deleted" : f.status === "U" ? "conflict" : "modified";
    return f.binary ? `${what}, binary` : f.add || f.del ? `${what}, +${f.add} −${f.del}` : what;
  }

  /** The agent to send to by default: the one a full tab was opened from, else the space's. */
  agent() { return props()?.agent ?? pickAgent()?.address ?? null; }

  askAbout(indexes, cx) {
    if (!this.open || !this.rows.length) return;
    const rows = (indexes ? [...indexes].sort((a, b) => a - b).map((i) => this.rows[i]) : this.rows).filter(Boolean).slice(0, 400);
    const span = this.span(rows), title = `${this.open}${span ? `:${span.replace(/^(removed )?lines? /, "")}` : ""}`;
    const words = this.scope?.words ?? "the shown changes";
    const head = indexes ? `In ${this.where(this.open)}, ${span || "these lines"} of the diff (${words}; new-file line numbers; - lines are removed):` : `The diff of ${this.where(this.open)} (${words}):`;
    ask({ title, context: `${head}\n${this.quote(rows)}`, agent: this.agent() });
    cx.notify();
  }

  /** Every comment, with its lines, as one review message. */
  submit(cx) {
    if (!this.comments.length || !this.root) return;
    const list = [...this.comments].sort((a, b) => a.path.localeCompare(b.path) || (a.from?.number ?? -1) - (b.from?.number ?? -1));
    const parts = list.map((c) => {
      if (c.whole) return `### ${c.path}, whole file (${this.describe(c.path)})\n\nComment: ${c.text}`;
      let body = null;
      if (c.path === this.open) {
        const from = this.at(c.from), to = this.at(c.to);
        body = from >= 0 && to >= from ? this.quote(this.rows.slice(from, to + 1)) : null;
      }
      const span = c.from.number === c.to.number ? `line ${c.from.number}` : `lines ${c.from.number}-${c.to.number}`;
      body ??= c.quote ?? `${String(c.from.number).padStart(5)} ${c.from.kind} ${c.from.text}`;
      return `### ${c.path}, ${span}\n${body}\n\nComment: ${c.text}`;
    });
    const n = list.length, s = n > 1 ? "s" : "";
    const context = `Code review of ${this.root}${this.on ? ` (on ${this.on})` : ""}: ${this.scope?.words ?? "the shown changes"}. ${n} comment${s}. Line numbers are new-file numbers; "-" lines are removed.\n\n${parts.join("\n\n")}`;
    this.submitting = Date.now();
    if (ask({ title: `Review · ${n} comment${s}`, context, sent: SENT, agent: this.agent() }) === "none") this.submitting = null;
    cx.notify();
  }

  // #endregion

  /** Opens (or returns to) a full review tab pinned to this checkout and the agent beside it. */
  openFull(cx) {
    if (!this.root || this.full) return;
    const root = this.root, on = this.on ?? null;
    setShared(FULL_OPEN, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), cwd: root, on, mode: this.mode, file: this.open, view: this.view });
    const live = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
    const tabs = shared(FULL_TABS) ?? {};
    const existing = Object.entries(tabs).find(([id, v]) => live.has(id) && v.cwd === root && (v.on ?? null) === on);
    if (existing) { run("tab.select", { id: existing[0] }); return; }
    const args = { name: `Review · ${root.split("/").pop()}`, space: focused()?.space, mod: "my-changes", props: { full: true, cwd: root, on, agent: pickAgent()?.address ?? null } };
    cx.spawn(async (cx) => {
      const r = await exec("herdr-app", ["do", "tab.new", JSON.stringify(args)]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      let made = null;
      try { made = JSON.parse(r.stdout); } catch {}
      if (r.code !== 0 || !made?.tab) { this.note_ = `Couldn't open a review tab: ${made?.error ?? r.stderr.trim()}`; cx.notify(); return; }
      const next = Object.fromEntries(Object.entries(shared(FULL_TABS) ?? {}).filter(([id]) => live.has(id)));
      next[made.tab] = { cwd: root, on };
      setShared(FULL_TABS, next);
    });
  }

  /**
   * A full tab takes the mode, file and view of the panel that opened it. Requests older than
   * 30 s are ignored, so a restart doesn't replay one.
   */
  applyOpenRequest(cx) {
    const req = shared(FULL_OPEN), here = location();
    if (!this.full || !req || req.id === this.appliedOpen || Date.now() - (req.at ?? 0) > 30000 || req.cwd !== here.cwd || (req.on ?? null) !== (here.on ?? null)) return;
    this.appliedOpen = req.id;
    if (req.view && req.view !== this.view) { this.view = req.view; try { localStorage.setItem("view", req.view); } catch {} this.scrollX = 0; this.rebuild(); }
    if (req.mode && req.mode !== this.mode && MODES.some((m) => m.id === req.mode)) { this.mode = req.mode; this.composer = null; try { localStorage.setItem("mode", req.mode); } catch {} }
    if (!req.file) return;
    if (this.key() === this.context && this.files.some((f) => f.path === req.file)) { if (this.open !== req.file) cx.timer.after(1, (cx) => this.pick(req.file, cx)); }
    else this.pendingOpen = req.file;
  }

  /** The diff's width: the panel, less the full tab's file sidebar when it is open. */
  layoutDiff() {
    this.diffView = Math.max(0, this.width - 2 - (this.full && this.sidebarOpen ? SIDEBAR + 1 : 0));
    this.scrollX = Math.min(this.scrollX, this.maxScrollX());
  }

  toggleSidebar(cx) {
    this.sidebarOpen = !this.sidebarOpen;
    try { localStorage.setItem("sidebar", this.sidebarOpen ? "open" : "closed"); } catch {}
    this.layoutDiff(); this.rebuild(); cx.notify();
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note_ = null;
    this.closed = !this.open;
    if (this.composer && !this.composer.whole && this.composer.path !== this.open && !this.noteText.trim()) this.composer = null;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.key() === context && this.open === path) this.note_ = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (this.mode !== "worktree" || !this.message.trim() || !this.root || this.busy || this.loading || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note_ = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (this.key() === context) this.note_ = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // #region Diff rows

  /** One side of a diff line: gutter, sign, and the syntax-colored text shifted by the sideways scroll. */
  line(i, side, t, colors, target, commented) {
    if (i === null) return div().flex_1().min_w(0).h_full().bg(t.raised + "55");
    const r = this.rows[i], on = Boolean(target) && i >= target.from && i <= target.to, mark = commented.has(i);
    if (r.kind === "") return h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().pl(this.lead()).text_color(t.dim).child(div().flex_none().whitespace_nowrap().child(r.text));
    const tint = r.kind === "+" ? colors.added : r.kind === "-" ? colors.removed : null;
    const number = side === "l" ? r.oldNo : side === "r" ? r.newNo : r.number;
    const text = h_flex().flex_none().relative().left(-this.scrollX).whitespace_nowrap()
      .children(r.spans.map((s) => s.cls ? div().text_color(colors[s.cls] ?? t.foreground).child(s.text) : div().child(s.text)));
    return h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().border_l(2).border_color(on ? t.accent : mark ? t.accent + "66" : NONE)
      .when(Boolean(tint), (e) => e.bg(tint + (on ? "5c" : "30")))
      .when(!tint && on, (e) => e.bg(t.selected))
      .child(div().w(this.gutter).h_full().flex().items_center().justify_end().flex_none().pr(4).when(Boolean(tint), (e) => e.bg(tint + "26"))
        .text_color(on ? t.foreground : tint ? t.foreground + "cc" : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(SIGN_W).flex_none().text_center().font_bold().text_color(tint ?? NONE).child(r.kind === "+" ? "+" : r.kind === "-" ? "−" : " "))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().child(text));
  }

  item(it, t, colors, target, commented) {
    if (it.kind === "comment") {
      const span = it.whole ? "whole file" : it.from === it.to ? `line ${this.rows[it.from].number}` : `lines ${this.rows[it.from].number}–${this.rows[it.to].number}`;
      return div().w_full().h(it.height).flex_none().pl(this.lead()).pr(12).py(4).cursor_pointer()
        .child(v_flex().rounded(8).border_1().border_color(it.live ? t.accent : t.accent + "66").bg(t.surface).px(10).py(6).gap(3)
          .child(div().text_size(12).text_color(it.live ? t.accent : t.dim).child(it.live ? `Comment · ${span} · editing` : `Comment · ${span} · click to edit`))
          .child(div().text_size(FONT).whitespace_normal().text_color(it.text ? t.foreground : t.dim).child(it.text || "(empty)")));
    }
    if (it.kind === "pair") {
      return h_flex().w_full().h(ROW).flex_none().cursor_pointer()
        .child(this.line(it.l, "l", t, colors, target, commented))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(this.line(it.r, "r", t, colors, target, commented));
    }
    const r = this.rows[it.i];
    if (r.kind === "@") {
      const on = Boolean(target) && it.i >= target.from - 1 && it.i <= target.to && this.rows[target.from]?.hunk === it.i && this.rows[target.to]?.hunk === it.i;
      return h_flex().w_full().h(ROW).flex_none().items_center().overflow_hidden().cursor_pointer().bg(t.raised).border_l(2).border_color(on ? t.accent : NONE)
        .child(div().w(this.lead() - 2).flex_none())
        .child(h_flex().flex_1().min_w(0).overflow_hidden().child(div().flex_none().relative().left(-this.scrollX).whitespace_nowrap().text_color(t.dim).child(r.text)));
    }
    return h_flex().w_full().h(ROW).flex_none().cursor_pointer().child(this.line(it.i, "u", t, colors, target, commented));
  }

  // #endregion

  // #region Chrome

  /** The comment box: a card floating just under the clicked line (above it near the bottom), centered. */
  box(t, target) {
    const c = this.composer, editing = Boolean(c.editing);
    const where = c.whole ? `whole file (${this.describe(c.path)})` : target ? (target.from === target.to ? `line ${this.rows[target.from].number ?? ""}` : `lines ${this.rows[target.from].number}–${this.rows[target.to].number}`) : "those lines are no longer in the diff";
    // Every press inside the box stops here: the box floats over the list, and a click that
    // fell through to the row underneath would reopen the box the moment Add closed it.
    const stop = (action) => (e, cx) => { cx.stop_propagation(); action(e, cx); };
    const button = (id, label, action) => div().id(id).h(28).px(12).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(13).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(stop(action)).child(label);
    const link = (id, label, color, action) => div().id(id).h(28).px(8).flex().items_center().rounded(6).text_size(13).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(stop(action)).child(label);
    const existing = editing ? this.comments.find((x) => x.id === c.editing) : null;
    const w = Math.min(560, Math.max(240, this.diffView - 24)), left = Math.max(8, (this.diffView - w) / 2), at = this.boxAt;
    // The box can't be measured, so its height is estimated (textarea growth, wrapped buttons).
    // Above the line it is pinned by its bottom edge, so the estimate only decides the side.
    const typed = Math.min(12, Math.max(3, this.noteText.split("\n").length)) - 3;
    const est = BOX_H + typed * 20 + (w < 420 ? 34 : 0);
    let place = { top: 12 };
    if (at?.y !== undefined) {
      const below = at.y + ROW / 2 + 6, aboveEdge = at.y - ROW / 2 - 6;
      if (!at.h || below + est <= at.h) place = { top: below };
      else if (aboveEdge - est >= 8) place = { bottom: at.h - aboveEdge };
      else place = { top: Math.max(8, at.h - est - 8) };
    }
    return v_flex().id("comment-box").flex_none().gap(8).p(10).text_size(14)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation())
      .absolute().when(place.top !== undefined, (e) => e.top(place.top)).when(place.bottom !== undefined, (e) => e.bottom(place.bottom))
      .left(left).w(w).rounded(10).border_1().border_color(t.accent).bg(t.surface).shadow_lg()
      .child(h_flex().items_center().gap(6)
        .child(div().font_semibold().child(editing ? "Edit comment" : "Comment"))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.dim).child(`${c.path.split("/").pop()} · ${where}`))
        .child(div().id("comment-close").size(22).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(stop((_e, cx) => this.closeComposer(cx))).child("×")))
      .child(div().w_full().child(Textarea.new(this.note).w_full().px(8).py(6).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(14).text_color(t.foreground)))
      .child(h_flex().items_center().gap(6).flex_wrap()
        .child(button("comment-add", editing ? "Save" : "Add comment", (_e, cx) => this.addComment(cx)))
        .child(link("comment-cancel", "Cancel", t.dim, (_e, cx) => this.closeComposer(cx)))
        .when(Boolean(existing), (e) => e.child(link("comment-copy", "Copy", t.dim, (_e, cx) => { cx.write_to_clipboard(existing.text); })))
        .child(div().flex_1())
        .when(editing, (e) => e.child(link("comment-delete", "Delete", t.ansi1, (_e, cx) => this.deleteComment(cx))))
        .when(!editing && !c.whole, (e) => e.child(div().text_size(12).text_color(t.dim).child("shift-click extends"))));
  }

  modeTabs(t) {
    return h_flex().flex_none().mx(10).mt(8).p(2).gap(2).rounded(8).bg(t.raised).children(MODES.map((m) =>
      div().id(`mode-${m.id}`).flex_1().h(26).flex().items_center().justify_center().rounded(6).text_size(14).cursor_pointer()
        .when(this.mode === m.id, (e) => e.bg(t.background).text_color(t.foreground))
        .when(this.mode !== m.id, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .on_click((_e, cx) => this.setMode(m.id, cx)).child(m.label)));
  }

  infoLine(t) {
    const row = h_flex().id("changes-info").flex_none().mx(10).mt(6).h(26).px(8).gap(6).items_center().rounded(6).text_size(13).text_color(t.muted)
      .child(div().flex_1().min_w(0).truncate().child(this.info.text));
    return this.info.pick
      ? row.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openPicker(cx)).child(div().text_color(t.dim).child(this.picking ? "▴" : "▾"))
      : row;
  }

  picker(t) {
    const q = this.filter.trim().toLowerCase(), matches = this.branches.filter(b => b.toLowerCase().includes(q)).slice(0, 200);
    const chosen = (shared(BASES) ?? {})[this.root];
    const item = (id, label, ref, active) => div().id(id).h(28).flex_none().px(8).flex().items_center().rounded(6).cursor_pointer().truncate()
      .when(active, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.chooseBase(ref, cx)).child(label);
    return v_flex().flex_none().mx(10).mt(4).p(6).gap(4).rounded(8).border_1().border_color(t.border).bg(t.popover ?? t.raised).text_size(14)
      .child(div().id("base-filter").h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.input ?? t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(14).text_color(t.foreground)))
      .child(v_flex().id("base-list").max_h(220).overflow_y_scrollbar()
        .child(item("base-auto", "Auto-detect", null, !chosen))
        .children(matches.map((b) => item(`base-${b}`, b, b, chosen === b))));
  }

  /** Above the diff: unified/split toggle, then Submit review (with drafts) or Ask about diff. */
  toolbar(t) {
    const n = this.comments.length, canAsk = Boolean(this.open && this.rows.length);
    const seg = (id, label) => div().id(`view-${id}`).h(24).px(10).flex().items_center().rounded(5).text_size(13).cursor_pointer()
      .when(this.view === id, (e) => e.bg(t.background).text_color(t.foreground))
      .when(this.view !== id, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => this.setView(id, cx)).child(label);
    const button = (id, label, primary, action) => div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(6).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(13).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(label);
    return h_flex().flex_none().h(38).px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.raised).child(seg("unified", "Unified")).child(seg("split", "Split")))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.dim).child(this.full ? this.open ?? "" : ""))
      .when(n > 0, (e) => e
        .child(div().id("review-discard").h(26).px(8).flex().items_center().rounded(6).text_size(13).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.setComments([], cx)).child("Discard"))
        .child(button("review-submit", `Submit review · ${n}`, true, (_e, cx) => this.submit(cx))))
      .when(n === 0 && canAsk, (e) => e.child(button("ask", "Ask about diff", false, (_e, cx) => this.askAbout(null, cx))));
  }

  // #endregion

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    this.track(cx);
    this.applyOpenRequest(cx);
    if (this.key() !== this.context) this.refresh(cx);
    this.syncDrafts();
    // The dialog reports a sent review through a shared key; the drafts go.
    const sentAt = shared(SENT);
    if (this.submitting && typeof sentAt === "number" && sentAt >= this.submitting) { this.submitting = null; cx.timer.after(1, (cx) => this.setComments([], cx)); }
    const t = theme(), colors = palette("theme", t), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const target = this.target();
    const commented = new Set();
    for (const it of this.items) if (it.kind === "comment" && !it.whole) for (let j = it.from; j <= it.to; j++) commented.add(j);
    const perFile = {};
    for (const c of this.comments) perFile[c.path] = (perFile[c.path] ?? 0) + 1;
    const title = this.full ? `Review · ${(this.root ?? location().cwd ?? "").split("/").pop()}` : "Changes";
    const chip = (id, label, action) => div().id(id).h(26).px(8).flex().flex_none().items_center().rounded(6).text_size(13).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(label);

    const header = h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(this.full, (e) => e.child(chip("toggle-sidebar", this.sidebarOpen ? "◀ Files" : "▶ Files", (_e, cx) => this.toggleSidebar(cx))))
      .child(div().font_semibold().child(title))
      .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(`${this.files.length} files`))
      .child(div().flex_1()).child(div().text_size(13).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(13).text_color(t.ansi1).child(`−${del}`))
      .when(!this.full && Boolean(this.root), (e) => e.child(chip("open-full", "↗ Full", (_e, cx) => this.openFull(cx))));

    const fileList = (fill) => v_flex().id("changes-list").mt(6).overflow_y_scrollbar().p(6).border_t(1).border_color(t.border)
      .when(fill, (e) => e.flex_1().min_h(0))
      .when(!fill, (e) => e.flex_none().h(Math.min(200, Math.max(44, this.files.length * 30 + 12))).border_b(1))
      .children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop(), k = perFile[f.path];
        return h_flex().id(`change-${f.path}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(13).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          // One speech bubble per file: the draft count when there are drafts; a click comments on the whole file.
          .child(h_flex().id(`comment-file-${f.path}`).h(20).min_w(20).px(k ? 5 : 0).gap(3).flex_none().items_center().justify_center().rounded(4).cursor_pointer()
            .when(Boolean(k), (e) => e.bg(t.accent + "33").text_size(12).text_color(t.foreground))
            .when(!k, (e) => e.text_color(t.muted))
            .hover((s) => s.bg(k ? t.accent + "55" : t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.commentFile(f.path, cx); })
            .when(Boolean(k), (e) => e.child(String(k))).child(svg("mods/my-changes/comment.svg").size(k ? 11 : 13)))
          .when(f.add > 0, (e) => e.child(div().text_size(13).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(13).text_color(t.ansi1).child(`−${f.del}`)));
      }))
      .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? this.empty : "No folder"))));

    const controls = [
      this.modeTabs(t),
      this.info ? this.infoLine(t) : null,
      this.picking && this.root ? this.picker(t) : null,
      fileList(this.full),
      this.limited ? div().px(12).py(4).text_size(13).text_color(t.dim).child("Showing the first 1,000 changed files") : null,
    ].filter(Boolean);

    const diffArea = div().id("changes-diff-area").flex_1().min_h(0).relative().overflow_hidden().font_family(settings().font_family ?? "JetBrains Mono").text_size(FONT)
      .on_scroll_wheel((e, cx) => this.scrollDiff(e, cx))
      .on_mouse_down("left", (e) => {
        const z = zoom(), l = e.local_position;
        this.press = { x: (l?.x ?? 0) / z, y: l ? l.y / z : undefined, h: e.bounds ? e.bounds.height / z : undefined, shift: e.modifiers.shift };
      })
      .child(v_virtual_list("changes-diff", this.items.length, this.sizes.length ? this.sizes : ROW, (i) => this.items[i].key,
        (range) => this.items.slice(range.start, range.end).map((it) => this.item(it, t, colors, target, commented))).size_full().track_scroll(this.scroll)
        .on_item_click((k, cx) => this.clickItem(k, cx))
        .on_item_secondary_click((k, _e, cx) => {
          if (!k.startsWith("r:") && !k.startsWith("p:")) return;
          const it = this.items.find((x) => x.key === k), i = it?.kind === "pair" ? it.r ?? it.l : it?.i, r = this.rows[i];
          if (!r || r.kind === "") return;
          this.askAbout(r.kind === "@" ? this.rows.map((_r, j) => j).filter((j) => this.rows[j].hunk === i && this.rows[j].kind !== "") : [i], cx);
        }))
      .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
      .when(this.maxScrollX() > 0, (e) => {
        const { track, thumb, left } = this.thumb();
        const active = Boolean(this.dragging);
        return e.child(div().id("changes-diff-hbar").absolute().bottom(0).left(this.lead()).w(track).h(12).cursor_pointer()
          .on_mouse_down("left", (ev, cx) => this.startDrag(ev, cx))
          .child(div().absolute().bottom(3).h(active ? 6 : 4).rounded(3).bg(active ? t.muted : t.dim).opacity(active ? 0.8 : 0.5).left(left).w(thumb)));
      })
      .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes")))
      .when(Boolean(this.open && this.rows.length) && !this.composer && this.comments.length === 0, (e) => e.child(div().absolute().bottom(16).right(14).px(8).py(3).rounded(6).bg(t.raised + "e0").text_size(12).text_color(t.dim).child("Click a line to comment · right-click to ask")))
      .when(Boolean(this.composer), (e) => e.child(this.box(t, target)));

    const review = [
      this.root && (this.open || this.comments.length > 0) ? this.toolbar(t) : null,
      diffArea,
      this.note_ ? div().px(10).pb(8).text_size(13).text_color(t.ansi1).child(this.note_) : null,
      this.mode === "worktree" ? h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(34).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(14).text_color(t.foreground)))
        .child(div().id("commit").h(34).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(14).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")) : null,
    ].filter(Boolean);

    const body = this.full
      ? [h_flex().flex_1().min_h(0)
        .when(this.sidebarOpen, (e) => e.child(v_flex().w(SIDEBAR).flex_none().h_full().min_h(0).border_r(1).border_color(t.border).children(controls)))
        .child(v_flex().flex_1().min_w(0).h_full().min_h(0).children(review))]
      : [...controls, ...review];

    // Mouse moves arrive only while the pointer is over the panel, so leaving it ends a drag.
    return v_flex().id("changes")
      .on_mouse_move((e, cx) => this.drag(e, cx)).on_mouse_up("left", (_e, cx) => this.endDrag(cx)).on_hover((over, cx) => { if (!over) this.endDrag(cx); })
      .on_modifiers_changed((e) => { this.shiftHeld = e.modifiers.shift; })
      .on_size_change((size, cx) => {
        const width = size.width / zoom(), resized = width !== this.width;
        this.width = width; this.layoutDiff();
        if (resized) this.rebuild();
        cx.notify();
      })
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(15).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.picking) { this.picking = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.composer) { this.closeComposer(cx); cx.stop_propagation(); return; }
        if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control) && this.composer) { this.addComment(cx); cx.stop_propagation(); }
      })
      .child(header)
      .children(body);
  }
}
