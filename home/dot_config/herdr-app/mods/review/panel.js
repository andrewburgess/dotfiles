// The Review panel: what changed, as a flat list or a tree, with reviewed marks, draft
// counts and the review to send. A file's diff opens in the space's Review tab (diff.js).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, focused, exec, readTextFile, watchFolder, theme, settings, shared, setShared, nextCommand, run } from "herdr";
import {
  MOD, MODES, TURNS, BASES, SESSIONS, TABS, OPEN, CURRENT, HISTORY, prefs, setPref, git, location, liveTabs,
  generatedPaths, signatures, reviewState, reviewStates, setReviewed, setReviewedMany, draftsOf, setDrafts, historyOf, settlePending, pendingSent,
  ago, remoteKey, remoteOf, fetchRemote, setRemote, shownThreads, threadStatus, threadSpan, reviewWord,
} from "./store.js";
import { submitReview } from "./ask.js";
import { fileIcon, folderIcon } from "./icon-map.js";
import { fileTarget, openFileMenu } from "./file-actions.js";

/** Tried in order when no PR base is known; the one with the fewest commits ahead of it wins. */
const BASE_CANDIDATES = ["origin/dev", "origin/develop", "origin/main", "origin/master", "origin/staging", "dev", "develop", "main", "master"];
// INDENT is a folder row's checkbox plus its gap (16 + 6), so a child's checkbox sits under its folder's icon.
const ROW_H = 30, INDENT = 22, NONE = "#00000000";
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// A throwaway index keeps the user's staging area untouched; copying the real one first
// lets `add -A` reuse its stat cache. Includes untracked files, skips ignored ones.
const SNAPSHOT = `idx="\${TMPDIR:-/tmp}/herdr-changes-$$.idx"
cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || rm -f "$idx"
GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git write-tree; rc=$?
rm -f "$idx"; exit $rc`;

/**
 * Records the whole working tree as a git tree object without touching refs or the index.
 * @returns {Promise<{ root: string, tree: string } | null>} null outside a repository or on failure
 */
async function snapshot(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (top.code !== 0) return null;
  const root = top.stdout.trim(), r = await exec("sh", ["-c", SNAPSHOT], { cwd: root, on });
  return r.code === 0 && r.stdout.trim() ? { root, tree: r.stdout.trim() } : null;
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
 * Folders and files as a tree, folders first. A folder holding only one folder is shown
 * as one row ("src/lib").
 */
function buildTree(files) {
  const root = { path: "", name: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { path: parts.slice(0, i + 1).join("/"), name: parts[i], dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  const compact = (n) => {
    for (const d of n.dirs.values()) compact(d);
    for (const [k, d] of [...n.dirs]) {
      let c = d;
      while (c.dirs.size === 1 && !c.files.length) { const only = [...c.dirs.values()][0]; c = { ...only, name: `${c.name}/${only.name}` }; }
      n.dirs.set(k, c);
    }
  };
  compact(root);
  return root;
}

/**
 * Sets each folder's `total` and `done` file counts in one pass.
 * @param states Review state by file path
 * @returns The node's `[total, done]`
 */
function countTree(node, states) {
  let total = node.files.length, done = node.files.filter((f) => states.get(f.path) === "done").length;
  for (const d of node.dirs.values()) { const [t, k] = countTree(d, states); total += t; done += k; }
  node.total = total; node.done = done;
  return [total, done];
}

/** Every file under a tree node, in tree order. */
function treeFiles(node) {
  return [...[...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).flatMap(treeFiles), ...[...node.files].sort((a, b) => a.path.localeCompare(b.path))];
}

export class Panel {
  init(_props, cx) {
    this.files = []; this.message = ""; this.statuses = {}; this.detected = {}; this.branches = []; this.filter = "";
    this.lastAgent = {}; this.published = null; this.historyOpen = false; this.remoteOpen = false; this.handle = cx.focus_handle();
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
    for (const old of ["changes.fullTabs", "changes.fullOpen"]) if (shared(old) != null) setShared(old, null);
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "submit") this.submit(cx);
        else if (c === "clear") this.discard(cx);
        else if (c === "tree") setPref("listing", prefs().listing === "tree" ? "flat" : "tree");
        else if (c === "view") setPref("view", prefs().view === "split" ? "unified" : "split");
        cx.notify();
      }
    });
  }

  get mode() { const m = prefs().mode; return MODES.some((x) => x.id === m) ? m : "worktree"; }

  /** Everything the list depends on; a change discards in-flight results and reloads. */
  key() {
    const { cwd, on } = location();
    return JSON.stringify({ cwd, on, mode: this.mode, base: this.mode === "base" ? shared(BASES) ?? null : null, turns: this.mode === "turn" ? shared(TURNS) ?? null : null });
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
    const cwd = panes().find((p) => p.pane === agent.pane)?.cwd;
    const on = agent.address.includes("/") ? agent.address.split("/")[0] : spaces().find((s) => s.id === agent.space)?.machine ?? null;
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
    const last = Object.values(turns).map((r) => r.last).filter((t) => t?.root === root).sort((a, b) => b.endedAt - a.endedAt)[0];
    return { turn: last ?? null, running: Object.values(turns).some((r) => r.current?.root === root) };
  }

  // #endregion

  // #region Base branch

  async detectBase(g, root, on) {
    const branch = (await g(["branch", "--show-current"])).stdout.trim(), cacheKey = `${root}\0${branch}`;
    if (this.detected[cacheKey]) return this.detected[cacheKey];
    const exists = async (ref) => (await g(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;
    let found = null;
    const onBase = BASE_CANDIDATES.some((r) => r.replace(/^origin\//, "") === branch);
    if (branch && !onBase) {
      const pr = await exec("gh", ["pr", "view", branch, "--json", "baseRefName", "-q", ".baseRefName"], { cwd: root, on }).catch(() => null);
      const name = pr?.code === 0 ? pr.stdout.trim() : "";
      if (name) found = (await exists(`origin/${name}`)) ? `origin/${name}` : (await exists(name)) ? name : null;
    }
    if (!found && !onBase) {
      const head = (await g(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
      let best = null;
      for (const ref of [...new Set([head, ...BASE_CANDIDATES])].filter((r) => r && r !== branch && r !== `origin/${branch}`)) {
        const count = await g(["rev-list", "--count", `${ref}..HEAD`]);
        if (count.code === 0 && (best === null || +count.stdout < best.count)) best = { ref, count: +count.stdout };
      }
      found = best?.ref ?? null;
    }
    // On a base branch itself (main, master, dev), comparing against another base would list a
    // whole release diff; compare against its own remote so the panel shows unpushed work.
    if (!found && branch) {
      const upstream = (await g(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim();
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
      const r = await git(root, on, ["for-each-ref", "--format=%(refname:short)", "refs/remotes", "refs/heads"]);
      this.branches = r.code === 0 ? r.stdout.split("\n").filter((b) => b && !b.endsWith("/HEAD") && b !== "origin") : [];
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

  // #region Loading

  setMode(mode, cx) {
    if (mode === this.mode) return;
    this.picking = false;
    setPref("mode", mode);
    this.refresh(cx);
    cx.notify();
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
    if (this.loading || this.busy) { if (this.loading) this.again = true; return; }
    const { cwd, on, space } = location(), context = this.key(), place = JSON.stringify({ cwd, on });
    if (context !== this.context) {
      if (place !== this.place) { this.message = ""; this.input.set_value(""); this.watched = null; this.picking = false; }
      this.context = context; this.place = place; this.root = null; this.files = []; this.info = null; this.scope = null;
      this.error = null; this.note_ = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (this.key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), g = (args) => git(root, on, args);
        const head = await g(["rev-parse", "--verify", "HEAD"]);
        const found = this.mode === "worktree" ? await this.worktreeFiles(g, head.code === 0)
          : this.mode === "base" ? await this.baseFiles(g, root, on, head.code === 0)
          : await this.turnFiles(g, root);
        if (this.key() !== context) return;
        const { diffArgs, info, empty, scope } = found, files = found.files.slice(0, 1000);
        const [sigs, generated] = await Promise.all([
          signatures(root, on, files, this.mode === "turn" ? diffArgs[1] : null).catch(() => ({})),
          generatedPaths(root, on, files.map((f) => f.path)).catch(() => new Set()),
        ]);
        for (const f of files) { f.sig = sigs[f.path] ?? null; f.generated = generated.has(f.path); }
        // Untracked files have no numstat; count their lines here.
        for (const f of files.filter((f) => f.fresh && !f.add && !f.generated).slice(0, 100)) {
          const text = await readTextFile(`${root}/${f.path}`, { on }).catch(() => null);
          if (text !== null && !text.includes("\0")) f.add = countLines(text); else if (text?.includes("\0")) f.binary = true;
        }
        if (this.key() !== context) return;
        this.root = root; this.on = on; this.space = space; this.hasHead = head.code === 0; this.head = this.hasHead ? head.stdout.trim() : null;
        this.diffArgs = diffArgs; this.info = info; this.empty = empty; this.scope = scope;
        this.files = files; this.limited = found.files.length > 1000; this.error = null;
        this.watch(root, cx);
        this.publish();
        this.syncRemote(cx);
      } catch (e) { if (this.key() === context) this.error = String(e?.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) cx.timer.after(1, (cx) => this.refresh(cx));
      }
    });
  }

  async worktreeFiles(g, hasHead) {
    const status = await g(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr);
    const stats = {};
    const results = hasHead ? [await g(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await g(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await g(["diff", "--numstat", "-z", "--no-renames"])];
    for (const result of results) {
      if (result.code !== 0) throw new Error(result.stderr);
      parseNumstat(result.stdout, stats);
    }
    const files = status.stdout.split("\0").filter(Boolean).map((entry) => {
      const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??" || (!hasHead && xy.includes("A"));
      const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
      const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
      return { path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) };
    });
    return { files, diffArgs: hasHead ? ["HEAD"] : [], info: null, empty: "No uncommitted changes", scope: { id: "", words: "uncommitted changes" } };
  }

  async baseFiles(g, root, on, hasHead) {
    const none = (text, empty, pick = false) => ({ files: [], diffArgs: [], info: { text, pick }, empty, scope: null });
    if (!hasHead) return none("No commits yet", "No commits yet");
    const chosen = (shared(BASES) ?? {})[root], base = chosen ?? await this.detectBase(g, root, on);
    if (!base) return none("Base: none found", "Pick a base branch to compare against", true);
    const mb = await g(["merge-base", base, "HEAD"]);
    if (mb.code !== 0) return none(`Base: ${base}`, `No common history with ${base}`, true);
    const from = mb.stdout.trim();
    const [num, names, untracked, branch] = await Promise.all([
      g(["diff", from, "--numstat", "-z", "--no-renames"]),
      g(["diff", from, "--name-status", "-z", "--no-renames"]),
      g(["ls-files", "--others", "--exclude-standard", "-z"]),
      g(["branch", "--show-current"]),
    ]);
    for (const r of [num, names, untracked]) if (r.code !== 0) throw new Error(r.stderr);
    const stats = parseNumstat(num.stdout);
    const files = parseNameStatus(names.stdout).map(({ code, path }) => ({ path, status: letter(code), fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) }))
      .concat(untracked.stdout.split("\0").filter(Boolean).map((path) => ({ path, status: "A", fresh: true, add: 0, del: 0 })));
    const name = branch.stdout.trim() || "HEAD";
    return { files, diffArgs: [from], info: { text: `Base: ${base}${chosen ? "" : " (auto)"}`, pick: true }, empty: `No changes against ${base}`,
      scope: { id: base, words: `all changes on ${name} since it left ${base} (merge base ${from.slice(0, 7)}), committed or not` } };
  }

  async turnFiles(g, root) {
    const { turn, running } = this.turnFor(root);
    const suffix = running ? " · agent working" : "";
    if (!turn) return { files: [], diffArgs: [], info: { text: `No finished agent turn here yet${suffix}` }, empty: "Changes appear after an agent in this repo finishes a turn", scope: null };
    const label = `${turn.label || "Agent"} · ${ago(turn.endedAt)}${suffix}`;
    const [num, names] = await Promise.all([
      g(["diff", turn.start, turn.end, "--numstat", "-z", "--no-renames"]),
      g(["diff", turn.start, turn.end, "--name-status", "-z", "--no-renames"]),
    ]);
    const scope = { id: `${turn.start}..${turn.end}`, words: `the changes made during the last agent turn (${turn.label || "agent"}, ended ${ago(turn.endedAt)})` };
    // Snapshot trees are unreferenced, so `git gc` may eventually prune old ones.
    if (num.code !== 0 || names.code !== 0) return { files: [], diffArgs: [], info: { text: label }, empty: "This turn's snapshot is no longer available", scope };
    const stats = parseNumstat(num.stdout);
    const files = parseNameStatus(names.stdout).map(({ code, path }) => ({ path, status: letter(code), fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) }));
    return { files, diffArgs: [turn.start, turn.end], info: { text: label }, empty: "The last turn changed no files", scope };
  }

  // #endregion

  // #region Pull request comments

  /** Fetches the branch's PR comments when HEAD moved, or when the last fetch is over 90 s old. */
  syncRemote(cx, force = false) {
    const key = remoteKey(this.on, this.root), stamp = `${key}\0${this.head}`, last = remoteOf(key);
    if (!key || this.remoteBusy) return;
    if (!force && this.remoteStamp === stamp && last && Date.now() - last.at < 90000) return;
    this.remoteBusy = key; this.remoteStamp = stamp;
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try { setRemote(key, await fetchRemote(root, on)); }
      catch (e) { setRemote(key, { threads: [], conversation: [], ...(remoteOf(key) ?? {}), at: Date.now(), error: String(e?.message ?? e) }); }
      finally { this.remoteBusy = null; cx.notify(); }
    });
  }

  /** The branch's pull request: its conversation and line threads, and the settings for showing them. */
  remoteSection(t) {
    const key = remoteKey(this.on, this.root), r = remoteOf(key);
    if (!r || (!r.number && !r.error)) return null;
    const p = prefs(), threads = shownThreads(r), open = r.threads.filter((x) => !x.resolved).length, talk = r.conversation.length;
    const words = r.number ? [`PR #${r.number}`, `${open} open thread${open === 1 ? "" : "s"}`, talk ? `${talk} comment${talk === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ") : "PR comments";
    const browse = (url) => () => { if (url) exec("open", [url]).catch(() => null); };
    const icon = (id, tip, child, action) => div().id(id).size(22).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); }).child(child);
    const toggle = (id, label, on, action) => h_flex().id(id).h(26).px(6).gap(6).items_center().rounded(6).text_size(13).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(this.box(t, on ? "done" : "none", 14)).child(label);
    return v_flex().flex_none().border_t(1).border_color(t.border)
      .child(h_flex().id("remote-toggle").h(34).pl(14).pr(8).gap(6).items_center().cursor_pointer().text_size(13).text_color(t.muted).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.remoteOpen = !this.remoteOpen; cx.notify(); })
        .child(div().w(12).text_size(11).child(this.remoteOpen ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().child(words))
        .child(div().flex_none().text_size(12).text_color(r.error ? t.ansi1 : t.dim).child(this.remoteBusy === key ? "updating…" : r.error ? "failed" : ago(r.at)))
        .child(icon("remote-refresh", "Fetch PR comments", "↻", (cx) => this.syncRemote(cx, true)))
        .when(Boolean(r.url), (e) => e.child(icon("remote-browse", "Open the PR on GitHub", svg(`mods/${MOD}/external-link.svg`).size(12), browse(r.url)))))
      .when(this.remoteOpen, (e) => e.child(v_flex().px(10).pb(8).gap(6)
        .when(Boolean(r.error), (el) => el.child(div().px(4).text_size(12).text_color(t.ansi1).whitespace_normal().child(r.error)))
        .child(h_flex().gap(4).flex_wrap()
          .child(toggle("remote-in-diff", "Threads in diff", p.remoteInDiff, () => setPref("remoteInDiff", !p.remoteInDiff)))
          .child(toggle("remote-hide-resolved", "Hide resolved", p.hideResolved, () => setPref("hideResolved", !p.hideResolved))))
        .child(v_flex().id("remote-list").max_h(260).overflow_y_scrollbar().gap(2)
          .children(r.conversation.map((c) => this.remoteRow(t, `remote-c-${c.id}`, `@${c.author} · ${reviewWord(c)} · ${ago(c.at)}`, c.body, c.bot, browse(c.url))))
          .children(threads.map((x) => this.remoteRow(t, `remote-t-${x.id}`,
            `${x.path.split("/").pop()} · ${threadSpan(x)} · ${threadStatus(x)}${x.comments.length > 1 ? ` · ${x.comments.length} comments` : ""}`,
            `@${x.comments[0].author}: ${x.comments[0].body}`, x.resolved, (_e, cx) => this.openFile(x.path, cx, false, x.id))))
          .when(!talk && !threads.length, (el) => el.child(div().px(6).text_size(13).text_color(t.dim).child(r.threads.length ? "Every thread is resolved" : "No comments yet"))))));
  }

  remoteRow(t, id, label, body, faded, action) {
    return v_flex().id(id).px(6).py(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action).when(faded, (e) => e.opacity(0.6))
      .child(div().text_size(12).text_color(t.muted).truncate().child(label))
      .child(div().text_size(13).truncate().child((body || "").trim().split("\n")[0]));
  }

  // #endregion

  // #region Session

  /** Drafts, reviewed marks and history are kept per machine, repo, mode and what the mode compares. */
  reviewKey() { return this.root && this.scope ? `${this.on ?? ""}:${this.root}:${this.mode}:${this.scope.id}` : null; }

  /** Files in the order the list shows them, which is also the diff tab's next/previous order. */
  ordered() { return prefs().listing === "tree" ? treeFiles(buildTree(this.files)) : this.files; }

  /** What the space's diff tab needs to load and navigate this list. */
  session() {
    if (!this.root || !this.space) return null;
    return {
      space: this.space, root: this.root, on: this.on ?? null, hasHead: this.hasHead, mode: this.mode, scope: this.scope, diffArgs: this.diffArgs,
      key: this.reviewKey(), label: this.info?.text ?? null, agent: this.lastAgent[this.space] ?? null,
      head: this.head ?? null, remote: remoteKey(this.on, this.root),
      files: this.files.map(({ path, status, fresh, add, del, binary, sig, generated }) => ({ path, status, fresh: Boolean(fresh), add, del, binary: Boolean(binary), sig, generated })),
      order: this.ordered().map((f) => f.path),
    };
  }

  /** Shares the session with the diff tab when it changed. */
  publish() {
    const s = this.session();
    if (!s) return;
    const json = JSON.stringify(s), all = shared(SESSIONS) ?? {};
    if (json === this.published && JSON.stringify(all[s.space] ?? null) === json) return;
    this.published = json; this.publishedOrder = s.order.join("\0");
    const live = new Set(spaces().map((x) => x.id));
    setShared(SESSIONS, { ...Object.fromEntries(Object.entries(all).filter(([id]) => live.has(id))), [s.space]: s });
  }

  /**
   * Shows a file in the space's Review tab, opening the tab the first time.
   * @param comment Open the whole-file comment box
   * @param thread A PR thread id to scroll to
   */
  openFile(path, cx, comment = false, thread = null) {
    const s = this.session();
    if (!s) return;
    this.publish();
    setShared(OPEN, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), space: s.space, path, comment, thread });
    const live = liveTabs(), tabs = Object.fromEntries(Object.entries(shared(TABS) ?? {}).filter(([id]) => live.has(id)));
    const entry = { space: s.space, cwd: s.root, on: s.on };
    const existing = Object.entries(tabs).find(([, v]) => v.space === s.space);
    if (existing) {
      if (JSON.stringify(existing[1]) !== JSON.stringify(entry)) setShared(TABS, { ...tabs, [existing[0]]: entry });
      run("tab.select", { id: existing[0] });
      return;
    }
    if (this.opening && Date.now() - this.opening < 5000) return;
    this.opening = Date.now();
    const args = { name: `Review · ${s.root.split("/").pop()}`, space: s.space, mod: MOD, props: { diff: true, space: s.space } };
    cx.spawn(async (cx) => {
      const r = await exec("herdr-app", ["do", "tab.new", JSON.stringify(args)]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      this.opening = null;
      let made = null;
      try { made = JSON.parse(r.stdout); } catch {}
      if (r.code !== 0 || !made?.tab) { this.note_ = `Couldn't open the Review tab: ${made?.error ?? r.stderr.trim()}`; cx.notify(); return; }
      setShared(TABS, { ...Object.fromEntries(Object.entries(shared(TABS) ?? {}).filter(([id]) => liveTabs().has(id) || id === made.tab)), [made.tab]: entry });
    });
  }

  toggleReviewed(file, cx) {
    const s = this.session();
    if (!s) return;
    const done = reviewState(s, file) !== "done";
    cx.spawn(async (cx) => { await setReviewed(s, file, done); cx.notify(); });
  }

  /**
   * Marks every file under a tree folder reviewed, or clears them all when every one already is.
   * @param dir A `buildTree` folder node with `countTree` counts
   */
  toggleDirReviewed(dir, cx) {
    const s = this.session();
    if (!s || !dir.total) return;
    const done = dir.done !== dir.total;
    cx.spawn(async (cx) => { await setReviewedMany(s, treeFiles(dir), done); cx.notify(); });
  }

  toggleDir(path) {
    const all = { ...prefs().collapsed }, list = new Set(all[this.root] ?? []);
    if (list.has(path)) list.delete(path); else list.add(path);
    if (list.size) all[this.root] = [...list]; else delete all[this.root];
    setPref("collapsed", all);
  }

  submit(cx) {
    const s = this.session();
    if (s) submitReview(s, draftsOf(s.key));
    cx.notify();
  }

  discard(cx) { setDrafts(this.reviewKey(), []); cx.notify(); }

  // #endregion

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

  // #region Chrome

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
    const q = this.filter.trim().toLowerCase(), matches = this.branches.filter((b) => b.toLowerCase().includes(q)).slice(0, 200);
    const chosen = (shared(BASES) ?? {})[this.root];
    const item = (id, label, ref, active) => div().id(id).h(28).flex_none().px(8).flex().items_center().rounded(6).cursor_pointer().truncate()
      .when(active, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.chooseBase(ref, cx)).child(label);
    return v_flex().flex_none().mx(10).mt(4).p(6).gap(4).rounded(8).border_1().border_color(t.border).bg(t.popover ?? t.raised).text_size(14)
      .child(div().id("base-filter").h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.input ?? t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(14).text_color(t.foreground)))
      .child(v_flex().id("base-list").max_h(Math.min(360, Math.max(100, (this.panelHeight ?? 600) / (Number(settings().zoom) || 1) - 240))).overflow_y_scrollbar()
        .child(item("base-auto", "Auto-detect", null, !chosen))
        .children(matches.map((b) => item(`base-${b}`, b, b, chosen === b))));
  }

  /** Flat/Tree, Hide reviewed, and how far the review has come. */
  listBar(t, done, total) {
    const p = prefs();
    const seg = (id, label, on, action) => div().id(id).h(24).px(9).flex().items_center().rounded(5).text_size(13).cursor_pointer()
      .when(on, (e) => e.bg(t.background).text_color(t.foreground))
      .when(!on, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click(action).child(label);
    return v_flex().flex_none().mx(10).mt(8).gap(6)
      .child(h_flex().gap(8).items_center()
        .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.raised)
          .child(seg("list-flat", "Flat", p.listing !== "tree", () => setPref("listing", "flat")))
          .child(seg("list-tree", "Tree", p.listing === "tree", () => setPref("listing", "tree"))))
        .child(h_flex().id("hide-reviewed").h(28).px(8).gap(6).items_center().rounded(6).text_size(13).cursor_pointer()
          .text_color(p.hideReviewed ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => setPref("hideReviewed", !p.hideReviewed))
          .child(this.box(t, p.hideReviewed ? "done" : "none", 14)).child("Hide reviewed"))
        .child(div().flex_1())
        .child(div().text_size(13).text_color(done === total && total ? t.ansi2 : t.muted).child(`${done}/${total} reviewed`)))
      .child(div().h(4).w_full().rounded(2).bg(t.raised).child(div().h_full().rounded(2).bg(done === total ? t.ansi2 : t.accent).w(`${total ? (100 * done) / total : 0}%`)));
  }

  /**
   * A reviewed checkbox: empty, checked, ringed in the warning color when the file changed since,
   * or a dash when only some of a folder's files are reviewed.
   */
  box(t, state, size = 16) {
    return div().size(size).flex_none().flex().items_center().justify_center().rounded(4).border_1()
      .border_color(state === "done" ? t.ansi2 : state === "changed" ? t.blocked : t.input)
      .bg(state === "done" ? t.ansi2 : NONE)
      .when(state === "done", (e) => e.child(svg(`mods/${MOD}/check.svg`).size(size - 5).text_color(t.background)))
      .when(state === "changed", (e) => e.child(div().size(6).rounded(3).bg(t.blocked)))
      .when(state === "partial", (e) => e.child(div().w(size - 8).h(2).rounded(1).bg(t.ansi2)));
  }

  fileRow(t, s, f, depth, ctx) {
    const parts = f.path.split("/"), name = parts.pop(), k = ctx.perFile[f.path], state = ctx.states.get(f.path) ?? "none", shown = ctx.current === f.path, open = ctx.threads[f.path];
    // In the tree, a file's checkbox lines up with its sibling folders' checkboxes (past their 12px arrow and 6px gap).
    return h_flex().id(`change-${f.path}`).h(ROW_H).flex_none().pl(ctx.tree ? 6 + 12 + 6 + depth * INDENT : 8).pr(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(shown, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.openFile(f.path, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openFileMenu(fileTarget(s, f)); })
      .child(div().id(`reviewed-${f.path}`).cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.toggleReviewed(f, cx); }).child(this.box(t, state)))
      .child(div().w(12).flex_none().text_size(13).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(image(fileIcon(name, settings().dark !== false)).size(16).flex_none())
      .child(h_flex().flex_1().min_w(0).when(state === "done" || f.generated, (e) => e.opacity(0.6))
        .when(!ctx.tree && parts.length > 0, (e) => e.child(div().text_color(t.dim).truncate().child(parts.join("/") + "/")))
        .child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(state === "changed", (e) => e.child(div().flex_none().text_size(12).text_color(t.blocked).child("changed")))
      .when(f.generated, (e) => e.child(div().flex_none().px(4).rounded(3).border_1().border_color(t.border).text_size(11).text_color(t.dim).child("generated")))
      // One speech bubble per file: the draft count when there are drafts; a click comments on the whole file.
      .child(h_flex().id(`comment-file-${f.path}`).h(20).min_w(20).px(k ? 5 : 0).gap(3).flex_none().items_center().justify_center().rounded(4).cursor_pointer()
        .when(Boolean(k), (e) => e.bg(t.accent + "33").text_size(12).text_color(t.foreground))
        .when(!k, (e) => e.text_color(t.muted))
        .hover((st) => st.bg(k ? t.accent + "55" : t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.openFile(f.path, cx, true); })
        .when(Boolean(k), (e) => e.child(String(k))).child(svg(`mods/${MOD}/comment.svg`).size(k ? 11 : 13)))
      .when(Boolean(open?.length), (e) => e.child(h_flex().id(`pr-threads-${f.path}`).h(20).px(5).gap(3).flex_none().items_center().rounded(4)
        .bg(t.ansi5 + "26").text_size(12).text_color(t.ansi5).cursor_pointer().hover((st) => st.bg(t.ansi5 + "44"))
        .tooltip(`${open.length} unresolved PR thread${open.length > 1 ? "s" : ""}`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.openFile(f.path, cx, false, open[0].id); })
        .child(svg(`mods/${MOD}/pr.svg`).size(12)).child(String(open.length))))
      .when(f.add > 0, (e) => e.child(div().text_size(13).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(13).text_color(t.ansi1).child(`−${f.del}`)));
  }

  /** The tree's rows, skipping what collapsed folders hold. */
  treeRows(t, s, node, depth, ctx, out) {
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const { total, done } = d, shut = ctx.collapsed.has(d.path);
      const state = total && done === total ? "done" : done > 0 ? "partial" : "none";
      out.push(h_flex().id(`dir-${d.path}`).h(ROW_H - 2).flex_none().pl(6 + depth * INDENT).pr(8).gap(6).items_center().rounded(7).cursor_pointer()
        .hover((st) => st.bg(t.hover)).on_click(() => this.toggleDir(d.path))
        .child(div().w(12).flex_none().text_size(11).text_color(t.dim).child(shut ? "▸" : "▾"))
        .child(div().id(`reviewed-dir-${d.path}`).cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.toggleDirReviewed(d, cx); }).child(this.box(t, state)))
        .child(image(folderIcon(d.name.split("/").pop(), !shut, settings().dark !== false)).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${d.name}/`))
        .child(div().flex_none().text_size(12).text_color(done === total ? t.ansi2 : t.dim).child(`${done}/${total}`)));
      if (!shut) this.treeRows(t, s, d, depth + 1, ctx, out);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) out.push(this.fileRow(t, s, f, depth, ctx));
    return out;
  }

  /** Sent reviews for this list, newest first, with each comment opening its file. */
  history(t) {
    const rounds = historyOf(this.reviewKey()).slice().reverse();
    if (!rounds.length) return null;
    return v_flex().flex_none().border_t(1).border_color(t.border)
      .child(h_flex().id("history-toggle").h(34).px(14).gap(6).items_center().cursor_pointer().text_size(13).text_color(t.muted).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.historyOpen = !this.historyOpen; cx.notify(); })
        .child(div().w(12).text_size(11).child(this.historyOpen ? "▾" : "▸"))
        .child(div().flex_1().child(`Sent reviews · ${rounds.length}`))
        .child(div().text_size(12).text_color(t.dim).child(`last ${ago(rounds[0].at)}`)))
      .when(this.historyOpen, (e) => e.child(v_flex().id("history-list").max_h(240).overflow_y_scrollbar().px(10).pb(8).gap(8).children(rounds.map((r) =>
        v_flex().gap(2)
          .child(div().px(4).text_size(12).text_color(t.dim).child(`${ago(r.at)} · ${r.comments.length} comment${r.comments.length > 1 ? "s" : ""}`))
          .children(r.comments.map((c) => v_flex().id(`sent-${r.id}-${c.id}`).px(6).py(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.openFile(c.path, cx))
            .child(div().text_size(12).text_color(t.muted).truncate().child(`${c.path.split("/").pop()} · ${c.whole ? "file" : c.from.number === c.to.number ? `line ${c.from.number}` : `lines ${c.from.number}–${c.to.number}`}`))
            .child(div().text_size(13).truncate().child(c.text))))))));
  }

  // #endregion

  render(cx) {
    this.track(cx);
    if (pendingSent()) cx.timer.after(1, () => settlePending());
    const here = location();
    const agent = agents().find((a) => a.focused);
    if (agent && here.space && agent.space === here.space && this.lastAgent[here.space] !== agent.address) {
      this.lastAgent[here.space] = agent.address;
      cx.timer.after(1, () => this.publish());
    }
    if (this.key() !== this.context) this.refresh(cx);
    else if (this.root && this.ordered().map((f) => f.path).join("\0") !== this.publishedOrder) cx.timer.after(1, () => this.publish());
    const t = theme(), s = this.session(), p = prefs(), tree = p.listing === "tree";
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const drafts = draftsOf(s?.key), perFile = {};
    for (const c of drafts) perFile[c.path] = (perFile[c.path] ?? 0) + 1;
    const states = s ? reviewStates(s, this.files) : new Map();
    const done = this.files.filter((f) => states.get(f.path) === "done").length;
    const shown = p.hideReviewed && s ? this.files.filter((f) => states.get(f.path) !== "done") : this.files;
    const threads = {};
    for (const th of remoteOf(s?.remote)?.threads ?? []) if (!th.resolved) (threads[th.path] ??= []).push(th);
    const ctx = { perFile, tree, threads, states, collapsed: new Set(p.collapsed[this.root] ?? []), current: s ? (shared(CURRENT) ?? {})[s.space] : null };
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const n = drafts.length, sent = this.history(t), remote = this.remoteSection(t);

    const header = h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Review"))
      .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(`${this.files.length} files`))
      .child(div().flex_1()).child(div().text_size(13).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(13).text_color(t.ansi1).child(`−${del}`));

    const shownTree = s && tree ? buildTree(shown) : null;
    if (shownTree) countTree(shownTree, states);
    const rows = !s ? [] : tree ? this.treeRows(t, s, shownTree, 0, ctx, []) : shown.map((f) => this.fileRow(t, s, f, 0, ctx));
    const list = v_flex().id("changes-list").flex_1().min_h(0).mt(8).overflow_y_scrollbar().p(6).border_t(1).border_color(t.border)
      .children(rows)
      .when(!rows.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading && !this.files.length ? "Loading changes…" : !this.root ? "No folder" : this.files.length ? "Every file is reviewed" : this.empty))));

    const openThreads = Object.values(threads).reduce((k, list) => k + list.length, 0);
    const reviewBar = s ? h_flex().flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted)
        .child(n ? `${n} draft comment${n > 1 ? "s" : ""}` : openThreads ? `${openThreads} unresolved PR thread${openThreads > 1 ? "s" : ""}` : "No draft comments"))
      .when(n > 0, (e) => e.child(div().id("review-discard").h(28).px(8).flex().items_center().rounded(6).text_size(13).text_color(t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.discard(cx)).child("Discard")))
      .child(div().id("review-submit").h(28).px(12).flex().flex_none().items_center().rounded(6).cursor_pointer().hover((st) => st.opacity(0.88)).text_size(13).font_medium()
        .bg(n ? t.solid : t.raised).text_color(n ? t.solid_foreground : t.foreground)
        .on_click((_e, cx) => this.submit(cx)).child(n ? `Submit review · ${n}` : "Send review")) : null;

    return v_flex().id("changes")
      .on_size_change((size, cx) => { if (size.height !== this.panelHeight) { this.panelHeight = size.height; cx.notify(); } })
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(15).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.picking) { this.picking = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(header)
      .child(this.modeTabs(t))
      .when(Boolean(this.info), (e) => e.child(this.infoLine(t)))
      .when(Boolean(this.picking && this.root), (e) => e.child(this.picker(t)))
      .when(this.files.length > 0, (e) => e.child(this.listBar(t, done, this.files.length)))
      .child(list)
      .when(this.limited, (e) => e.child(div().px(12).py(4).text_size(13).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note_), (e) => e.child(div().px(10).py(6).text_size(13).text_color(t.ansi1).child(this.note_)))
      .when(Boolean(reviewBar), (e) => e.child(reviewBar))
      .when(Boolean(remote), (e) => e.child(remote))
      .when(Boolean(sent), (e) => e.child(sent))
      .when(this.mode === "worktree", (e) => e.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(34).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(14).text_color(t.foreground)))
        .child(div().id("commit").h(34).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(14).when(enabled, (el) => el.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))));
  }
}

