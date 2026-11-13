// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder. Top-level spaces can go in folders:
// drag one onto a folder's header (or onto the Spaces header to take it out), or
// right-click a folder to pick its spaces, rename, reorder or delete it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

/**
 * Folders grouping top-level spaces, kept in `shared` so they follow across layouts and
 * launches. A worktree space goes with its main checkout's folder.
 * @returns `{ list: [{ id, name }], of: { [spaceId]: folderId } }`
 */
function folders() {
  const f = shared("space.folders") ?? {};
  return { list: f.list ?? [], of: f.of ?? {} };
}

/**
 * Puts a space in a folder.
 * @param spaceId The space
 * @param folderId The folder, or null to take the space out of any folder
 */
function setFolder(spaceId, folderId) {
  const f = folders();
  const of = { ...f.of };
  if (folderId) of[spaceId] = folderId;
  else delete of[spaceId];
  setShared("space.folders", { ...f, of });
}

/**
 * Removes a folder; its spaces go back to the top of the list.
 * @param id The folder
 */
function deleteFolder(id) {
  const f = folders();
  setShared("space.folders", {
    list: f.list.filter((x) => x.id !== id),
    of: Object.fromEntries(Object.entries(f.of).filter(([, v]) => v !== id)),
  });
}

/**
 * Asks for a folder's name: a new folder without `f`, else a rename of `f`.
 * @param f The folder to rename, or null
 */
function promptFolder(f = null) {
  openOverlay({ mod: "my-spaces", kind: "dialog", width: 400, height: 200, props: { folderPrompt: { id: f?.id ?? null, value: f?.name ?? "" } } });
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    const p = props();
    if (p?.folderMenu) return;
    if (p?.folderPrompt) {
      this.text = p.folderPrompt.value ?? "";
      this.input = InputState.new({ value: this.text, placeholder: "Folder name" });
      if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
      this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
      this.input.on("submit", () => this.submitFolder());
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
      this.handle = cx.focus_handle();
      return;
    }
    this.foldedFolders = new Set(JSON.parse(localStorage.getItem("folders.folded") ?? "[]"));
    this.top = new Set();
    this.lastRows = [];
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      ]);
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      ]);
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    let out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Spaces outside folders first, then folder by folder; a worktree stays with its checkout.
    const { list: fl, of } = folders();
    const rank = new Map(fl.map((f, n) => [f.id, n]));
    const units = [];
    for (const r of out) {
      if (r.tree && units.length) units.at(-1).push(r);
      else units.push([r]);
    }
    const at = (f) => (f === null ? -1 : rank.get(f));
    out = units
      .map((u, n) => ({ u, n, f: rank.has(of[u[0].w.id]) ? of[u[0].w.id] : null }))
      .sort((x, y) => at(x.f) - at(y.f) || x.n - y.n)
      .flatMap(({ u, f }) => u.map((r) => ({ ...r, folder: f })));
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    this.lastRows = rows;
    this.top = new Set(rows.filter((r) => !r.tree).map((r) => r.w.id));
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : this.foldered(rows, null, t, collapsed, draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      return [cell(head), ...guidance, ...(folded ? [] : mine.length ? this.foldered(mine, m, t, collapsed, draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // A machine's rows: spaces outside folders, then each folder under its header. Empty
  // folders show under this computer so there is somewhere to drop into them.
  foldered(mine, m, t, collapsed, draw) {
    const out = mine.filter((r) => !r.folder).map(draw);
    for (const f of folders().list) {
      const inside = mine.filter((r) => r.folder === f.id);
      if (!inside.length && m) continue;
      if (collapsed) {
        if (inside.length) out.push(railCell(div().w(18).h(1).my(5).bg(t.border)), ...inside.map(draw));
        continue;
      }
      const folded = this.foldedFolders.has(f.id);
      out.push(this.folderHead(f, inside, folded, t));
      if (!folded) out.push(...inside.map(draw));
    }
    return out;
  }

  // A folder's header: click folds it, drag reorders folders, right-click opens its menu,
  // and a space dropped on it goes in.
  folderHead(f, inside, folded, t) {
    const key = `folder-${f.id}`;
    const dropping = this.pressed !== null && this.over === key;
    const list = folders().list;
    const index = list.findIndex((x) => x.id === f.id);
    const fromIndex = list.findIndex((x) => x.id === this.pressedFolder);
    const target = this.pressedFolder && this.overFolder === f.id && this.pressedFolder !== f.id;
    const loud = inside.find((r) => r.w.status === "blocked" || r.w.status === "done")?.w.status;
    return h_flex()
      .id(key)
      .relative()
      .h(28)
      .flex_none()
      .px(8)
      .mt(4)
      .gap(7)
      .items_center()
      .rounded(7)
      .text_size(11.5)
      .text_color(dropping ? t.foreground : t.dim)
      .cursor_pointer()
      .when(dropping, (el) => el.bg(t.hover).border_1().border_color(t.accent))
      .when(!dropping, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .when(this.pressedFolder === f.id && this.overFolder !== f.id, (el) => el.opacity(0.5))
      .when(target, (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(fromIndex < index, (line) => line.bottom(0))
        .when(fromIndex > index, (line) => line.top(0))))
      .on_mouse_down("left", () => {
        this.pressedFolder = f.id;
        this.overFolder = f.id;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressedFolder && this.overFolder !== f.id) {
          this.overFolder = f.id;
          cx.notify();
        }
        if (this.pressed === null || !this.top.has(this.pressed) || this.over === key) return;
        this.over = key;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const fromFolder = this.pressedFolder;
        const overFolder = this.overFolder;
        this.pressed = null;
        this.over = null;
        this.pressedFolder = null;
        this.overFolder = null;
        if (from !== null && this.top.has(from)) setFolder(from, f.id);
        else if (fromFolder && overFolder === f.id && fromFolder !== f.id) {
          const f0 = folders();
          const l = f0.list.filter((x) => x.id !== fromFolder);
          l.splice(index, 0, f0.list.find((x) => x.id === fromFolder));
          setShared("space.folders", { ...f0, list: l });
        } else if (fromFolder === f.id) {
          folded ? this.foldedFolders.delete(f.id) : this.foldedFolders.add(f.id);
          localStorage.setItem("folders.folded", JSON.stringify([...this.foldedFolders]));
        }
        cx.notify();
      })
      .on_mouse_down("right", () => this.folderMenu(f))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none())
      .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().font_medium().child(f.name))
      .when(folded && Boolean(loud), (el) => el.child(div().flex_none().text_color(tone(t, loud)).child(glyph(loud))))
      .child(div().flex_none().text_size(11).child(String(inside.filter((r) => !r.tree).length)));
  }

  folderMenu(f) {
    const top = this.lastRows.filter((r) => !r.tree).map((r) => ({ id: r.w.id, name: r.w.name }));
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "my-spaces", kind: "popup", width: 240, height: Math.min(560, 10 + 31 * (top.length + 4) + 40), props: { folderMenu: f.id, spaces: top } });
  }

  renderFolderMenu(t) {
    const p = props();
    const { list, of } = folders();
    const f = list.find((x) => x.id === p.folderMenu);
    if (!f) return div();
    const n = list.indexOf(f);
    const close = () => closeOverlay(p.overlay);
    const move = (d) => {
      const l = [...list];
      l.splice(n + d, 0, l.splice(n, 1)[0]);
      setShared("space.folders", { list: l, of });
    };
    const item = (id, icon, label, action, right = null) => h_flex()
      .id(id)
      .h(31)
      .px(8)
      .gap(9)
      .rounded(7)
      .items_center()
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click(action)
      .child(icon ? svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none().text_color(t.muted) : div().size(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(right), (el) => el.child(right));
    const elsewhere = (id) => list.find((x) => x.id === of[id] && x.id !== f.id)?.name;
    return v_flex()
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(item("fm-rename", "square-pen", "Rename", () => { close(); promptFolder(f); }))
      .when(n > 0, (el) => el.child(item("fm-up", null, "Move up", () => move(-1))))
      .when(n < list.length - 1, (el) => el.child(item("fm-down", null, "Move down", () => move(1))))
      .child(div().px(8).pt(8).pb(4).text_size(11).text_color(t.dim).child("Spaces in this folder"))
      // A popup sizes to its content, so the list needs a height of its own to scroll in.
      .child(v_flex().id("fm-spaces").flex_none().max_h(31 * 10).overflow_y_scrollbar()
        .children((p.spaces ?? []).map((s) => item(`fm-sp-${s.id}`, null, s.name, () => setFolder(s.id, of[s.id] === f.id ? null : f.id),
          of[s.id] === f.id
            ? svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)
            : elsewhere(s.id) ? div().flex_none().max_w(90).truncate().text_size(11).text_color(t.dim).child(elsewhere(s.id)) : null))))
      .child(div().h(1).my(4).flex_none().bg(t.border))
      .child(item("fm-delete", "x", "Delete folder", () => { close(); deleteFolder(f.id); }));
  }

  submitFolder() {
    const p = props();
    const name = this.text.trim();
    closeOverlay(p.overlay);
    if (!name) return;
    const f = folders();
    const id = p.folderPrompt.id;
    const list = id ? f.list.map((x) => (x.id === id ? { ...x, name } : x)) : [...f.list, { id: `f${Date.now().toString(36)}`, name }];
    setShared("space.folders", { ...f, list });
  }

  renderFolderPrompt(t) {
    const p = props();
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("folder-prompt").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(p.folderPrompt.id ? "Rename folder" : "New folder"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("fp-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("fp-save", "Save", true, () => this.submitFolder())));
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, folder }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .pl(folder ? 22 : 8)
      .pr(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          // Dropped among another folder's spaces (or the unfoldered ones), it joins them.
          if (this.top.has(from) && (folders().of[from] ?? null) !== (folder ?? null)) setFolder(from, folder ?? null);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    if (props()?.folderMenu) return this.renderFolderMenu(t);
    if (props()?.folderPrompt) return this.renderFolderPrompt(t);
    const collapsed = narrow();
    const ungrouping = this.pressed !== null && this.over === "folder-none";
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      // Dropping a foldered space on this header takes it out of its folder.
      .child(h_flex().id("spaces-head").h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(ungrouping ? t.foreground : t.dim)
        .when(ungrouping, el => el.bg(t.hover))
        .on_mouse_move((_e, cx) => {
          if (this.pressed === null || !folders().of[this.pressed] || this.over === "folder-none") return;
          this.over = "folder-none";
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.pressed;
          this.pressed = null;
          this.over = null;
          if (from !== null && this.top.has(from)) setFolder(from, null);
          cx.notify();
        })
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child(ungrouping ? "Spaces · drop to take out of folder" : "Spaces"))
        .child(h_flex().gap(2)
          .when(!collapsed, el => el.child(div().id("folder-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("New folder").on_click(() => promptFolder()).child(svg("mods/workspace-chrome/folder-plus.svg").size(14))))
          .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.pressedFolder = null; this.overFolder = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
