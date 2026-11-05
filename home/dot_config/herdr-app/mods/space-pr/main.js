// The pull request for the active space's branch: status, checks, reviews and description.
// On the repo's main branch it lists every open pull request instead; one can be inspected
// or checked out into a new worktree space.
// Follows the focused terminal's folder (else the space's first terminal) and asks `gh` there.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input } from "gpui-base";
import { exec, theme, notify, run, spaces, panes, home } from "herdr";
import { location, check, overall, readyToMerge, onMainBranch } from "./detect.js";

const FIELDS = [
  "number", "title", "url", "state", "isDraft", "author", "baseRefName", "headRefName",
  "reviewDecision", "mergeStateStatus", "statusCheckRollup", "latestReviews", "reviewRequests",
  "additions", "deletions", "changedFiles", "labels", "updatedAt", "body",
].join(",");
const LIST_FIELDS = [
  "number", "title", "url", "isDraft", "author", "baseRefName", "headRefName",
  "reviewDecision", "statusCheckRollup", "updatedAt",
].join(",");
const WATCH_MS = 2000;
const REFRESH_MS = 60 * 1000;

const MERGE_STATE = {
  CLEAN: ["Ready to merge", "success"],
  HAS_HOOKS: ["Ready to merge", "success"],
  BLOCKED: ["Blocked", "blocked"],
  BEHIND: ["Behind base branch", "working"],
  DIRTY: ["Merge conflicts", "blocked"],
  UNSTABLE: ["Checks not passing", "blocked"],
  DRAFT: ["Draft", "unknown"],
  UNKNOWN: ["Checking mergeability…", "unknown"],
};
const REVIEW = {
  APPROVED: ["Approved", "success"],
  CHANGES_REQUESTED: ["Changes requested", "blocked"],
  REVIEW_REQUIRED: ["Review required", "working"],
};

/**
 * Formats an ISO timestamp as a short relative age ("3d", "5h").
 * @param iso ISO 8601 timestamp
 * @returns Compact age string
 */
function age(iso) {
  const mins = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${Math.floor(mins)}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  if (mins < 60 * 24 * 30) return `${Math.floor(mins / 1440)}d`;
  return `${Math.floor(mins / 43200)}mo`;
}

/**
 * Turns a branch into a folder name, matching the shipped worktree mod's checkout paths.
 * @param branch Branch name
 * @returns Filesystem-safe name
 */
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The space whose terminals are inside a folder.
 * @param path Checkout folder
 * @param on Machine name, null for this computer
 * @returns The space, or undefined
 */
function spaceAt(path, on) {
  const inside = (cwd) => cwd === path || cwd.startsWith(`${path}/`);
  return spaces().find((s) => (s.machine ?? null) === (on ?? null)
    && panes().some((p) => p.cwd && s.tabs.some((t) => t.id === p.tab) && inside(p.cwd)));
}

const result = (r, what) => {
  if (r.code !== 0) throw new Error((r.stderr ?? "").trim() || `${what} exited ${r.code}`);
  return r.stdout.trim();
};

export default class SpacePr extends View {
  init(_props, cx) {
    this.cache = new Map();
    this.details = new Map();
    this.loc = null;
    this.loading = false;
    this.showPassed = false;
    this.selected = null;
    this.filter = "";
    this.opening = null;
    this.input = InputState.new({ placeholder: "Filter pull requests" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.watch(cx);
    cx.timer.every(WATCH_MS, (cx) => this.watch(cx));
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  watch(cx) {
    const loc = location();
    if (loc?.key === this.loc?.key) return;
    this.loc = loc;
    this.showPassed = false;
    this.selected = null;
    this.refresh(cx);
  }

  detailKey(n) {
    return `${this.loc?.key}#${n}`;
  }

  /** The cached entry for what's shown now: the selected PR's details, else the space's. */
  current() {
    if (!this.loc) return null;
    return this.selected != null ? this.details.get(this.detailKey(this.selected)) : this.cache.get(this.loc.key);
  }

  select(cx, n) {
    this.selected = n;
    this.showPassed = false;
    this.refresh(cx);
    cx.notify();
  }

  async fetchSpace(loc) {
    if (await onMainBranch(loc)) {
      const r = await exec("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", LIST_FIELDS], { cwd: loc.cwd, on: loc.on });
      if (r.code === 0) return { list: JSON.parse(r.stdout) };
      return { error: r.stderr.trim() || `gh exited ${r.code}` };
    }
    const r = await exec("gh", ["pr", "view", "--json", FIELDS], { cwd: loc.cwd, on: loc.on });
    if (r.code === 0) return { pr: JSON.parse(r.stdout) };
    if (/no (pull requests|open pull requests) found|not a git repository|no git remotes/i.test(r.stderr)) return { none: r.stderr.trim() };
    return { error: r.stderr.trim() || `gh exited ${r.code}` };
  }

  async fetchDetail(loc, n) {
    const r = await exec("gh", ["pr", "view", String(n), "--json", FIELDS], { cwd: loc.cwd, on: loc.on });
    if (r.code === 0) return { pr: JSON.parse(r.stdout) };
    return { error: r.stderr.trim() || `gh exited ${r.code}` };
  }

  refresh(cx) {
    const loc = this.loc;
    if (!loc || this.loading) return cx.notify();
    this.loading = true;
    cx.notify();
    const n = this.selected;
    cx.spawn(async (cx) => {
      let entry;
      try {
        entry = n != null ? await this.fetchDetail(loc, n) : await this.fetchSpace(loc);
      } catch (e) {
        entry = { error: String(e?.message ?? e) };
      }
      entry.at = Date.now();
      if (n != null) this.details.set(`${loc.key}#${n}`, entry);
      else this.cache.set(loc.key, entry);
      this.loading = false;
      cx.notify();
      if (this.loc && !this.current()) this.refresh(cx);
    });
  }

  /**
   * Shows a PR's branch in its own worktree space: the space already on it, else a new
   * checkout under ~/.herdr/worktrees/<repo>/ (where the worktree mod puts them) made with
   * `gh pr checkout`, so fork PRs and upstream tracking work as they do from a shell.
   */
  openWorktree(cx, pr) {
    const loc = this.loc;
    if (!loc || this.opening != null) return;
    this.opening = pr.number;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const git = async (args, cwd) => result(await exec("git", args, { cwd, on: loc.on }), "git");
        const main = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], loc.cwd)).replace(/\/\.git$/, "");
        const existing = (await git(["worktree", "list", "--porcelain"], main)).split(/\n\n+/)
          .map((b) => ({ path: b.match(/^worktree (.+)$/m)?.[1], branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] }))
          .find((w) => w.path && w.branch === pr.headRefName);
        if (existing) {
          const s = spaceAt(existing.path, loc.on);
          if (s) run("space.select", { id: s.id });
          else run("space.new", { folder: existing.path, machine: loc.on });
          return;
        }
        const userHome = loc.on ? result(await exec("sh", ["-c", 'printf %s "$HOME"'], { on: loc.on }), "sh") : home();
        const path = `${userHome}/.herdr/worktrees/${main.split("/").pop()}/${slug(pr.headRefName)}`;
        await git(["worktree", "add", "--detach", path], main);
        const co = await exec("gh", ["pr", "checkout", String(pr.number)], { cwd: path, on: loc.on });
        if (co.code !== 0) {
          await exec("git", ["worktree", "remove", "--force", path], { cwd: main, on: loc.on });
          throw new Error(co.stderr.trim() || `gh pr checkout exited ${co.code}`);
        }
        // Left unnamed so the space follows the checkout and nests under its repo.
        run("space.new", { folder: path, machine: loc.on });
      } catch (e) {
        notify({ title: `Couldn't open #${pr.number} in a worktree`, body: String(e?.message ?? e), level: "error" });
      } finally {
        this.opening = null;
        cx.notify();
      }
    });
  }

  open(url) {
    if (url) exec("open", [url]).catch((e) => notify({ title: "Couldn't open link", body: String(e), level: "error" }));
  }

  pill(t, text, tone) {
    return div().px(7).h(22).flex().flex_none().items_center().rounded(10).text_size(13)
      .border(1).border_color(t[tone] ?? t.border).text_color(t[tone] ?? t.muted).child(text);
  }

  section(t, title, extra) {
    return h_flex().pt(10).pb(4).gap(6).items_center()
      .child(div().text_size(13).font_semibold().text_color(t.muted).child(title))
      .when(Boolean(extra), (el) => el.child(div().text_size(13).text_color(t.dim).child(extra)));
  }

  renderChecks(t, pr) {
    const checks = (pr.statusCheckRollup ?? []).map(check);
    if (!checks.length) return [this.section(t, "Checks"), div().text_color(t.dim).text_size(13).child("No checks reported")];
    const by = (r) => checks.filter((c) => c.result === r);
    const failed = by("fail"), pending = by("pending"), passed = by("pass");
    const summary = [failed.length && `${failed.length} failed`, pending.length && `${pending.length} running`, passed.length && `${passed.length} passed`].filter(Boolean).join(" · ");
    const row = (c, i, tone, mark) => h_flex().id(`check-${tone}-${i}`).px(6).py(3).gap(8).rounded(6).items_center()
      .hover((s) => s.bg(t.hover)).on_click(() => this.open(c.url))
      .child(div().w(12).flex_none().text_color(t[tone]).child(mark))
      .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(t.foreground).child(c.name));
    return [
      this.section(t, "Checks", summary),
      ...failed.map((c, i) => row(c, i, "blocked", "✕")),
      ...pending.map((c, i) => row(c, i, "working", "•")),
      ...(this.showPassed ? passed.map((c, i) => row(c, i, "success", "✓")) : []),
      ...(passed.length ? [div().id("toggle-passed").px(6).py(3).text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.showPassed = !this.showPassed; cx.notify(); })
        .child(this.showPassed ? "Hide passed checks" : `Show ${passed.length} passed checks`)] : []),
    ];
  }

  renderReviewers(t, pr) {
    const tone = { APPROVED: ["success", "approved"], CHANGES_REQUESTED: ["blocked", "changes requested"], COMMENTED: ["muted", "commented"], DISMISSED: ["dim", "dismissed"] };
    const reviews = (pr.latestReviews ?? []).map((r) => {
      const [c, word] = tone[r.state] ?? ["muted", r.state.toLowerCase()];
      return h_flex().gap(6).text_size(14).child(div().text_color(t.foreground).child(`@${r.author.login}`)).child(div().text_color(t[c] ?? t.muted).child(word));
    });
    const requested = (pr.reviewRequests ?? []).map((r) => h_flex().gap(6).text_size(14)
      .child(div().text_color(t.foreground).child(r.login ? `@${r.login}` : r.name ?? r.slug ?? "team"))
      .child(div().text_color(t.dim).child("requested")));
    const rows = [...reviews, ...requested];
    return [this.section(t, "Reviewers"), rows.length ? v_flex().px(6).gap(3).children(rows) : div().text_size(13).text_color(t.dim).child("No reviewers yet")];
  }

  renderPr(t, pr) {
    const state = pr.state === "MERGED" ? ["Merged", "accent"] : pr.state === "CLOSED" ? ["Closed", "blocked"] : pr.isDraft ? ["Draft", "unknown"] : ["Open", "success"];
    const ready = readyToMerge(pr);
    const merge = pr.state === "OPEN" && !ready ? MERGE_STATE[pr.mergeStateStatus] : null;
    const review = pr.state === "OPEN" ? REVIEW[pr.reviewDecision] : null;
    return v_flex().gap(2)
      .when(ready, (el) => el.child(h_flex().mb(10).px(10).py(8).gap(8).items_center().rounded(8)
        .border(1).border_color(t.success).text_color(t.success).text_size(14)
        .child(div().font_semibold().child("✓ Ready to merge"))
        .child(div().text_color(t.muted).child("Approved and all checks passed"))))
      .child(h_flex().id("title").gap(8).items_start().hover((s) => s.opacity(0.85)).on_click(() => this.open(pr.url))
        .child(div().flex_none().text_color(t.dim).child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).font_semibold().text_color(t.foreground).child(pr.title)))
      .child(div().pt(4).text_size(13).text_color(t.dim).child(`${pr.headRefName} → ${pr.baseRefName} · @${pr.author.login} · updated ${age(pr.updatedAt)} ago`))
      .child(h_flex().pt(2).gap(8).text_size(13)
        .child(div().text_color(t.success).child(`+${pr.additions}`))
        .child(div().text_color(t.blocked).child(`−${pr.deletions}`))
        .child(div().text_color(t.dim).child(`${pr.changedFiles} files`)))
      .child(h_flex().pt(8).gap(5).flex_wrap()
        .child(this.pill(t, state[0], state[1]))
        .when(Boolean(review), (el) => el.child(this.pill(t, review[0], review[1])))
        .when(Boolean(merge), (el) => el.child(this.pill(t, merge[0], merge[1]))))
      .children(this.renderChecks(t, pr))
      .children(this.renderReviewers(t, pr))
      .when(pr.labels.length > 0, (el) => el.child(this.section(t, "Labels")).child(h_flex().px(6).gap(10).flex_wrap().text_size(13).text_color(t.muted)
        .children(pr.labels.map((l) => h_flex().gap(4).items_center().child(div().size(7).rounded(4).bg(`#${l.color}`)).child(l.name)))))
      .child(this.section(t, "Description"))
      .child(pr.body?.trim()
        ? div().px(14).py(12).rounded(8).border(1).border_color(t.border).bg(t.background)
          .text_size(16).line_height("25px").text_color(t.foreground)
          .child(TextView.markdown(`body-${pr.number}`, pr.body).selectable(true).on_link_click((url) => this.open(url)))
        : div().px(6).text_size(13).text_color(t.dim).child("No description"));
  }

  button(t, id, label, onClick, primary = false) {
    return div().id(id).px(8).h(26).flex().flex_none().items_center().rounded(6).text_size(13).cursor_pointer()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click(onClick).child(label);
  }

  renderList(t, list) {
    const f = this.filter.trim().toLowerCase();
    const rows = list.filter((p) => !f || `#${p.number} ${p.title} ${p.headRefName} ${p.author.login}`.toLowerCase().includes(f));
    const row = (p) => {
      const checks = overall(p.statusCheckRollup);
      const dot = { fail: t.blocked, pending: t.working, pass: t.success }[checks];
      const review = REVIEW[p.reviewDecision];
      return v_flex().id(`pr-${p.number}`).px(8).py(6).gap(2).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.select(cx, p.number))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_color(t.dim).child(`#${p.number}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p.title))
          .when(Boolean(dot), (el) => el.child(div().size(7).flex_none().rounded(4).bg(dot)
            .when(checks === "pending", (d) => d.loop("opacity", { from: 0.35, to: 1, period: 1200 })))))
        .child(h_flex().gap(8).text_size(13).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(`${p.headRefName} → ${p.baseRefName} · @${p.author.login} · ${age(p.updatedAt)}`))
          .when(p.isDraft, (el) => el.child(div().flex_none().text_color(t.unknown).child("Draft")))
          .when(!p.isDraft && Boolean(review), (el) => el.child(div().flex_none().text_color(t[review[1]]).child(review[0]))));
    };
    return v_flex().gap(2)
      .child(h_flex().pb(8).gap(8).items_center()
        .child(Input.new(this.input).flex_1().h(30).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(14))
        .child(div().flex_none().text_size(13).text_color(t.dim).child(rows.length === list.length ? `${list.length} open` : `${rows.length}/${list.length}`)))
      .children(rows.map(row))
      .when(rows.length === 0, (el) => el.child(div().px(8).text_size(13).text_color(t.dim).child(list.length ? "No matching pull requests" : "No open pull requests")));
  }

  renderDetail(t, entry) {
    const pr = entry?.pr;
    const opening = this.opening === this.selected;
    return v_flex()
      .child(h_flex().pb(10).gap(6).items_center().justify_between()
        .child(this.button(t, "back", "← All pull requests", (_e, cx) => { this.selected = null; cx.notify(); }))
        .when(pr?.state === "OPEN", (el) => el.child(this.button(t, "worktree", opening ? "Opening…" : "Open in worktree", (_e, cx) => this.openWorktree(cx, pr), true))))
      .child(!entry ? div().text_size(13).text_color(t.dim).child(`Loading #${this.selected}…`)
        : entry.error ? div().text_color(t.blocked).text_size(13).child(entry.error)
        : this.renderPr(t, pr));
  }

  render(cx) {
    // `idle` is the agent-idle status color (often gray), not a success color.
    const t = { ...theme(), success: theme().ansi2 };
    const loc = this.loc;
    const entry = loc && this.cache.get(loc.key);
    const listing = Boolean(entry?.list);
    const body = !loc ? div().text_size(13).text_color(t.dim).child("No folder for this space")
      : !entry ? div().text_size(13).text_color(t.dim).child("Looking for a pull request…")
      : entry.error ? div().text_color(t.blocked).text_size(13).child(entry.error)
      : listing ? (this.selected != null ? this.renderDetail(t, this.current()) : this.renderList(t, entry.list))
      : entry.none ? v_flex().gap(4).child(div().text_size(13).text_color(t.muted).child(`No pull request for ${loc.branch ?? "this branch"}`))
          .child(div().text_size(13).text_color(t.dim).child(loc.cwd))
      : this.renderPr(t, entry.pr);
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_size(15)
      .child(h_flex().p(10).flex_none().items_center().justify_between().border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().font_semibold().text_color(t.foreground).child(listing && this.selected == null ? "Pull requests" : "Pull request"))
          .child(div().truncate().text_size(13).text_color(t.dim).child(loc ? `${loc.name}${loc.branch ? ` · ${loc.branch}` : ""}` : "")))
        .child(div().id("refresh").px(8).h(24).flex().flex_none().items_center().rounded(6).text_size(13)
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.refresh(cx))
          .child(this.loading ? "Refreshing…" : "Refresh")))
      .child(v_flex().id(listing && this.selected != null ? "detail-scroll" : "scroll").flex_1().min_h(0).overflow_y_scrollbar().p(12).child(body));
  }
}
