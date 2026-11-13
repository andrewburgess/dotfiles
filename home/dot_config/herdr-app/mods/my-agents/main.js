// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, exec, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";

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

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

/**
 * Where a space is now, the way the spaces sidebar reads it: its first terminal's live
 * folder, else where it was made, keyed with its machine.
 * @param s A space
 * @param ps panes(), read once by the caller
 * @returns JSON `[machine, folder]`
 */
const placeKey = (s, ps) => {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return JSON.stringify([s.machine ?? null, ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder]);
};

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
  { id: "starter", label: "Grouped by starter", icon: "git-branch" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    // placeKey -> { repo, linked } from git, null when not a repo; absent until looked up.
    this.repos = {};
    this.asking = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Asks git which repo a place belongs to and whether it is a linked worktree.
  lookupRepo(key, cx) {
    if (key in this.repos || this.asking.has(key)) return;
    this.asking.add(key);
    const [on, cwd] = JSON.parse(key);
    cx.spawn(async (cx) => {
      try {
        const [top, common] = await Promise.all([
          exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
          exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
        ]);
        if (top.code !== 0 || common.code !== 0) this.repos[key] = null;
        else {
          const repo = common.stdout.replace(/\n$/, "");
          this.repos[key] = { repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.replace(/\n$/, "")}/.git` };
        }
      } catch {
        // The machine is away: leave it unknown so a later render asks again.
      }
      this.asking.delete(key);
      cx.notify();
    });
  }

  /**
   * Each space's home for grouping: a worktree space goes under its repo's main checkout
   * space, as the spaces sidebar nests it, or under the repo's name when no space holds it.
   * @returns Space id to `{ id, name }`
   */
  homes(cx) {
    const sp = spaces(), ps = panes();
    const info = new Map(sp.map((s) => {
      const key = placeKey(s, ps);
      this.lookupRepo(key, cx);
      return [s.id, this.repos[key] ?? null];
    }));
    const mains = new Map();
    for (const s of sp) {
      const g = info.get(s.id);
      if (g && !g.linked && !mains.has(g.repo)) mains.set(g.repo, { id: s.id, name: s.name });
    }
    return new Map(sp.map((s) => {
      const g = info.get(s.id);
      if (!g?.linked) return [s.id, { id: s.id, name: s.name }];
      return [s.id, mains.get(g.repo) ?? { id: g.repo, name: base(JSON.parse(g.repo)[1]).replace(/\.git$/, "") }];
    }));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  /**
   * Live terminals that another terminal started (`parent` is set), grouped under their
   * top-most live ancestor, then by the space each started subtree sits in, both ordered
   * most urgent first. A terminal whose starter has ended heads its own group.
   * @param all Every core terminal
   * @param parentOf Live address to its starter's address, or null
   * @param agentList Agents, for naming a starter that is one and placing terminals in spaces
   * @param homes Space id to its repo's main space `{ id, name }` (see homes()), which
   *   heads a worktree space's group and starter labels, with the worktree in `sub`
   * @returns Groups of `{ id, label, sub, program, entries, spaces }`; entries are tree rows
   *   for subRow, and `spaces` splits them into `{ id, label, sub, entries }`; `sub` is a
   *   header's second line, or null
   */
  families(all, parentOf, agentList, homes) {
    const topOf = (addr) => {
      let cur = addr;
      for (let i = 0; i < 32; i++) {
        const p = parentOf.get(cur);
        if (!p || !parentOf.has(p)) return cur;
        cur = p;
      }
      return cur;
    };
    const roots = [...new Set([...parentOf].filter(([, p]) => p).map(([addr]) => topOf(addr)))];
    const byAddress = new Map(all.map((k) => [k.address, k]));
    const agentOf = new Map(agentList.map((a) => [a.address, a]));
    // A terminal without a pane has no space of its own; it shows in its nearest ancestor's.
    // A worktree space reads as its repo's space over the worktree.
    const spaceOf = (addr) => {
      for (let cur = addr, i = 0; cur && i < 32; cur = parentOf.get(cur), i++) {
        const a = agentOf.get(cur);
        if (!a) continue;
        const home = homes.get(a.space);
        return home && home.id !== a.space ? { id: a.space, name: home.name, sub: a.space_name } : { id: a.space, name: a.space_name };
      }
      return { id: "", name: "Elsewhere" };
    };
    const order = new Map(spaces().map((s, i) => [s.id, i]));
    const rankOfEntries = (entries) => Math.max(0, ...entries.map((e) => RANK[kidStatus(e.t, this.listed)] ?? 0));
    const out = roots.map((root) => {
      const term = byAddress.get(root);
      const orphan = Boolean(parentOf.get(root));
      const tops = orphan ? [term] : all.filter((k) => k.parent === root && k.state === "live");
      const bySpace = new Map();
      for (const k of tops) {
        const sp = spaceOf(k.address);
        if (!bySpace.has(sp.id)) bySpace.set(sp.id, { ...sp, tops: [] });
        bySpace.get(sp.id).tops.push(k);
      }
      // Tree lines restart in each space, so its last subtree closes with \u2514.
      const groups = [...bySpace.values()].map((sp) => {
        const entries = orphan
          ? [{ t: term, lines: [] }, ...this.tree(all, root, [""])]
          : sp.tops.flatMap((k, i) => {
            const last = i === sp.tops.length - 1;
            return [{ t: k, lines: [last ? "\u2514" : "\u251c"] }, ...this.tree(all, k.address, [last ? "" : "\u2502"])];
          });
        return { id: `fam-${root}-sp-${sp.id}`, label: sp.name || "Elsewhere", sub: sp.sub ?? null, entries, rank: rankOfEntries(entries), at: order.get(sp.id) ?? Infinity };
      }).sort((x, y) => y.rank - x.rank || x.at - y.at);
      const entries = groups.flatMap((g) => g.entries);
      const a = agentOf.get(root);
      // "via <space>" over the worktree and tab, when there are any.
      const home = a && homes.get(a.space);
      const worktree = home && home.id !== a.space;
      const named = (x) => x && !/^\d+$/.test(x);
      const name = a ? (worktree ? home.name : a.space_name) || a.program?.name : term?.name || term?.program?.name || root;
      const label = orphan ? `via ${parentOf.get(root)} (ended)` : `via ${name || root}`;
      const sub = orphan || !a ? null : [worktree ? a.space_name : null, a.tab_name].filter(named).join(" \u00b7 ") || null;
      return { id: `fam-${root}`, label, sub, program: orphan ? null : (a?.program ?? term?.program), entries, spaces: groups, rank: rankOfEntries(entries) };
    });
    return out.filter((f) => f.entries.length).sort((x, y) => y.rank - x.rank);
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    // A sub-agent kept as a pane is focused there; one without a pane opens as a peek.
    const pane = this.panesByAddress?.get(k.address);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (pane ? run("pane.focus", { pane }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const byStarter = sort.id === "starter";
    // Rows without a space header above them name their space.
    const flat = byPriority || byStarter;
    this.panesByAddress = new Map(list.map((a) => [a.address, a.pane]));
    const parentOf = new Map(all.filter((k) => k.state === "live").map((k) => [k.address, k.parent ?? null]));
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (flat) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    let rest = list.filter((a) => !a.pinned);
    const families = byStarter ? this.families(all, parentOf, list, this.homes(cx)) : [];
    if (byStarter) {
      rest = rest.filter((a) => !parentOf.get(a.address));
      const started = families.flatMap((f) => f.entries.map((e) => e.t.address));
      const byAddress = new Map(list.map((a) => [a.address, a]));
      list = [...pinned, ...rest, ...started.map((addr) => byAddress.get(addr)).filter((a) => a && !a.pinned)];
    } else {
      list = [...pinned, ...rest];
    }
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed || byStarter ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = flat || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // How many are in each status, most urgent first, as "1 ⟳  2 ○".
    const tally = (statuses) => {
      const counts = {};
      for (const s of statuses) { const k = s in RANK ? s : "idle"; counts[k] = (counts[k] ?? 0) + 1; }
      return h_flex().flex_none().gap(8).items_center().children(Object.keys(RANK).sort((x, y) => RANK[y] - RANK[x]).filter((s) => counts[s]).map((s) =>
        h_flex().gap(3).items_center().child(div().text_size(11).text_color(t.dim).child(String(counts[s]))).child(this.status(t, { status: s }, true))));
    };

    // In the starter view, each agent-started group sits under the terminal that started it,
    // split by space; `nested` indents a space's header under its starter's.
    const familyHeader = (f, nested = false) => {
      const open = !this.folded.has(f.id);
      return h_flex()
        .id(f.id)
        .pl(nested ? 22 : 8)
        .pr(8)
        .h(f.sub ? 38 : 26)
        .flex_none()
        .gap(7)
        .items_center()
        .rounded(8)
        .text_size(11)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          open ? this.folded.add(f.id) : this.folded.delete(f.id);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
        .when(Boolean(f.program), (el) => { const pic = icon(f.program, 13, t.muted); return pic ? el.child(pic) : el; })
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.muted).child(f.label))
          .when(Boolean(f.sub), (el) => el.child(div().truncate().text_color(t.dim).child(f.sub))))
        .child(tally(f.entries.map((e) => kidStatus(e.t, this.listed))));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    if (byStarter) {
      if (rest.length) groups.push({ id: "direct", label: "Direct", status: null, members: rest });
      if (families.length) groups.push({
        id: "started",
        label: "Started by agents",
        status: null,
        members: families.flatMap((f) => f.entries.map((e) => ({ status: kidStatus(e.t, this.listed) }))),
        rows: () => families.flatMap((f) => [familyHeader(f), ...(this.folded.has(f.id) ? [] : f.spaces.flatMap((sp) => [
          familyHeader(sp, true),
          ...(this.folded.has(sp.id) ? [] : sp.entries.map((e) => this.subRow(t, e, shown, true))),
        ]))]),
      });
    }
    for (const a of byStarter ? [] : rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. It counts members by status, except in a
    // priority section, where they share one; folded, it always counts.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(Boolean(g.status) && (flat || !open), (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!g.status && (flat || !open), (el) => el.child(tally(g.members.map((a) => a.status))))
        .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.rows ? g.rows() : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "my-agents", kind: "popup", width: 200, height: 172, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
