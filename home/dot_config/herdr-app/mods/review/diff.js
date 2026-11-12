// A space's Review tab: one file's diff at a time, from the session the Review panel shares,
// with line comments, reviewed marks, hidden-context expansion and file navigation.
import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, readTextFile, theme, settings, shared, setShared, props, nextCommand, run, notify } from "herdr";
import { tokenize, languageOf } from "./highlight.js";
import { palette } from "./palette.js";
import { ask, submitReview } from "./ask.js";
import {
  MOD, MODES, SESSIONS, TABS, TAB_ICONS, OPEN, CURRENT, prefs, setPref, zoom, git, storeBlob, reviewState, reviewMark, setReviewed,
  draftsOf, setDrafts, historyOf, dismissSent, settlePending, pendingSent, describe, where,
  ago, remoteOf, threadSpan, threadStatus, remoteItems, setThreadResolved,
} from "./store.js";
import { fileIcon } from "./icon-map.js";
import { fileTarget, openFileMenu, openInCode } from "./file-actions.js";

/** Diff text size, from the terminal font size setting (px at zoom 1). */
const font = () => Number(settings().font_size) || 14;
/** Row height for the diff text size. */
const row = () => Math.round(font() * 1.7);
/** Approximate advance of one monospace character at the diff's text size. */
const charW = () => font() * 0.62;
/** The terminal font, which the diff is drawn in. */
const family = () => settings().font ?? settings().font_family ?? "JetBrains Mono";
/** Width of the +/− column beside the line numbers. */
const SIGN_W = 16;
/** Approximate height of the comment box, for flipping it above the clicked line near the bottom. */
const BOX_H = 200;
/** Most diff lines shown, and most rows once hidden context is expanded. */
const MAX_LINES = 5000, MAX_ROWS = 20000;
/** Blank space after the last row, px. */
const END_PAD = 96;
/** A PR thread card's header row, and the widths of its Resolve and GitHub buttons, which clicks are matched against. */
const THREAD_HEAD = 34, RESOLVE_W = 84, GITHUB_W = 64, CARD_PAD_R = 22;
const NONE = "#00000000";
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Hunk positions in a unified diff. A side with no lines reports the line before it, so
 * `first` is where its lines would start.
 */
function hunks(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = typeof l === "string" ? HEADER.exec(l) : null;
    if (!m) return;
    const oldCount = m[2] === undefined ? 1 : +m[2], newCount = m[4] === undefined ? 1 : +m[4];
    out.push({ at: i, oldFirst: oldCount ? +m[1] : +m[1] + 1, newFirst: newCount ? +m[3] : +m[3] + 1, newCount });
  });
  return out;
}

/**
 * Inserts the unchanged lines between hunks, from the new file's text: an opened gap
 * becomes context lines, a closed one a `{ gap, count }` marker.
 * @param lines Diff lines from the first hunk header on
 * @param text The new file's text, or null when it can't be read (then nothing is expandable)
 * @param open Whether a gap (0 before the first hunk, k before hunk k, hunks.length after the last) is shown
 */
function withContext(lines, text, open) {
  const hs = hunks(lines);
  if (!hs.length || text === null) return lines;
  const file = text.replace(/\n$/, "").split("\n"), out = [];
  let next = 1;
  hs.forEach((h, k) => {
    const from = next, to = h.newFirst - 1, n = to - from + 1, body = lines.slice(h.at + 1, hs[k + 1]?.at ?? lines.length);
    if (n > 0 && open(k)) {
      // Lines before the first hunk are unchanged, so old and new numbers advance together.
      if (k === 0) out.push(`@@ -${h.oldFirst - n} +${from} @@`);
      for (let j = from; j <= to; j++) out.push(" " + (file[j - 1] ?? ""));
    } else {
      if (n > 0) out.push({ gap: k, count: n });
      out.push(lines[h.at]);
    }
    out.push(...body);
    next = h.newFirst + h.newCount;
  });
  const rest = file.length - next + 1;
  if (rest > 0) {
    if (open(hs.length)) for (let j = next; j <= file.length; j++) out.push(" " + file[j - 1]);
    else out.push({ gap: hs.length, count: rest });
  }
  return out;
}

/**
 * Numbers and tokenizes each diff line once, so a frame only draws the rows on screen.
 * @param lines Diff lines (and `{ gap, count }` markers) from the first hunk header on
 * @param lang Tokenizer language from `languageOf`, or null for plain text
 * @returns Rows `{ kind, number, oldNo, newNo, text, hunk, spans }`; `number` is the new-file
 *   line for added and context rows and the old-file line for removed rows. Gap rows are kind "~".
 */
function diffRows(lines, lang) {
  let old = 0, next = 0, state = null, hunk = -1;
  return lines.map((line, i) => {
    if (typeof line !== "string") {
      const text = `↕  Show ${line.count} hidden line${line.count > 1 ? "s" : ""}`;
      return { kind: "~", gap: line.gap, count: line.count, text, hunk: -1, spans: [{ text, cls: "" }] };
    }
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
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const plain = (e) => !e.modifiers?.platform && !e.modifiers?.control && !e.modifiers?.alt && !e.modifiers?.function;

/** A PR comment as the diff shows it: at most 30 lines, the rest on GitHub. */
function clipBody(body) {
  const lines = body.split("\n");
  return lines.length > 30 ? `${lines.slice(0, 30).join("\n")}\n…` : body;
}

export class DiffTab {
  init(_props, cx) {
    this.space = props()?.space ?? null;
    this.path = null; this.back = []; this.fwd = [];
    this.lines = []; this.rows = []; this.index = new Map(); this.items = []; this.sizes = []; this.gutter = 30;
    this.diffWidth = 0; this.scrollX = 0; this.diffView = 0; this.width = 0; this.handle = cx.focus_handle();
    this.composer = null; this.noteText = ""; this.press = null; this.shiftHeld = false; this.boxAt = null;
    this.text = null; this.opened = new Set(); this.wholeFile = false; this.shownGenerated = new Set(); this.sinceOff = new Set();
    this.loadedKey = null; this.loading = false; this.message = null; this.placeholder = null;
    // PR threads: shown here whatever the panel's filters say (opened from the panel or just resolved),
    // waiting to be scrolled to, highlighted, and being resolved or reopened.
    this.keep = new Set(); this.seek = null; this.flash = null; this.resolving = new Set();
    this.scroll = VirtualListScrollHandle.new();
    this.note = TextareaState.new({ placeholder: "Leave a comment on these lines…", rows: 3 });
    this.note.set_auto_grow(3, 12);
    // Enter adds; shift-enter is the textarea's own newline, so its submit is ignored.
    this.note.on("submit", (e, cx) => { if (!e?.shift) this.addComment(cx); });
    this.note.on("change", (_e, cx) => { this.noteText = this.note.value(); if (this.composer?.editing) this.rebuild(); cx.notify(); });
    this.handle.focus();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "next") this.step(1, cx);
        else if (c === "prev") this.step(-1, cx);
        else if (c === "reviewed") this.toggleReviewed(cx);
        else if (c === "submit") this.submit(cx);
        cx.notify();
      }
    });
  }

  session() { return this.space ? (shared(SESSIONS) ?? {})[this.space] ?? null : null; }

  file(s = this.session()) { return s && this.path ? s.files.find((f) => f.path === this.path) ?? null : null; }

  /** Showing only what changed since the file was marked reviewed: the default once it changed. */
  since(s = this.session(), f = this.file(s)) { return Boolean(f) && reviewState(s, f) === "changed" && !this.sinceOff.has(f.path) && f.status !== "D" && reviewMark(s, f.path)?.sig !== "deleted"; }

  /** Everything the shown diff depends on; a change reloads it. */
  loadKey(s, f) {
    if (!s || !f) return `none:${this.path}`;
    return JSON.stringify([s.root, s.on, s.mode, s.scope?.id, s.diffArgs, f.path, f.sig, f.status, prefs().whitespace, this.since(s, f), f.generated && !this.shownGenerated.has(f.path)]);
  }

  // #region Navigation

  /** Shows a file; `remember` puts the one shown before on the back stack. */
  go(path, cx, remember = true) {
    if (!path || path === this.path) return;
    if (remember && this.path) { this.back.push(this.path); this.back = this.back.slice(-50); this.fwd = []; }
    if (this.composer && !this.noteText.trim()) this.composer = null;
    this.path = path; this.opened = new Set(); this.scrollX = 0; this.loadedKey = null; this.message = null; this.text = null;
    this.setLines([], null);
    this.scroll.scroll_to_item(0);
    setShared(CURRENT, { ...(shared(CURRENT) ?? {}), [this.space]: path });
    this.handle.focus();
    cx?.notify();
  }

  history(dir, cx) {
    const from = dir < 0 ? this.back : this.fwd, to = dir < 0 ? this.fwd : this.back, path = from.pop();
    if (!path) return;
    if (this.path) to.push(this.path);
    this.go(path, cx, false);
  }

  /** The next or previous file in the panel's order. */
  step(dir, cx) {
    const order = this.session()?.order ?? [], i = order.indexOf(this.path);
    const path = i < 0 ? order[0] : order[i + dir];
    if (path) this.go(path, cx);
  }

  /** Marks the shown file reviewed and moves to the next file that isn't, wrapping around. */
  reviewAndNext(cx) {
    const s = this.session(), f = this.file(s);
    if (!s || !f) return;
    cx.spawn(async (cx) => {
      if (reviewState(s, f) !== "done") await setReviewed(s, f, true);
      const order = s.order, i = order.indexOf(f.path);
      const rest = [...order.slice(i + 1), ...order.slice(0, Math.max(0, i))];
      const next = rest.find((p) => { const x = s.files.find((y) => y.path === p); return x && reviewState(s, x) !== "done"; });
      if (next) this.go(next, cx);
      else notify({ title: "Every file is reviewed", body: s.root.split("/").pop(), level: "success" });
      cx.notify();
    });
  }

  toggleReviewed(cx) {
    const s = this.session(), f = this.file(s);
    if (!s || !f) return;
    const done = reviewState(s, f) !== "done";
    cx.spawn(async (cx) => { await setReviewed(s, f, done); this.sinceOff.delete(f.path); cx.notify(); });
  }

  /** Requests from the panel (a clicked file, a whole-file comment); older than 30 s are ignored, so a restart doesn't replay one. */
  applyOpen(cx) {
    const req = shared(OPEN);
    if (!req || req.space !== this.space || req.id === this.applied || Date.now() - (req.at ?? 0) > 30000) return;
    this.applied = req.id;
    cx.timer.after(1, (cx) => {
      this.go(req.path, cx);
      if (req.comment) this.commentFile(cx);
      if (req.thread) { this.keep.add(req.thread); this.seek = { id: req.thread, at: Date.now() }; this.rebuild(); cx.notify(); }
    });
  }

  /** Keeps the tab's name on the repo it reviews. */
  /** Keeps the tab's name on the repo it reviews, and its tab-bar icon on the open file's type. */
  name(s) {
    const name = `Review · ${s.root.split("/").pop()}`;
    const tab = Object.entries(shared(TABS) ?? {}).find(([, v]) => v.space === this.space)?.[0];
    if (!tab) return;
    if (name !== this.named) { this.named = name; run("tab.rename", { id: tab, name }); }
    const icon = this.path ? fileIcon(this.path.split("/").pop(), settings().dark !== false) : null, icons = shared(TAB_ICONS) ?? {};
    if ((icons[tab] ?? null) !== icon) {
      const live = new Set(Object.keys(shared(TABS) ?? {}));
      setShared(TAB_ICONS, { ...Object.fromEntries(Object.entries(icons).filter(([id]) => live.has(id))), [tab]: icon });
    }
  }

  // #endregion

  // #region Loading

  load(cx) {
    const s = this.session(), f = this.file(s), key = this.loadKey(s, f);
    if (this.loading || key === this.loadedKey) return;
    this.loadedKey = key; this.placeholder = null;
    if (!s || !f) { this.setLines([], null); return; }
    if (f.generated && !this.shownGenerated.has(f.path)) { this.placeholder = "generated"; this.setLines([], null); return; }
    this.loading = true;
    const path = f.path, ws = prefs().whitespace ? ["-w"] : [];
    cx.spawn(async (cx) => {
      try {
        let lines, text = null;
        const since = this.since(s, f), end = s.mode === "turn" ? s.diffArgs[1] : null;
        if (f.status !== "D" && !f.binary) {
          text = end ? await git(s.root, s.on, ["show", `${end}:${path}`]).then((r) => r.code === 0 ? r.stdout : null).catch(() => null)
            : await readTextFile(`${s.root}/${path}`, { on: s.on }).catch(() => null);
          if (text?.includes("\0") || (text?.length ?? 0) > 2000000) text = null;
        }
        if (since) {
          const cur = await storeBlob(s, f), mark = reviewMark(s, path);
          const r = await git(s.root, s.on, ["diff", ...ws, "--no-ext-diff", "--no-color", mark.sig, cur]);
          lines = r.code === 0 ? this.hunkLines(r.stdout, "No changes since your review" + (ws.length ? " (ignoring whitespace)" : "")) : [`Your reviewed copy is gone (${r.stderr.trim()}); showing the full diff is still possible`];
        } else if (f.fresh) {
          if (text === null) lines = [f.binary ? "Binary file · no text diff" : "Cannot preview this file (binary, too large, or unreadable)"];
          else lines = [`@@ -0,0 +1,${text.split("\n").length} @@`, ...text.replace(/\n$/, "").split("\n").map((l) => `+${l}`)];
          text = null;
        } else {
          const r = await git(s.root, s.on, ["diff", ...s.diffArgs, ...ws, "--no-ext-diff", "--no-textconv", "--no-color", "--", path]);
          if (r.code !== 0) throw new Error(r.stderr);
          lines = this.hunkLines(r.stdout, f.binary ? "Binary file changed" : ws.length ? "Only whitespace changed" : "No text diff available");
        }
        if (this.loadKey(this.session(), this.file()) !== key) return;
        this.text = text;
        this.setLines(lines.slice(0, MAX_LINES).map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l), path);
        if (lines.length > MAX_LINES) this.message = `Showing the first ${MAX_LINES.toLocaleString()} diff lines`;
      } catch (e) {
        if (this.loadKey(this.session(), this.file()) === key) this.setLines([`Cannot preview this diff (too large or unreadable): ${String(e?.message ?? e).trim()}`], path);
      } finally { this.loading = false; cx.notify(); }
    });
  }

  hunkLines(stdout, none) {
    const all = stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    return first < 0 ? [none] : all.slice(first);
  }

  setLines(lines, path) {
    this.lines = lines; this.linesPath = path;
    this.layoutRows();
  }

  /** Rows from the loaded diff plus whatever hidden context is opened. */
  layoutRows() {
    const open = (k) => this.wholeFile || this.opened.has(k);
    const lines = withContext(this.lines, this.text, open).slice(0, MAX_ROWS);
    this.rows = diffRows(lines, languageOf(this.linesPath ?? ""));
    this.index = new Map();
    this.rows.forEach((r, i) => { const k = descKey(desc(r)); if (!this.index.has(k)) this.index.set(k, i); });
    const digits = String(Math.max(0, ...this.rows.map((r) => Math.max(r.oldNo ?? 0, r.newNo ?? 0)))).length;
    this.gutter = Math.max(30, Math.ceil(digits * charW() + 10));
    this.diffWidth = Math.max(0, ...lines.map((l) => typeof l === "string" ? l.replace(/\t/g, "    ").length : 0)) * charW() + 24;
    this.scrollX = Math.min(this.scrollX, this.maxScrollX());
    this.rebuild();
  }

  expandGap(gap, cx) { this.opened.add(gap); this.layoutRows(); cx.notify(); }

  setWholeFile(on, cx) { this.wholeFile = on; if (!on) this.opened = new Set(); this.layoutRows(); cx.notify(); }

  // #endregion

  // #region Horizontal scrolling

  /** Width of the line-number and sign columns, which stay put while the text scrolls sideways. */
  lead() { return this.gutter + SIGN_W + 2; }

  /** Width of the text area beside the gutter: one side of the split view, or the whole row. */
  visible() { return prefs().view === "split" ? (this.diffView - 1) / 2 - this.lead() : this.diffView - this.lead(); }

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
   * rows at its own width, so the tab offsets the text itself.
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

  // #region Comments

  comments() { return draftsOf(this.session()?.key); }

  setComments(list, cx) {
    setDrafts(this.session()?.key, list);
    this.rebuild();
    cx?.notify();
  }

  /** Where a row descriptor is in the shown diff, or -1. */
  at(d) { return d ? (this.index.get(descKey(d)) ?? -1) : -1; }

  /**
   * The list's items: diff rows (or side-by-side pairs), with each comment under its last
   * line. Whole-file comments, and comments whose lines aren't in this view, come first.
   * Comments already sent show too, until dismissed: open while their lines are unchanged,
   * outdated once they changed.
   */
  rebuild() {
    const split = prefs().view === "split", since = this.since();
    const base = split
      ? splitPairs(this.rows).map((p, j) => p.full !== undefined
        ? { key: `r:${p.full}`, kind: "row", i: p.full, rows: [p.full] }
        : { key: `p:${j}`, kind: "pair", l: p.l, r: p.r, rows: [p.l, p.r].filter((x) => x !== null) })
      : this.rows.map((_r, i) => ({ key: `r:${i}`, kind: "row", i, rows: [i] }));
    const pos = new Map();
    base.forEach((it, j) => it.rows.forEach((r) => pos.set(r, j)));
    const under = new Map(), top = [], editing = this.composer?.editing ?? null;
    /** Puts items under their last row; false when those rows aren't in this view. */
    const put = (items, from, to) => {
      const j = from < 0 || to < from ? -1 : Math.max(pos.get(from) ?? -1, pos.get(to) ?? -1);
      if (j < 0) return false;
      (under.get(j) ?? under.set(j, []).get(j)).push(...items.map((it) => ({ ...it, from, to })));
      return true;
    };
    const place = (it, c) => {
      if (c.whole) { top.push({ ...it, whole: true }); return; }
      if (!put([it], this.at(c.from), this.at(c.to)) && Boolean(c.since) === since) top.push({ ...it, detached: true });
    };
    if (this.rows.length) {
      for (const c of this.comments()) {
        if (c.path !== this.path) continue;
        const live = c.id === editing, text = live ? this.noteText : c.text;
        place({ key: `c:${c.id}`, kind: "comment", id: c.id, live, text, comment: c, height: this.commentHeight(text) }, c);
      }
      for (const round of historyOf(this.session()?.key)) {
        for (const c of round.comments) {
          if (c.path !== this.path || round.dismissed?.includes(c.id)) continue;
          place({ key: `s:${round.id}:${c.id}`, kind: "sent", at: round.at, text: c.text, comment: c, height: this.commentHeight(c.text) }, c);
        }
      }
      // A thread is two items, so a click on its header (where the buttons are) can be told
      // from one on its comments: the list reports only which item was clicked.
      for (const th of this.threadsHere()) {
        const items = [{ key: `g:${th.id}`, kind: "thread-head", thread: th, height: THREAD_HEAD }, { key: `gb:${th.id}`, kind: "thread-body", thread: th, height: this.threadHeight(th) }];
        const [from, to] = this.anchor(th);
        if (!put(items, from, to)) top.push(...items.map((it) => ({ ...it, detached: true })));
      }
    }
    this.items = [...top];
    base.forEach((it, j) => { this.items.push({ ...it, height: row() }); for (const c of under.get(j) ?? []) this.items.push(c); });
    // Room past the last line, so it can scroll clear of the shortcut hint and the horizontal bar.
    if (this.items.length) this.items.push({ key: "end", kind: "end", height: END_PAD });
    this.sizes = this.items.map((it) => it.height);
  }

  /** How many rows a comment's text wraps to at the card's width. */
  wrapped(text) {
    const cpl = Math.max(24, Math.floor(((this.diffView || 600) - this.lead() - 48) / charW()));
    return text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0);
  }

  commentHeight(text) { return 44 + this.wrapped(text) * 20; }

  /** The comments part of a thread card, under its header. */
  threadHeight(th) { return 18 + th.comments.reduce((h, c) => h + 22 + this.wrapped(clipBody(c.body)) * 20, 0); }

  /** The shown file's PR threads, by the panel's settings, plus any kept on screen here. */
  threadsHere() {
    const p = prefs();
    return (remoteOf(this.session()?.remote)?.threads ?? []).filter((th) => th.path === this.path
      && (this.keep.has(th.id) || (p.remoteInDiff && !(p.hideResolved && th.resolved))));
  }

  /**
   * A click on a thread's header: its Resolve and GitHub buttons sit at the right edge, and
   * clicks inside list items can only be told apart by where they landed.
   */
  clickThread(id, press, cx) {
    const s = this.session(), th = (remoteOf(s?.remote)?.threads ?? []).find((x) => x.id === id), x = press?.x;
    if (!s || !th || x === undefined) return;
    const right = this.diffView - CARD_PAD_R;
    if (x >= right - GITHUB_W && x <= right) { if (th.url) exec("open", [th.url]).catch(() => null); return; }
    if (x < right - GITHUB_W - 6 - RESOLVE_W || x > right - GITHUB_W - 6 || this.resolving.has(id)) return;
    this.resolving.add(id); this.keep.add(id);
    cx.spawn(async (cx) => {
      const error = await setThreadResolved(s.remote, s.root, s.on, id, !th.resolved);
      this.resolving.delete(id);
      if (error) notify({ title: th.resolved ? "Couldn't reopen the thread" : "Couldn't resolve the thread", body: error, level: "error" });
      cx.notify();
    });
    cx.notify();
  }

  /**
   * A PR thread's rows in the shown diff. GitHub numbers lines in the PR's head commit, so a
   * thread is only placed in the Branch view with that commit checked out; else [-1, -1].
   */
  anchor(th) {
    const s = this.session(), r = remoteOf(s?.remote);
    if (th.file || !th.line || th.outdated || s?.mode !== "base" || !r?.head || r.head !== s.head || this.since(s)) return [-1, -1];
    const left = th.side === "LEFT";
    const find = (n) => this.rows.findIndex((row) => left ? row.oldNo === n && row.kind !== "+" : row.newNo === n && row.kind !== "-");
    const to = find(th.line), from = th.start && th.start !== th.line ? find(th.start) : to;
    return from < 0 ? [to, to] : [from, to];
  }

  /** The comment box's target rows in the shown diff, or null (also for a whole-file comment). */
  target() {
    if (!this.composer || this.composer.whole || this.composer.path !== this.path) return null;
    const from = this.at(this.composer.from), to = this.at(this.composer.to);
    return from < 0 || to < 0 ? null : { from: Math.min(from, to), to: Math.max(from, to) };
  }

  /** A click on a list item; the press before it says which split side and whether shift was held. */
  clickItem(k, cx) {
    const press = this.press;
    this.press = null;
    // The box opens beside where the click landed; the list's scroll offset can't be read.
    this.boxAt = press?.y !== undefined ? { y: press.y, h: press.h } : null;
    if (k.startsWith("g:")) { this.clickThread(k.slice(2), press, cx); return; }
    if (k === "end" || k.startsWith("gb:")) return;
    if (k.startsWith("c:")) { if (k.slice(2) !== this.composer?.editing) this.editComment(k.slice(2), cx); return; }
    if (k.startsWith("s:")) { const [, round, id] = k.split(":"); dismissSent(this.session()?.key, round, id); return; }
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
   * A hidden-lines row opens those lines instead.
   */
  clickRow(i, extend, cx) {
    const row = this.rows[i];
    if (!row || row.kind === "") return;
    if (row.kind === "~") { this.expandGap(row.gap, cx); return; }
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
    const editing = this.composer?.editing && !this.composer.whole && this.composer.path === this.path ? this.composer.editing : null;
    this.composer = { path: this.path, from: desc(this.rows[from]), to: desc(this.rows[to]), editing };
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

  /** Comments on the shown file as a whole (an image, a deleted file, anything without lines to click). */
  commentFile(cx) {
    if (!this.path) return;
    if (this.composer?.whole && this.composer.path === this.path && !this.composer.editing && !this.noteText.trim()) { this.closeComposer(cx); return; }
    this.composer = { path: this.path, whole: true, editing: null }; this.boxAt = null;
    this.openBox(cx, 0);
  }

  editComment(id, cx) {
    const c = this.comments().find((c) => c.id === id);
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
    const all = this.comments(), old = c.editing ? all.find((x) => x.id === c.editing) : null;
    const comment = c.whole ? { id: c.editing ?? uid(), path: c.path, whole: true, text } : { id: c.editing ?? uid(), path: c.path, from: c.from, to: c.to, text };
    const t = this.target();
    // The quoted lines go with the comment, so it is still sent with what was reviewed after the code moves.
    if (t) {
      comment.from = desc(this.rows[t.from]); comment.to = desc(this.rows[t.to]);
      comment.quote = this.quote(this.rows.slice(t.from, Math.min(t.to, t.from + 60) + 1));
      if (this.since()) comment.since = true;
    } else if (old) { if (old.quote) comment.quote = old.quote; if (old.since) comment.since = true; }
    this.setComments([...all.filter((x) => x.id !== c.editing), comment]);
    this.closeComposer(cx);
  }

  deleteComment(cx) {
    const id = this.composer?.editing;
    if (id) this.setComments(this.comments().filter((c) => c.id !== id));
    this.closeComposer(cx);
  }

  /** The text the agent gets for a set of rows. */
  quote(rows) {
    return rows.map((r) => r.kind === "@" ? r.text : r.kind === "~" ? `      … ${r.count} unchanged lines` : `${r.number === undefined ? "" : String(r.number).padStart(5)} ${r.kind || " "} ${r.text}`).join("\n");
  }

  span(rows) {
    const nums = rows.filter((r) => r.number !== undefined && r.kind !== "-").map((r) => r.number), olds = rows.filter((r) => r.kind === "-").map((r) => r.number);
    const range = (a) => a.length > 1 ? `lines ${Math.min(...a)}-${Math.max(...a)}` : `line ${a[0]}`;
    return nums.length ? range(nums) : olds.length ? `removed ${range(olds)}` : "";
  }

  askAbout(indexes, cx) {
    const s = this.session();
    if (!s || !this.path || !this.rows.length) return;
    const rows = (indexes ? [...indexes].sort((a, b) => a - b).map((i) => this.rows[i]) : this.rows).filter((r) => r && r.kind !== "~").slice(0, 400);
    const span = this.span(rows), title = `${this.path}${span ? `:${span.replace(/^(removed )?lines? /, "")}` : ""}`;
    const words = this.since() ? "the changes since the last review" : s.scope?.words ?? "the shown changes";
    const head = indexes ? `In ${where(s, this.path)}, ${span || "these lines"} of the diff (${words}; new-file line numbers; - lines are removed):` : `The diff of ${where(s, this.path)} (${words}):`;
    const lines = indexes ? { new: rows.filter((r) => r.newNo !== undefined).map((r) => r.newNo), old: rows.filter((r) => r.oldNo !== undefined).map((r) => r.oldNo) } : null;
    ask({ title, context: `${head}\n${this.quote(rows)}`, agent: s.agent, remote: remoteItems(s.remote, { path: this.path, lines }) });
    cx.notify();
  }

  submit(cx) {
    const s = this.session(), list = this.comments();
    if (s) submitReview(s, list);
    cx.notify();
  }

  // #endregion

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

  card(it, t) {
    const c = it.comment, rows = it.from !== undefined ? [this.rows[it.from], this.rows[it.to]] : null;
    const span = c.whole ? "whole file" : rows ? (it.from === it.to ? `line ${rows[0].number}` : `lines ${rows[0].number}–${rows[1].number}`) : c.from.number === c.to.number ? `line ${c.from.number}` : `lines ${c.from.number}–${c.to.number}`;
    let label, border, color;
    if (it.kind === "sent") {
      const outdated = it.detached;
      label = `Sent ${ago(it.at)} · ${span} · ${outdated ? "outdated: these lines changed" : "lines unchanged"} · click to dismiss`;
      border = outdated ? t.border : t.blocked + "88"; color = outdated ? t.dim : t.blocked;
    } else {
      label = `Comment · ${span}${it.detached ? " · these lines aren't in this view" : ""} · ${it.live ? "editing" : "click to edit"}`;
      border = it.live ? t.accent : t.accent + "66"; color = it.live ? t.accent : t.dim;
    }
    return div().w_full().h(it.height).flex_none().pl(this.lead()).pr(12).py(4).cursor_pointer()
      .child(v_flex().rounded(8).border_1().border_color(border).bg(t.surface).px(10).py(6).gap(3).when(it.kind === "sent", (e) => e.opacity(0.85))
        .child(div().text_size(12).text_color(color).truncate().child(label))
        .child(div().text_size(font()).whitespace_normal().text_color(it.text ? t.foreground : t.dim).child(it.text || "(empty)")));
  }

  /** A PR thread's border color: highlighted when just opened from the panel, accented while open. */
  threadBorder(th, t) {
    const accent = t.ansi5 ?? t.accent;
    return this.flash === th.id ? accent : th.resolved ? t.border : accent + "88";
  }

  /** A PR thread card's header: where it is, whether it's open, and its Resolve and GitHub buttons. */
  threadHead(it, t) {
    const th = it.thread, status = threadStatus(th), accent = t.ansi5 ?? t.accent, busy = this.resolving.has(th.id);
    const away = it.detached && !th.file && th.line ? " · not on these lines in this view" : "";
    const pill = (w, label, strong) => div().w(w).h(24).flex_none().flex().items_center().justify_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(strong ? accent : t.input).text_color(strong ? accent : t.muted).hover((st) => st.bg(t.hover)).child(label);
    return div().w_full().h(it.height).flex_none().pl(this.lead()).pr(12).pt(4)
      .child(h_flex().h_full().pl(10).pr(CARD_PAD_R - 12).gap(6).items_center().rounded_t(8).border_t(this.flash === th.id ? 2 : 1).border_x(this.flash === th.id ? 2 : 1)
        .border_color(this.threadBorder(th, t)).bg(t.surface).when(th.resolved, (e) => e.opacity(0.75))
        .child(svg(`mods/${MOD}/pr.svg`).size(13).flex_none().text_color(th.resolved ? t.dim : accent))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(th.resolved ? t.dim : accent).child(`PR thread · ${threadSpan(th)} · ${status}${away}`))
        .child(pill(RESOLVE_W, busy ? "…" : th.resolved ? "Reopen" : "Resolve", !th.resolved && !busy))
        .child(pill(GITHUB_W, "GitHub", false)));
  }

  /** A PR thread card's comments, each with its author. */
  threadBody(it, t) {
    const th = it.thread, wide = this.flash === th.id ? 2 : 1;
    return div().w_full().h(it.height).flex_none().pl(this.lead()).pr(12).pb(4)
      .child(v_flex().h_full().overflow_hidden().rounded_b(8).border_b(wide).border_x(wide).border_color(this.threadBorder(th, t)).bg(t.surface).px(10).pb(6).gap(3)
        .when(th.resolved, (e) => e.opacity(0.75))
        .children(th.comments.map((c) => v_flex().gap(0)
          .child(div().h(18).text_size(12).text_color(t.muted).truncate().child(`@${c.author} · ${ago(c.at)}`))
          .child(div().text_size(font()).whitespace_normal().text_color(t.foreground).child(clipBody(c.body))))));
  }

  item(it, t, colors, target, commented) {
    if (it.kind === "end") return div().w_full().h(it.height).flex_none();
    if (it.kind === "thread-head") return this.threadHead(it, t);
    if (it.kind === "thread-body") return this.threadBody(it, t);
    if (it.kind === "comment" || it.kind === "sent") return this.card(it, t);
    if (it.kind === "pair") {
      return h_flex().w_full().h(row()).flex_none().cursor_pointer()
        .child(this.line(it.l, "l", t, colors, target, commented))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(this.line(it.r, "r", t, colors, target, commented));
    }
    const r = this.rows[it.i];
    if (r.kind === "~") {
      return h_flex().w_full().h(row()).flex_none().items_center().cursor_pointer().bg(t.accent + "14").text_color(t.accent).text_size(13)
        .child(div().w(this.lead()).flex_none()).child(div().flex_none().whitespace_nowrap().child(r.text));
    }
    if (r.kind === "@") {
      const on = Boolean(target) && it.i >= target.from - 1 && it.i <= target.to && this.rows[target.from]?.hunk === it.i && this.rows[target.to]?.hunk === it.i;
      return h_flex().w_full().h(row()).flex_none().items_center().overflow_hidden().cursor_pointer().bg(t.raised).border_l(2).border_color(on ? t.accent : NONE)
        .child(div().w(this.lead() - 2).flex_none())
        .child(h_flex().flex_1().min_w(0).overflow_hidden().child(div().flex_none().relative().left(-this.scrollX).whitespace_nowrap().text_color(t.dim).child(r.text)));
    }
    return h_flex().w_full().h(row()).flex_none().cursor_pointer().child(this.line(it.i, "u", t, colors, target, commented));
  }

  // #endregion

  // #region Chrome

  /** The comment box: a card floating just under the clicked line (above it near the bottom), centered. */
  box(t, target) {
    const s = this.session(), c = this.composer, editing = Boolean(c.editing);
    const where = c.whole ? `whole file (${describe(s, c.path)})` : target ? (target.from === target.to ? `line ${this.rows[target.from].number ?? ""}` : `lines ${this.rows[target.from].number}–${this.rows[target.to].number}`) : "those lines are no longer in the diff";
    // Every press inside the box stops here: the box floats over the list, and a click that
    // fell through to the row underneath would reopen the box the moment Add closed it.
    const stop = (action) => (e, cx) => { cx.stop_propagation(); action(e, cx); };
    const button = (id, label, action) => div().id(id).h(28).px(12).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(13).font_medium().cursor_pointer().hover((st) => st.opacity(0.88)).on_click(stop(action)).child(label);
    const link = (id, label, color, action) => div().id(id).h(28).px(8).flex().items_center().rounded(6).text_size(13).text_color(color).cursor_pointer().hover((st) => st.bg(t.hover)).on_click(stop(action)).child(label);
    const existing = editing ? this.comments().find((x) => x.id === c.editing) : null;
    const w = Math.min(560, Math.max(240, this.diffView - 24)), left = Math.max(8, (this.diffView - w) / 2), at = this.boxAt;
    // The box can't be measured, so its height is estimated (textarea growth, wrapped buttons).
    // Above the line it is pinned by its bottom edge, so the estimate only decides the side.
    const typed = Math.min(12, Math.max(3, this.noteText.split("\n").length)) - 3;
    const est = BOX_H + typed * 20 + (w < 420 ? 34 : 0);
    let place = { top: 12 };
    if (at?.y !== undefined) {
      const below = at.y + row() / 2 + 6, aboveEdge = at.y - row() / 2 - 6;
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
        .child(div().id("comment-close").size(22).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click(stop((_e, cx) => this.closeComposer(cx))).child("×")))
      .child(div().w_full().child(Textarea.new(this.note).w_full().px(8).py(6).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(14).text_color(t.foreground)))
      .child(h_flex().items_center().gap(6).flex_wrap()
        .child(button("comment-add", editing ? "Save" : "Add comment", (_e, cx) => this.addComment(cx)))
        .child(link("comment-cancel", "Cancel", t.dim, (_e, cx) => this.closeComposer(cx)))
        .when(Boolean(existing), (e) => e.child(link("comment-copy", "Copy", t.dim, (_e, cx) => { cx.write_to_clipboard(existing.text); })))
        .child(div().flex_1())
        .when(editing, (e) => e.child(link("comment-delete", "Delete", t.ansi1, (_e, cx) => this.deleteComment(cx))))
        .when(!editing && !c.whole, (e) => e.child(div().text_size(12).text_color(t.dim).child("shift-click extends"))));
  }

  /** File, position in the list, navigation and the reviewed controls. */
  topBar(t, s, f) {
    const order = s?.order ?? [], i = order.indexOf(this.path), state = f ? reviewState(s, f) : "none";
    const icon = (id, label, enabled, action) => div().id(id).h(28).min_w(28).px(6).flex().flex_none().items_center().justify_center().rounded(6).text_size(14)
      .text_color(enabled ? t.muted : t.dim).when(!enabled, (e) => e.opacity(0.4))
      .when(enabled, (e) => e.cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click(action)).child(label);
    const parts = (this.path ?? "").split("/"), name = parts.pop(), target = f ? fileTarget(s, f) : null;
    const tool = (id, file, tip, action) => div().id(id).size(28).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(svg(`mods/${MOD}/${file}.svg`).size(15));
    return h_flex().flex_none().h(44).px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(icon("hist-back", "←", this.back.length > 0, (_e, cx) => this.history(-1, cx)))
      .child(icon("hist-fwd", "→", this.fwd.length > 0, (_e, cx) => this.history(1, cx)))
      .child(div().w(1).h(18).mx(2).bg(t.border))
      .when(Boolean(f), (e) => e.child(div().w(14).flex_none().text_size(13).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status)))
      .when(Boolean(this.path), (e) => e.child(image(fileIcon(this.path.split("/").pop(), settings().dark !== false)).size(18).flex_none()))
      .child(h_flex().id("file-path").flex_1().min_w(0).text_size(15)
        .when(Boolean(target), (e) => e.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openFileMenu(target); }))
        .child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : ""))
        .child(div().flex_none().max_w("70%").truncate().font_medium().child(name ?? "")))
      .when(Boolean(target) && !target.on && target.status !== "D", (e) => e.child(tool("file-code", "code", "Open in VS Code (o)", () => openInCode(target))))
      .when(Boolean(target), (e) => e.child(tool("file-actions", "ellipsis", "File actions", () => openFileMenu(target))))
      .when(Boolean(f), (e) => e
        .when(f.add > 0, (el) => el.child(div().text_size(13).text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (el) => el.child(div().text_size(13).text_color(t.ansi1).child(`−${f.del}`))))
      .when(i >= 0, (e) => e.child(div().flex_none().px(4).text_size(13).text_color(t.dim).child(`${i + 1} of ${order.length}`)))
      .child(icon("file-prev", "‹", i > 0, (_e, cx) => this.step(-1, cx)))
      .child(icon("file-next", "›", i >= 0 && i < order.length - 1, (_e, cx) => this.step(1, cx)))
      .when(Boolean(f), (e) => e
        .child(h_flex().id("viewed").h(28).px(8).gap(6).flex_none().items_center().rounded(6).border_1().cursor_pointer().text_size(13)
          .border_color(state === "done" ? t.ansi2 : state === "changed" ? t.blocked : t.input).text_color(state === "done" ? t.ansi2 : state === "changed" ? t.blocked : t.muted)
          .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.toggleReviewed(cx))
          .child(state === "done" ? "✓ Reviewed" : state === "changed" ? "Changed · mark again" : "Mark reviewed"))
        .child(div().id("review-next").h(28).px(10).flex().flex_none().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(13).font_medium()
          .cursor_pointer().hover((st) => st.opacity(0.88)).on_click((_e, cx) => this.reviewAndNext(cx)).child("Reviewed & next")));
  }

  /** View options, then Submit review (with drafts) or Ask about diff. */
  toolbar(t, s) {
    const p = prefs(), n = draftsOf(s?.key).length, canAsk = Boolean(this.path && this.rows.length);
    const seg = (id, label, on, action) => div().id(id).h(24).px(10).flex().items_center().rounded(5).text_size(13).cursor_pointer()
      .when(on, (e) => e.bg(t.background).text_color(t.foreground))
      .when(!on, (e) => e.text_color(t.muted).hover((st) => st.text_color(t.foreground)))
      .on_click(action).child(label);
    const toggle = (id, label, on, action) => h_flex().id(id).h(28).px(8).gap(6).items_center().rounded(6).text_size(13).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click(action).child(label);
    const button = (id, label, primary, action) => div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(6).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(13).font_medium().cursor_pointer().hover((st) => st.opacity(0.88)).on_click(action).child(label);
    const mode = MODES.find((m) => m.id === s?.mode)?.label;
    return h_flex().flex_none().h(40).px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.raised)
        .child(seg("view-unified", "Unified", p.view !== "split", (_e, cx) => this.setView("unified", cx)))
        .child(seg("view-split", "Split", p.view === "split", (_e, cx) => this.setView("split", cx))))
      .child(toggle("whole-file", "Whole file", this.wholeFile, (_e, cx) => this.setWholeFile(!this.wholeFile, cx)))
      .child(toggle("whitespace", "Ignore whitespace", p.whitespace, () => setPref("whitespace", !p.whitespace)))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.dim).child([mode, s?.label].filter(Boolean).join(" · ")))
      .when(n > 0, (e) => e
        .child(div().id("review-discard").h(26).px(8).flex().items_center().rounded(6).text_size(13).text_color(t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.setComments([], cx)).child("Discard"))
        .child(button("review-submit", `Submit review · ${n}`, true, (_e, cx) => this.submit(cx))))
      .when(n === 0 && canAsk, (e) => e.child(button("ask", "Ask about diff", false, (_e, cx) => this.askAbout(null, cx))))
      .when(n === 0 && Boolean(s), (e) => e.child(button("review-send", "Send review", false, (_e, cx) => this.submit(cx))));
  }

  /**
   * Scrolls to the PR thread the panel asked for once the file's rows are in, and highlights it
   * for a moment. Gives up after 5 s (the file can't be shown, or the thread isn't on it).
   */
  seekThread(s, cx) {
    if (!this.seek) return;
    const id = this.seek.id, idx = this.items.findIndex((it) => it.key === `g:${id}`);
    if (idx < 0) { if (Date.now() - this.seek.at > 5000) this.seek = null; else cx.timer.after(250, (cx) => cx.notify()); return; }
    this.seek = null; this.flash = id;
    cx.timer.after(1, () => this.scroll.scroll_to_item(idx, "center"));
    cx.timer.after(1800, (cx) => { if (this.flash === id) { this.flash = null; cx.notify(); } });
  }

  setView(view, cx) {
    if (view === prefs().view) return;
    setPref("view", view);
    this.scrollX = 0;
    cx.timer.after(1, (cx) => { this.rebuild(); cx.notify(); });
  }

  /** When the file changed after it was marked reviewed: which diff is shown, and the way to the other. */
  sinceBanner(t, s, f) {
    if (!f || reviewState(s, f) !== "changed" || f.status === "D") return null;
    const mark = reviewMark(s, f.path), on = this.since(s, f);
    return h_flex().flex_none().h(36).px(12).gap(8).items_center().bg(t.blocked + "1f").border_b(1).border_color(t.border).text_size(13)
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(on ? `Changed since you reviewed it ${ago(mark.at)} · showing only what changed since` : `Changed since you reviewed it ${ago(mark.at)} · showing the full diff`))
      .child(div().id("since-toggle").h(26).px(8).flex().items_center().rounded(6).text_color(t.accent).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { if (on) this.sinceOff.add(f.path); else this.sinceOff.delete(f.path); cx.notify(); })
        .child(on ? "Show full diff" : "Show changes since review"));
  }

  /** Single-key shortcuts; never while the comment box is open, since its textarea has the keys. */
  key(e, cx) {
    if (e.key === "escape" && this.composer) { this.closeComposer(cx); cx.stop_propagation(); return; }
    if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control) && this.composer) { this.addComment(cx); cx.stop_propagation(); return; }
    if (this.composer || !plain(e)) return;
    const k = e.key, shift = e.modifiers?.shift, s = this.session(), f = this.file(s);
    const act = {
      o: () => { if (f && !s.on && f.status !== "D") openInCode(fileTarget(s, f)); },
      n: () => this.step(1, cx), j: () => this.step(1, cx), p: () => this.step(-1, cx), k: () => this.step(-1, cx),
      v: () => this.toggleReviewed(cx), r: () => this.reviewAndNext(cx), c: () => this.commentFile(cx),
      s: () => this.setView(prefs().view === "split" ? "unified" : "split", cx), e: () => this.setWholeFile(!this.wholeFile, cx),
      w: () => setPref("whitespace", !prefs().whitespace), "[": () => this.history(-1, cx), "]": () => this.history(1, cx),
    }[shift ? "" : k];
    if (!act) return;
    act(); cx.stop_propagation(); cx.notify();
  }

  // #endregion

  render(cx) {
    if (pendingSent()) cx.timer.after(1, () => settlePending());
    this.applyOpen(cx);
    const s = this.session();
    if (s) cx.timer.after(1, () => this.name(s));
    if (!this.path && s?.order.length) {
      const last = (shared(CURRENT) ?? {})[this.space];
      cx.timer.after(1, (cx) => { if (!this.path) this.go(s.order.includes(last) ? last : s.order[0], cx, false); });
    }
    const f = this.file(s);
    if (this.loadKey(s, f) !== this.loadedKey) this.load(cx);
    // Drafts and sent reviews change from other copies (the panel's Discard, a send).
    if (font() !== this.fontSize) { this.fontSize = font(); this.layoutRows(); }
    const remote = remoteOf(s?.remote);
    const stamp = JSON.stringify([draftsOf(s?.key).filter((c) => c.path === this.path), historyOf(s?.key).map((r) => r.dismissed?.length ?? 0), historyOf(s?.key).length, prefs().view, font(),
      remote?.at ?? null, remote?.rev ?? null, s?.head ?? null, s?.mode ?? null, prefs().remoteInDiff, prefs().hideResolved]);
    if (stamp !== this.stamp) { this.stamp = stamp; this.rebuild(); }
    this.seekThread(s, cx);
    const t = theme(), colors = palette("theme", t), target = this.target();
    const commented = new Set();
    for (const it of this.items) if (it.kind === "comment" && it.from !== undefined) for (let j = it.from; j <= it.to; j++) commented.add(j);
    const generated = this.placeholder === "generated";
    const missing = s && this.path && !f;

    const diffArea = div().id("changes-diff-area").flex_1().min_h(0).relative().overflow_hidden().font_family(family()).text_size(font())
      .on_scroll_wheel((e, cx) => this.scrollDiff(e, cx))
      .on_mouse_down("left", (e) => {
        const z = zoom(), l = e.local_position;
        this.press = { x: (l?.x ?? 0) / z, y: l ? l.y / z : undefined, h: e.bounds ? e.bounds.height / z : undefined, shift: e.modifiers.shift };
      })
      .child(v_virtual_list("changes-diff", this.items.length, this.sizes.length ? this.sizes : row(), (i) => this.items[i].key,
        (range) => this.items.slice(range.start, range.end).map((it) => this.item(it, t, colors, target, commented))).size_full().track_scroll(this.scroll)
        .on_item_click((k, cx) => this.clickItem(k, cx))
        .on_item_secondary_click((k, _e, cx) => {
          if (k.startsWith("g:") || k.startsWith("gb:")) {
            const id = k.slice(k.indexOf(":") + 1), url = (remote?.threads ?? []).find((th) => th.id === id)?.url;
            if (url) exec("open", [url]).catch(() => null);
            return;
          }
          if (!k.startsWith("r:") && !k.startsWith("p:")) return;
          const it = this.items.find((x) => x.key === k), i = it?.kind === "pair" ? it.r ?? it.l : it?.i, r = this.rows[i];
          if (!r || r.kind === "" || r.kind === "~") return;
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
      .when(!s, (e) => e.child(div().absolute().top(16).px(16).text_color(t.dim).text_size(15).child("Open the Review panel and pick a file to review")))
      .when(Boolean(missing), (e) => e.child(div().absolute().top(16).px(16).text_color(t.dim).text_size(15).child(`${this.path} has no changes in this view`)))
      .when(generated && Boolean(f), (e) => e.child(v_flex().absolute().top(16).px(16).gap(10).text_size(15)
        .child(div().text_color(t.muted).child(`Generated file (a lockfile or marked linguist-generated) · +${f.add} −${f.del}`))
        .child(div().id("show-generated").h(30).px(12).flex().items_center().self_start().rounded(7).bg(t.raised).cursor_pointer().hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.shownGenerated.add(f.path); cx.notify(); }).child("Show diff"))))
      .when(Boolean(f && this.rows.length) && !this.composer && !generated, (e) => e.child(div().absolute().bottom(16).right(14).px(8).py(3).rounded(6).bg(t.raised + "e0").text_size(12).text_color(t.dim)
        .child("click a line to comment · right-click to ask · n/p files · v reviewed · r reviewed & next · c file comment · o VS Code · s split · e whole file · w whitespace")))
      .when(Boolean(this.composer), (e) => e.child(this.box(t, target)));

    // Mouse moves arrive only while the pointer is over the tab, so leaving it ends a drag.
    return v_flex().id("review-diff")
      .on_mouse_move((e, cx) => this.drag(e, cx)).on_mouse_up("left", (_e, cx) => this.endDrag(cx)).on_hover((over, cx) => { if (!over) this.endDrag(cx); })
      .on_mouse_down("left", () => { if (!this.composer) this.handle.focus(); })
      .on_modifiers_changed((e) => { this.shiftHeld = e.modifiers.shift; })
      .on_size_change((size, cx) => {
        const width = size.width / zoom(), resized = width !== this.width;
        this.width = width; this.diffView = Math.max(0, width); this.scrollX = Math.min(this.scrollX, this.maxScrollX());
        if (resized) this.rebuild();
        cx.notify();
      })
      .size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(15).track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(this.topBar(t, s, f))
      .child(this.toolbar(t, s))
      .when(Boolean(this.sinceBanner(t, s, f)), (e) => e.child(this.sinceBanner(t, s, f)))
      .child(diffArea)
      .when(Boolean(this.message), (e) => e.child(div().px(12).py(4).text_size(13).text_color(t.dim).child(this.message)));
  }
}
