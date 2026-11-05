// Pending Taskwarrior tasks, most urgent first. Click a task to show its annotations
// and the rest of its metadata. Props: { filter: "<extra task filter>" } (optional).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { exec, props, theme, notify, watchFolder } from "herdr";

const RC = ["rc.verbose:nothing", "rc.confirmation:off", "rc.hooks:off", "rc.gc:0"];
const FALLBACK_REFRESH_MS = 5 * 60 * 1000;
const CLOCK_MS = 60 * 1000;
const URL_RE = /https?:\/\/[^\s<>()"']+/g;

/** Keys rendered in the row itself or in the fixed part of the details; anything else shows as extra metadata. */
const KNOWN = new Set(["id", "uuid", "description", "status", "project", "priority", "tags", "annotations",
  "urgency", "entry", "modified", "due", "scheduled", "wait", "until", "start", "end", "depends", "reviewed", "recur", "parent", "mask", "imask"]);

/**
 * Parses Taskwarrior's compact UTC timestamp (20260612T230742Z).
 * @param s Timestamp as exported by `task export`
 * @returns Epoch milliseconds, or NaN when `s` is not a Taskwarrior date
 */
function twDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s ?? "");
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/**
 * Formats a span of milliseconds as a compact duration ("45m", "3h", "12d", "4mo", "2y").
 * @param ms Duration; the sign is ignored
 * @returns Compact duration string
 */
function span(ms) {
  const mins = Math.abs(ms) / 60000;
  if (mins < 60) return `${Math.floor(mins)}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  if (mins < 43200) return `${Math.floor(mins / 1440)}d`;
  if (mins < 525600) return `${Math.floor(mins / 43200)}mo`;
  return `${Math.floor(mins / 525600)}y`;
}

/**
 * Formats a Taskwarrior timestamp as a local calendar date with its distance from now.
 * @param s Taskwarrior timestamp
 * @returns "2026-06-12 (4mo ago)", or the input unchanged when it is not a date
 */
function when(s) {
  const t = twDate(s);
  if (Number.isNaN(t)) return String(s);
  const d = new Date(t);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const diff = t - Date.now();
  return `${ymd} (${diff >= 0 ? `in ${span(diff)}` : `${span(diff)} ago`})`;
}

/**
 * Splits text into plain and URL segments so links can be drawn and opened separately.
 * @param text Annotation or description text
 * @returns Segments in order, each `{ text, url }` where `url` is set for links
 */
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], url: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * Escapes text for literal display inside HTML.
 * @param s Raw text
 * @returns Text with HTML-significant characters replaced by entities
 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Renders text as HTML with its URLs as links. HTML rather than Markdown so task text
 * containing `*`, `_` or `#` displays literally.
 * @param text Annotation, description or metadata value
 * @returns HTML fragment
 */
function toHtml(text) {
  return linkify(text).map((p) => p.url
    ? `<a href="${escapeHtml(p.url)}">${escapeHtml(p.text)}</a>`
    : escapeHtml(p.text)).join("");
}

export default class Taskwarrior extends View {
  init(_props, cx) {
    this.extraFilter = props()?.filter ?? "";
    this.tasks = [];
    this.expanded = new Set();
    this.project = null;
    this.showWaiting = false;
    this.filter = "";
    this.loading = false;
    this.error = null;
    this.signature = null;
    this.input = InputState.new({ placeholder: "Filter by text, #id, project, +tag, or annotation…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.busy = null;
    this.confirmDone = null;
    this.annotating = null;
    this.note = InputState.new({ placeholder: "Add an annotation…" });
    this.note.on("submit", (_e, cx) => this.annotate(cx));
    this.refresh(cx);
    this.watch(cx);
    cx.timer.every(FALLBACK_REFRESH_MS, (cx) => this.refresh(cx));
    cx.timer.every(CLOCK_MS, (cx) => cx.notify());
  }

  /**
   * Refreshes whenever the task database changes. Reading the database also touches its
   * SQLite -shm/-wal files, so events only count when the database or WAL size/mtime moved.
   */
  watch(cx) {
    cx.spawn(async (cx) => {
      let dir;
      try {
        dir = (await exec("task", [...RC, "_get", "rc.data.location"])).stdout.trim();
      } catch {
        return;
      }
      if (!dir) return;
      for (;;) {
        try {
          await watchFolder(dir);
          const sig = (await exec("sh", ["-c", 'stat -f "%m %z" "$1"/*.sqlite3 2>/dev/null; stat -f "%z" "$1"/*.sqlite3-wal 2>/dev/null', "sh", dir])).stdout;
          if (sig !== this.signature) {
            this.signature = sig;
            this.refresh(cx);
          }
        } catch {
          return;
        }
      }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const filter = this.extraFilter ? ["(", ...this.extraFilter.split(/\s+/), ")"] : [];
        const r = await exec("task", [...RC, ...filter, "status:pending", "export"]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `task export exited ${r.code}`);
        this.tasks = JSON.parse(r.stdout || "[]").sort((a, b) => b.urgency - a.urgency);
        this.error = null;
        this.loadedAt = Date.now();
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  /**
   * Runs a modifying `task` command against one task by UUID (IDs renumber as tasks complete),
   * then reloads. Hooks stay enabled here so the user's on-modify hooks still see the change.
   * @param task Task to modify
   * @param args Command and its arguments, e.g. ["done"] or ["annotate", "--", text]
   * @param verb Past-tense label for the confirmation toast
   */
  act(cx, task, args, verb) {
    if (this.busy) return;
    this.busy = task.uuid;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("task", ["rc.verbose:nothing", "rc.confirmation:off", task.uuid, ...args]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `task ${args[0]} exited ${r.code}`);
        notify({ title: `${verb} #${task.id}`, body: task.description, level: "info", timeout: 4000 });
        if (args[0] === "done") this.expanded.delete(task.uuid);
      } catch (e) {
        notify({ title: `Couldn't ${args[0]} #${task.id}`, body: String(e?.message ?? e), level: "error" });
      } finally {
        this.busy = null;
        this.confirmDone = null;
        this.refresh(cx);
      }
    });
  }

  annotate(cx) {
    const task = this.tasks.find((x) => x.uuid === this.annotating);
    const text = this.note.value().trim();
    if (!task || !text) return;
    this.annotating = null;
    this.note.set_value("");
    this.act(cx, task, ["annotate", "--", text], "Annotated");
  }

  actionButton(t, id, label, color, action) {
    return div().id(id).px(8).h(24).flex().flex_none().items_center().rounded(6).text_size(13)
      .border_1().border_color(t.border).bg(t.surface).text_color(color)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); })
      .child(label);
  }

  actions(t, task) {
    const id = task.uuid;
    if (this.busy === id) return div().text_size(13).text_color(t.dim).child("Working…");
    const confirming = this.confirmDone === id;
    return v_flex().gap(6)
      .child(h_flex().gap(5).flex_wrap()
        .child(task.start
          ? this.actionButton(t, `stop-${id}`, "Stop", t.muted, (cx) => this.act(cx, task, ["stop"], "Stopped"))
          : this.actionButton(t, `start-${id}`, "Start", t.working, (cx) => this.act(cx, task, ["start"], "Started")))
        .child(this.actionButton(t, `annotate-${id}`, this.annotating === id ? "Cancel note" : "Annotate", t.muted, () => {
          this.annotating = this.annotating === id ? null : id;
          this.note.set_value("");
          if (this.annotating) this.note.focus();
        }))
        .child(this.actionButton(t, `done-${id}`, confirming ? "Confirm done" : "Done", confirming ? t.accent_foreground : t.idle,
          (cx) => { if (confirming) this.act(cx, task, ["done"], "Completed"); else this.confirmDone = id; })
          .when(confirming, (el) => el.bg(t.accent).border_color(t.accent).hover((s) => s.bg(t.accent))))
        .when(confirming, (el) => el.child(this.actionButton(t, `done-cancel-${id}`, "Keep", t.muted, () => { this.confirmDone = null; }))))
      .when(this.annotating === id, (el) => el.child(h_flex().id(`note-${id}`).gap(5).items_center()
        .on_click((_e, cx) => cx.stop_propagation())
        .child(Input.new(this.note).flex_1().h(30).px(9).rounded(7).border_1().border_color(t.input)
          .bg(t.background).text_size(14).text_color(t.foreground))
        .child(this.actionButton(t, `note-save-${id}`, "Save", t.foreground, (cx) => this.annotate(cx)))));
  }

  waiting(task) {
    return twDate(task.wait) > Date.now();
  }

  matches(task) {
    if (!this.showWaiting && this.waiting(task)) return false;
    if (this.project && task.project !== this.project) return false;
    const f = this.filter.trim().toLowerCase();
    if (!f) return true;
    if (/^#\d+$/.test(f)) return String(task.id) === f.slice(1);
    if (f.startsWith("+")) return (task.tags ?? []).some((tag) => tag.toLowerCase().startsWith(f.slice(1)));
    return task.description.toLowerCase().includes(f)
      || (task.project ?? "").toLowerCase().includes(f)
      || (task.tags ?? []).some((tag) => tag.toLowerCase().includes(f))
      || (task.annotations ?? []).some((a) => a.description.toLowerCase().includes(f));
  }

  open(url) {
    exec("open", [url]).catch((e) => notify({ title: "Couldn't open link", body: String(e), level: "error" }));
  }

  chip(t, id, label, on, action) {
    return div().id(id).px(9).h(26).flex().flex_none().items_center().rounded(7)
      .text_size(13).text_color(on ? t.accent_foreground : t.muted).bg(on ? t.accent : t.raised)
      .hover((s) => s.bg(on ? t.accent : t.hover))
      .on_click((_e, cx) => { action(); cx.notify(); })
      .child(label);
  }

  /** Draws selectable text with its URLs as clickable links. */
  richText(id, text, color) {
    return div().min_w(0).text_color(color)
      .child(TextView.html(id, toHtml(String(text))).selectable(true).on_link_click((url) => this.open(url)));
  }

  /** Right-hand badge: due date wins, then active time, then age. */
  badge(t, task) {
    const now = Date.now();
    const due = twDate(task.due);
    if (!Number.isNaN(due)) {
      const late = due < now;
      return div().flex_none().text_size(13).text_color(late ? t.blocked : due - now < 86400000 * 2 ? t.working : t.muted)
        .child(late ? `overdue ${span(due - now)}` : `due ${span(due - now)}`);
    }
    const start = twDate(task.start);
    if (!Number.isNaN(start)) return div().flex_none().text_size(13).text_color(t.working).child(`active ${span(now - start)}`);
    return div().flex_none().text_size(13).text_color(t.dim).child(span(now - twDate(task.entry)));
  }

  meta(t, id, label, value) {
    return h_flex().gap(8).items_start().text_size(13)
      .child(div().flex_none().w(74).text_color(t.dim).child(label))
      .child(this.richText(id, value, t.muted).flex_1());
  }

  details(t, task, byUuid) {
    const notes = task.annotations ?? [];
    const deps = (task.depends ?? []).map((u) => {
      const d = byUuid.get(u);
      return d ? `#${d.id} ${d.description}` : `${u.slice(0, 8)} (not pending)`;
    });
    const blocking = this.tasks.filter((o) => (o.depends ?? []).includes(task.uuid)).map((o) => `#${o.id} ${o.description}`);
    const extra = Object.keys(task).filter((k) => !KNOWN.has(k)).sort();
    const rows = [
      ["urgency", task.urgency.toFixed(2)],
      ["entered", when(task.entry)],
      ["modified", when(task.modified)],
      ...["due", "scheduled", "wait", "until", "start", "reviewed"].filter((k) => task[k]).map((k) => [k, when(task[k])]),
      ...(task.recur ? [["recur", task.recur]] : []),
      ...deps.map((d, i) => [i === 0 ? "depends on" : "", d]),
      ...blocking.map((d, i) => [i === 0 ? "blocking" : "", d]),
      ...extra.map((k) => [k, Array.isArray(task[k]) ? task[k].join(", ") : when(task[k])]),
      ["uuid", task.uuid],
    ];
    // Clicks in here must not reach the row's expand toggle, or a drag-select collapses the task.
    return v_flex().id(`details-${task.uuid}`).pl(38).pr(4).pt(4).gap(6)
      .on_click((_e, cx) => cx.stop_propagation())
      .child(this.actions(t, task))
      .when(notes.length > 0, (el) => el.child(v_flex().gap(5).children(notes.map((a, i) => v_flex().gap(1)
        .pl(8).border_l(2).border_color(t.border)
        .child(div().text_size(13).text_color(t.dim).child(when(a.entry)))
        .child(this.richText(`ann-${task.uuid}-${i}`, a.description, t.foreground))))))
      .child(v_flex().gap(2).children(rows.map(([k, v], i) => this.meta(t, `meta-${task.uuid}-${i}`, k, v))));
  }

  renderTask(t, task, byUuid) {
    const open = this.expanded.has(task.uuid);
    const active = Boolean(task.start);
    const blocked = (task.depends ?? []).some((u) => byUuid.has(u));
    const notes = task.annotations?.length ?? 0;
    const prio = { H: t.blocked, M: t.working, L: t.dim }[task.priority];
    return v_flex().id(`task-${task.uuid}`).px(8).py(6).gap(4).rounded(7).flex_none()
      .bg(open ? t.raised : t.surface)
      .hover((s) => s.bg(open ? t.raised : t.hover))
      .on_click((_e, cx) => {
        if (open) this.expanded.delete(task.uuid); else this.expanded.add(task.uuid);
        cx.notify();
      })
      .child(h_flex().gap(8).items_start()
        .child(div().flex_none().w(30).text_color(active ? t.working : t.dim).child(`${task.id}`))
        .child(div().flex_1().min_w(0).text_color(blocked || this.waiting(task) ? t.muted : t.foreground).child(task.description))
        .child(this.badge(t, task)))
      .child(h_flex().pl(38).gap(10).flex_wrap().text_size(13).text_color(t.muted)
        .when(Boolean(task.project), (row) => row.child(div().text_color(t.muted).child(task.project)))
        .when(Boolean(prio), (row) => row.child(h_flex().gap(4).items_center()
          .child(div().size(7).rounded(4).bg(prio))
          .child(task.priority)))
        .when(active, (row) => row.child(div().text_color(t.working).child("active")))
        .when(blocked, (row) => row.child(div().text_color(t.blocked).child("blocked")))
        .when(this.waiting(task), (row) => row.child(div().text_color(t.dim).child(`waiting ${span(twDate(task.wait) - Date.now())}`)))
        .children((task.tags ?? []).map((tag) => div().text_color(t.dim).child(`+${tag}`)))
        .when(notes > 0, (row) => row.child(div().text_color(t.dim).child(`${notes} note${notes === 1 ? "" : "s"}`)))
        .child(div().text_color(t.dim).child(task.urgency.toFixed(1))))
      .when(open, (el) => el.child(this.details(t, task, byUuid)));
  }

  render(cx) {
    const t = theme();
    const byUuid = new Map(this.tasks.map((x) => [x.uuid, x]));
    const projects = [...new Set(this.tasks.map((x) => x.project).filter(Boolean))].sort();
    const shown = this.tasks.filter((x) => this.matches(x));
    const waitingCount = this.tasks.filter((x) => this.waiting(x)).length;
    const status = this.error ? this.error
      : !this.loadedAt ? "Loading from Taskwarrior…"
      : `${shown.length} of ${this.tasks.length - (this.showWaiting ? 0 : waitingCount)} pending · updated ${span(Date.now() - this.loadedAt)} ago`;
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_size(15)
      .child(v_flex().p(10).gap(8).flex_none().border_b(1).border_color(t.border)
        .child(h_flex().items_center().justify_between()
          .child(h_flex().gap(6).items_center()
            .child(div().font_semibold().text_color(t.foreground).child("Tasks"))
            .when(Boolean(this.extraFilter), (el) => el.child(div().text_size(13).text_color(t.dim).child(this.extraFilter))))
          .child(h_flex().gap(2)
            .when(this.expanded.size > 0, (el) => el.child(div().id("collapse").px(8).h(24).flex().items_center().rounded(6).text_size(13)
              .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => { this.expanded.clear(); cx.notify(); })
              .child("Collapse")))
            .child(div().id("refresh").px(8).h(24).flex().items_center().rounded(6).text_size(13)
              .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.refresh(cx))
              .child(this.loading ? "Refreshing…" : "Refresh"))))
        .child(h_flex().gap(5).flex_wrap()
          .child(this.chip(t, "proj-all", "All projects", !this.project, () => { this.project = null; }))
          .children(projects.map((p, i) => this.chip(t, `proj-${i}`, p, this.project === p,
            () => { this.project = this.project === p ? null : p; })))
          .when(waitingCount > 0, (el) => el.child(this.chip(t, "waiting", `Waiting (${waitingCount})`, this.showWaiting,
            () => { this.showWaiting = !this.showWaiting; }))))
        .child(Input.new(this.input).h(32).flex_none().px(10).rounded(8).border_1().border_color(t.input)
          .bg(t.background).text_size(14).text_color(t.foreground))
        .child(div().text_size(13).text_color(this.error ? t.blocked : t.dim).child(status)))
      .child(v_flex().id("task-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).py(6).gap(2)
        .children(shown.map((x) => this.renderTask(t, x, byUuid)))
        .when(Boolean(this.loadedAt) && !this.error && shown.length === 0,
          (el) => el.child(div().p(10).text_size(13).text_color(t.dim).child("No matching tasks"))));
  }
}
