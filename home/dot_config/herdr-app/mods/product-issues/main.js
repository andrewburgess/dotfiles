// Open issues for one repository from its ZenHub board, limited to the pipelines
// before `until`. Props: { repo: "owner/name" (required), until: "On Dev" }.
// Uses the ZenHub token from the `zh` CLI config and `gh` for the repo id and login.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { exec, props, theme, notify, home, openOverlay } from "herdr";

const DEFAULT_UNTIL = "On Dev";
const ZENHUB_API = "https://api.zenhub.com/public/graphql";
const REFRESH_MS = 5 * 60 * 1000;
const PAGE = 100;
const MAX_PAGES = 20;

const WORKSPACES = `query($ghIds: [Int!]!) {
  repositoriesByGhId(ghIds: $ghIds) {
    id
    workspacesConnection(first: 50) {
      nodes { id name pipelinesConnection { nodes { id name } } }
    }
  }
}`;

const PIPELINE_ISSUES = `query($pipelineId: ID!, $repoId: ID!, $after: String) {
  searchIssuesByPipeline(pipelineId: $pipelineId, filters: { repositoryIds: [$repoId] }, first: ${PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      number title state htmlUrl updatedAt
      estimate { value }
      labels { nodes { name color } }
      assignees { nodes { login } }
    }
  }
}`;

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
 * Reads ZH_TOKEN and ZH_WORKSPACE from the `zh` CLI config, letting the environment win as `zh` does.
 * @returns The token and optional workspace name
 */
async function zenhubConfig() {
  const script = 't=$ZH_TOKEN w=$ZH_WORKSPACE; [ -f "$1" ] && . "$1" >/dev/null 2>&1; printf "%s\\n%s" "${t:-$ZH_TOKEN}" "${w:-$ZH_WORKSPACE}"';
  const r = await exec("sh", ["-c", script, "sh", `${home()}/.config/zh/config`]);
  const [token, workspace] = r.stdout.split("\n");
  if (!token) throw new Error("No ZenHub token: set ZH_TOKEN in ~/.config/zh/config");
  return { token, workspace: workspace || null };
}

async function gh(args) {
  const r = await exec("gh", args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh ${args[0]} failed`);
  return r.stdout.trim();
}

export default class ProductIssues extends View {
  init(_props, cx) {
    this.repo = props()?.repo || "";
    this.until = props()?.until || DEFAULT_UNTIL;
    this.groups = [];
    this.board = null;
    this.mineOnly = true;
    this.pipeline = null;
    this.filter = "";
    this.loading = false;
    this.error = null;
    this.detail = null;
    this.input =InputState.new({ placeholder: "Filter by title, #number, label, or assignee…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  async graphql(query, variables) {
    const res = await fetch(ZENHUB_API, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.board.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (!res.ok || body.errors) throw new Error(body.errors?.[0]?.message ?? `ZenHub responded ${res.status}`);
    return body.data;
  }

  /** Resolves the token, login, ZenHub repo id and the pipelines to show; cached after the first success. */
  async loadBoard() {
    if (!this.repo) throw new Error("Set props.repo (owner/name) on this block");
    const { token, workspace } = await zenhubConfig();
    const [me, ghId] = await Promise.all([gh(["api", "user", "--jq", ".login"]), gh(["api", `repos/${this.repo}`, "--jq", ".id"])]);
    this.board = { token };
    const repo = (await this.graphql(WORKSPACES, { ghIds: [Number(ghId)] })).repositoriesByGhId[0];
    if (!repo) throw new Error(`${this.repo} isn't connected to ZenHub`);
    const spaces = repo.workspacesConnection.nodes;
    const ws = spaces.find((w) => workspace && w.name.toLowerCase() === workspace.toLowerCase()) ?? spaces[0];
    if (!ws) throw new Error(`No ZenHub workspace contains ${this.repo}`);
    const all = ws.pipelinesConnection.nodes;
    const cut = all.findIndex((p) => p.name.toLowerCase() === this.until.toLowerCase());
    this.board = { token, me, repoId: repo.id, workspace: ws.name, pipelines: cut >= 0 ? all.slice(0, cut) : all };
  }

  async pipelineIssues(pipeline) {
    const out = [];
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const conn = (await this.graphql(PIPELINE_ISSUES, { pipelineId: pipeline.id, repoId: this.board.repoId, after })).searchIssuesByPipeline;
      out.push(...conn.nodes.filter((i) => i && i.state === "OPEN"));
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor || conn.pageInfo.endCursor === after) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.board?.pipelines) await this.loadBoard();
        const lists = await Promise.all(this.board.pipelines.map((p) => this.pipelineIssues(p)));
        this.groups = this.board.pipelines.map((p, i) => ({ name: p.name, issues: lists[i] }));
        this.error = null;
        this.loadedAt = Date.now();
      } catch (e) {
        if (!this.board?.pipelines) this.board = null;
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  matches(issue) {
    const logins = issue.assignees.nodes.map((a) => a.login);
    if (this.mineOnly && logins.length && !logins.includes(this.board?.me)) return false;
    const f = this.filter.trim().toLowerCase().replace(/^#/, "");
    if (!f) return true;
    return String(issue.number).startsWith(f)
      || issue.title.toLowerCase().includes(f)
      || issue.labels.nodes.some((l) => l.name.toLowerCase().includes(f))
      || logins.some((l) => l.toLowerCase().includes(f));
  }

  openUrl(url) {
    exec("open", [url]).catch((e) => notify({ title: "Couldn't open link", body: String(e), level: "error" }));
  }

  /** Shows one issue's body and comments in place of the list, fetched fresh from GitHub. */
  show(issue, cx) {
    const detail = { issue, data: null, error: null };
    this.detail = detail;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const json = await gh(["issue", "view", String(issue.number), "--repo", this.repo,
          "--json", "title,body,author,createdAt,state,url,comments"]);
        detail.data = JSON.parse(json);
      } catch (e) {
        detail.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  button(t, id, label, action) {
    return div().id(id).px(8).h(24).flex().flex_none().items_center().rounded(6).text_size(13)
      .text_color(t.muted).bg(t.raised).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => action(cx))
      .child(label);
  }

  markdown(t, id, text) {
    return div().px(14).py(12).rounded(8).border(1).border_color(t.border).bg(t.background)
      .text_size(16).line_height("25px").text_color(t.foreground)
      .child(text?.trim()
        ? TextView.markdown(id, text).selectable(true).on_link_click((url) => this.openUrl(url))
        : div().text_size(13).text_color(t.dim).child("No description provided."));
  }

  renderDetail(t) {
    const { issue, data, error } = this.detail;
    const url = data?.url ?? issue.htmlUrl;
    const comments = data?.comments ?? [];
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_size(15)
      .child(v_flex().p(10).gap(8).flex_none().border_b(1).border_color(t.border)
        .child(h_flex().items_center().justify_between()
          .child(this.button(t, "back", "← Issues", (cx) => { this.detail = null; cx.notify(); }))
          .child(this.button(t, "open-github", "Open in GitHub", () => this.openUrl(url))))
        .child(h_flex().gap(8).items_start()
          .child(div().flex_none().text_color(t.dim).child(`#${issue.number}`))
          .child(div().flex_1().min_w(0).font_semibold().text_color(t.foreground).child(data?.title ?? issue.title)))
        .child(div().text_size(13).text_color(error ? t.blocked : t.dim).child(
          error ? error
            : !data ? "Loading from GitHub…"
            : `${data.state.toLowerCase()} · opened by @${data.author?.login ?? "ghost"} ${age(data.createdAt)} ago · ${comments.length} comment${comments.length === 1 ? "" : "s"}`)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(12)
        .when(Boolean(data), (el) => el
          .child(this.markdown(t, `body-${issue.number}`, data.body))
          .children(comments.map((c, i) => v_flex().flex_none().gap(6).pt(10).border_t(1).border_color(t.border)
            .child(h_flex().gap(6).text_size(13)
              .child(div().font_semibold().text_color(t.muted).child(`@${c.author?.login ?? "ghost"}`))
              .child(div().text_color(t.dim).child(`${age(c.createdAt)} ago`)))
            .child(this.markdown(t, `comment-${issue.number}-${i}`, c.body))))))
      .child(h_flex().p(10).flex_none().justify_end().border_t(1).border_color(t.border)
        .child(div().id("wrangle").px(12).h(28).flex().items_center().rounded(7).text_size(13).font_semibold()
          .text_color(t.solid_foreground).bg(t.solid).hover((s) => s.opacity(0.88))
          .on_click(() => openOverlay({ mod: "wrangle-dialog", kind: "dialog", width: 480,
            props: { issue: issue.number, title: data?.title ?? issue.title } }))
          .child("Wrangle")));
  }

  chip(t, id, label, on, action) {
    return div().id(id).px(9).h(26).flex().flex_none().items_center().rounded(7)
      .text_size(13).text_color(on ? t.accent_foreground : t.muted).bg(on ? t.accent : t.raised)
      .hover((s) => s.bg(on ? t.accent : t.hover))
      .on_click((_e, cx) => { action(); cx.notify(); })
      .child(label);
  }

  renderIssue(t, issue) {
    const logins = issue.assignees.nodes.map((a) => a.login);
    const points = issue.estimate?.value;
    return v_flex().id(`issue-${issue.number}`).px(8).py(6).gap(4).rounded(7).flex_none()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.show(issue, cx))
      .child(h_flex().gap(8).items_start()
        .child(div().flex_none().w(56).whitespace_nowrap().text_color(t.dim).child(`#${issue.number}`))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(issue.title))
        .child(div().flex_none().text_size(13).text_color(t.dim).child(age(issue.updatedAt))))
      .child(h_flex().pl(64).gap(10).flex_wrap().text_size(13).text_color(t.muted)
        .child(div().text_color(logins.length ? t.muted : t.accent).child(logins.length ? "@" + logins.join(", @") : "unassigned"))
        .when(points != null, (row) => row.child(div().text_color(t.dim).child(`${points} pts`)))
        .children(issue.labels.nodes.map((l) => h_flex().gap(4).items_center()
          .child(div().size(7).rounded(4).bg(`#${l.color}`))
          .child(l.name))));
  }

  render(cx) {
    const t = theme();
    if (this.detail) return this.renderDetail(t);
    const groups = this.groups
      .filter((g) => !this.pipeline || g.name === this.pipeline)
      .map((g) => ({ name: g.name, issues: g.issues.filter((i) => this.matches(i)) }));
    const shown = groups.reduce((n, g) => n + g.issues.length, 0);
    const status = this.error ? this.error
      : !this.loadedAt ? "Loading from ZenHub…"
      : `${shown} issues${this.mineOnly ? " assigned to you or unassigned" : ""} · updated ${age(new Date(this.loadedAt).toISOString())} ago`;
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_size(15)
      .child(v_flex().p(10).gap(8).flex_none().border_b(1).border_color(t.border)
        .child(h_flex().items_center().justify_between()
          .child(h_flex().gap(6).items_center()
            .child(div().font_semibold().text_color(t.foreground).child("Issues"))
            .child(div().text_size(13).text_color(t.dim).child(this.repo)))
          .child(div().id("refresh").px(8).h(24).flex().items_center().rounded(6).text_size(13)
            .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.refresh(cx))
            .child(this.loading ? "Refreshing…" : "Refresh")))
        .child(h_flex().gap(5)
          .child(this.chip(t, "scope-mine", "Mine + unassigned", this.mineOnly, () => { this.mineOnly = true; }))
          .child(this.chip(t, "scope-all", "Everyone", !this.mineOnly, () => { this.mineOnly = false; })))
        .child(h_flex().gap(5).flex_wrap()
          .child(this.chip(t, "pipe-all", "All pipelines", !this.pipeline, () => { this.pipeline = null; }))
          .children(this.groups.map((g, i) => this.chip(t, `pipe-${i}`, g.name, this.pipeline === g.name,
            () => { this.pipeline = this.pipeline === g.name ? null : g.name; }))))
        .child(Input.new(this.input).h(32).flex_none().px(10).rounded(8).border_1().border_color(t.input)
          .bg(t.background).text_size(14).text_color(t.foreground))
        .child(div().text_size(13).text_color(this.error ? t.blocked : t.dim).child(status)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().px(6).py(6).gap(2)
        .children(groups.filter((g) => g.issues.length > 0).map((g) => v_flex().flex_none().gap(1)
          .child(h_flex().px(8).pt(6).pb(2).gap(6).items_center()
            .child(div().text_size(13).font_semibold().text_color(t.muted).child(g.name))
            .child(div().text_size(13).text_color(t.dim).child(String(g.issues.length))))
          .children(g.issues.map((i) => this.renderIssue(t, i)))))
        .when(Boolean(this.loadedAt) && !this.error && shown === 0,
          (el) => el.child(div().p(10).text_size(13).text_color(t.dim).child("No matching issues"))));
  }
}
