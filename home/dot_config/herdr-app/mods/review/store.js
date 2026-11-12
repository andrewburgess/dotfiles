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
/** Shared key: each repo's pull request comments `{ [remoteKey]: Remote }`, fetched by the panel. */
export const REMOTE = "review.remote";

/** Diff sources the panel can show. */
export const MODES = [
  { id: "worktree", label: "Uncommitted" },
  { id: "base", label: "Branch" },
  { id: "turn", label: "Last turn" },
];

const DEFAULTS = { view: "unified", listing: "flat", hideReviewed: false, whitespace: false, mode: "worktree", collapsed: {}, remoteInDiff: true, hideResolved: true };

/**
 * Settings kept across spaces and restarts: view, listing, hideReviewed, whitespace, mode, collapsed,
 * remoteInDiff (PR threads shown in the diff) and hideResolved (resolved PR threads left out).
 */
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

/**
 * Review state of many files at once, reading the shared marks a single time.
 * @returns A map from file path to "none", "done", or "changed"
 */
export function reviewStates(session, files) {
  const marks = (shared(REVIEWED) ?? {})[session?.key] ?? {};
  return new Map(files.map((f) => { const mark = marks[f.path]; return [f.path, !mark ? "none" : mark.sig === f.sig ? "done" : "changed"]; }));
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

/** How long ago a time was, in words: "just now", "5m ago", "2d ago". */
export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

// #region Pull request comments

/** Branches whose PR lookup would find a stale PR that once used them as its head. */
const MAIN_BRANCHES = new Set(["main", "master", "dev", "stage", "staging", "develop", "development", "trunk"]);

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: 100) { nodes { id author { login __typename } body createdAt url } }
      reviews(last: 100) { nodes { id author { login __typename } body state submittedAt createdAt url } }
      reviewThreads(first: 100) { nodes { id isResolved isOutdated path line startLine originalLine originalStartLine diffSide subjectType
        comments(first: 50) { nodes { author { login __typename } body createdAt url } } } }
    }
  }
}`;

const REVIEW_STATES = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "commented", DISMISSED: "dismissed" };

/** Where a repo's PR comments are kept in `REMOTE`. */
export const remoteKey = (on, root) => root ? `${on ?? ""}:${root}` : null;

export const remoteOf = (key) => key ? (shared(REMOTE) ?? {})[key] ?? null : null;

const who = (a) => a?.login ?? "ghost";
const isBot = (a) => a?.__typename === "Bot" || /(\[bot\]|-bot)$/.test(a?.login ?? "");
const clip = (s, n = 4000) => { const t = String(s ?? "").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const firstLine = (s) => (s || "").trim().split("\n")[0];

/**
 * Reads the pull request for a repo's current branch, and its comments, with `gh`.
 * @returns A Remote `{ at, branch, number, url, title, head, error, threads, conversation }`. `number`
 *   is null when the branch has no PR; `error` is set when `gh` failed.
 */
export async function fetchRemote(root, on) {
  const at = Date.now(), branch = (await git(root, on, ["branch", "--show-current"])).stdout.trim();
  const none = (error = null, pr = {}) => ({ at, branch, number: pr.number ?? null, url: pr.url ?? null, title: pr.title ?? null, head: pr.headRefOid ?? null, error, threads: [], conversation: [] });
  if (!branch || MAIN_BRANCHES.has(branch)) return none();
  const failed = (e) => ({ code: 1, stdout: "", stderr: String(e) });
  const view = await exec("gh", ["pr", "view", "--json", "number,url,title,headRefOid"], { cwd: root, on }).catch(failed);
  if (view.code !== 0) return /no (open )?pull requests? found/i.test(view.stderr) ? none() : none(firstLine(view.stderr) || "gh pr view failed");
  const pr = JSON.parse(view.stdout), [, owner, name] = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url ?? "") ?? [];
  if (!owner) return none("Not a GitHub pull request", pr);
  const r = await exec("gh", ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`, "-f", `query=${PR_QUERY}`], { cwd: root, on }).catch(failed);
  if (r.code !== 0) return none(firstLine(r.stderr) || "gh api graphql failed", pr);
  const data = JSON.parse(r.stdout).data?.repository?.pullRequest;
  const threads = (data?.reviewThreads?.nodes ?? []).map((t) => ({
    id: t.id, path: t.path, file: t.subjectType === "FILE", side: t.diffSide, line: t.line ?? null, start: t.startLine ?? t.line ?? null,
    oldLine: t.originalLine ?? null, oldStart: t.originalStartLine ?? t.originalLine ?? null, resolved: Boolean(t.isResolved), outdated: Boolean(t.isOutdated),
    url: t.comments.nodes[0]?.url ?? pr.url,
    comments: t.comments.nodes.map((c) => ({ author: who(c.author), body: clip(c.body), at: Date.parse(c.createdAt) })),
  })).filter((t) => t.comments.length);
  const conversation = [
    ...(data?.comments?.nodes ?? []).map((c) => ({ id: c.id, kind: "comment", author: who(c.author), bot: isBot(c.author), body: clip(c.body), at: Date.parse(c.createdAt), url: c.url })),
    ...(data?.reviews?.nodes ?? []).map((c) => ({ id: c.id, kind: "review", state: c.state, author: who(c.author), bot: isBot(c.author), body: clip(c.body), at: Date.parse(c.submittedAt ?? c.createdAt), url: c.url })),
  ].filter((c) => c.body).sort((a, b) => a.at - b.at);
  return { ...none(null, pr), threads, conversation };
}

/** Saves a fetched Remote, dropping repos not fetched in a week. */
export function setRemote(key, remote) {
  const week = Date.now() - 7 * 86400000;
  const all = Object.fromEntries(Object.entries(shared(REMOTE) ?? {}).filter(([k, r]) => k !== key && r.at > week));
  setShared(REMOTE, { ...all, [key]: remote });
}

/** Changes one thread of a saved Remote; `rev` tells the diff tabs to redraw. */
function patchThread(key, id, change) {
  const all = shared(REMOTE) ?? {}, rec = all[key];
  if (!rec) return;
  setShared(REMOTE, { ...all, [key]: { ...rec, rev: Date.now(), threads: rec.threads.map((t) => t.id === id ? { ...t, ...change } : t) } });
}

/**
 * Resolves or reopens a PR review thread on GitHub. The saved thread changes at once and
 * changes back if GitHub refuses.
 * @param key The repo's `remoteKey`
 * @param resolved True to resolve, false to reopen
 * @returns null once GitHub accepted, else what went wrong
 */
export async function setThreadResolved(key, root, on, id, resolved) {
  const name = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const query = `mutation($id: ID!) { ${name}(input: { threadId: $id }) { thread { id isResolved } } }`;
  patchThread(key, id, { resolved });
  const r = await exec("gh", ["api", "graphql", "-f", `id=${id}`, "-f", `query=${query}`], { cwd: root, on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  if (r.code === 0) return null;
  patchThread(key, id, { resolved: !resolved });
  return firstLine(r.stderr) || `gh exited ${r.code}`;
}

/** A review with no draft comments: what it is about, for a note or PR comments to go with. */
export function generalMessage(session) {
  const where = `${session.root}${session.on ? ` (on ${session.on})` : ""}`;
  return { title: "Review · general feedback", context: `This is about the code review of ${where}: ${session.scope?.words ?? "the shown changes"}.` };
}

/** A thread's state in a word: "resolved", "outdated" or "open". */
export const threadStatus = (t) => t.resolved ? "resolved" : t.outdated ? "outdated" : "open";

/** Where a thread sits: "whole file", "line 94", "lines 90–94", or the line it had before it went outdated. */
export function threadSpan(t) {
  if (t.file) return "whole file";
  const [a, b, was] = t.line ? [t.start, t.line, ""] : [t.oldStart, t.oldLine, "was "];
  return !b ? "whole file" : a && a !== b ? `${was}lines ${a}–${b}` : `${was}line ${b}`;
}

/** Threads to show under current preferences. */
export const shownThreads = (remote) => (remote?.threads ?? []).filter((t) => !(prefs().hideResolved && t.resolved));

export const reviewWord = (c) => c.kind === "review" ? `review, ${REVIEW_STATES[c.state] ?? "commented"}` : "comment";

function threadText(t) {
  const side = t.side === "LEFT" && !t.file ? ", on the removed lines" : "";
  return `### PR thread on ${t.path}, ${threadSpan(t)}${side} (${threadStatus(t)})\n${t.comments.map((c) => `@${c.author}: ${c.body}`).join("\n\n")}`;
}

const conversationText = (c) => `### PR ${reviewWord(c)} by @${c.author}, ${new Date(c.at).toISOString().slice(0, 10)}\n${c.body}`;

/**
 * The PR comments the send dialog offers. Open threads (and, for a whole review, people's
 * conversation comments) start picked; resolved, outdated and bot ones don't.
 * @param key The repo's `remoteKey`
 * @param scope.path Only threads on this file
 * @param scope.lines Only threads overlapping these line numbers `{ new: number[], old: number[] }` (with `path`)
 * @returns `{ label, url, items: [{ id, label, text, on }] }`, or null when there is nothing to offer
 */
export function remoteItems(key, { path = null, lines = null } = {}) {
  const r = remoteOf(key);
  if (!r?.number) return null;
  const overlaps = (t) => {
    if (!lines) return true;
    const nums = t.side === "LEFT" ? lines.old : lines.new;
    return Boolean(t.line) && nums.some((n) => n >= (t.start ?? t.line) && n <= t.line);
  };
  const items = [
    ...r.conversation.map((c) => ({ id: c.id, label: `@${c.author} · ${reviewWord(c)} · ${ago(c.at)}`, text: conversationText(c), on: !c.bot && !path })),
    ...r.threads.filter((t) => (!path || t.path === path) && overlaps(t)).map((t) => ({
      id: t.id, label: `${t.path.split("/").pop()} · ${threadSpan(t)} · @${t.comments[0].author} · ${threadStatus(t)}${t.comments.length > 1 ? ` · ${t.comments.length} comments` : ""}`,
      text: threadText(t), on: !t.resolved && !t.outdated,
    })),
  ];
  return items.length ? { label: `PR #${r.number}`, url: r.url, items } : null;
}

// #endregion
