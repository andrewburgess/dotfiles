// Adapted from herdr-reviewer by Vytas Gavelis, MIT License (LICENSE-herdr-reviewer).
// The send dialog: this mod opened as a dialog overlay with props
// { dialog: true, title, context, sent, agent }. The note and context go to the
// chosen agent as one message with `hc send`, only while that agent is idle.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Popover } from "gpui-base";
import { agents, focused, hc, run, notify, props, closeOverlay, theme, settings, setShared } from "herdr";

const busy = (a) => a?.status === "working" || a?.status === "blocked";

export class Dialog {
  init(_props, cx) {
    const p = props() ?? {};
    this.context = String(p.context ?? ""); this.title = p.title ?? "";
    this.note = ""; this.pick = p.agent ?? null; this.error = null; this.sending = false; this.choosing = false; this.copied = false;
    this.input = TextareaState.new({ placeholder: this.context ? "Your note to the agent (optional)…" : "What do you want to ask?", rows: this.context ? 2 : 3 });
    this.input.set_auto_grow(this.context ? 2 : 3, this.context ? 4 : 6);
    this.input.on("change", (_e, cx) => { this.note = this.input.value(); this.error = null; cx.notify(); });
    this.input.on("submit", (e, cx) => { if (!e?.shift) this.send(cx); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  close() { closeOverlay(props().overlay); }

  candidates() {
    const space = focused()?.space;
    return agents().filter((a) => a.space === space);
  }

  target() {
    const list = this.candidates();
    return list.find((a) => a.address === this.pick) ?? list.find((a) => a.focused) ?? list.find((a) => a.status === "idle") ?? list[0] ?? null;
  }

  text() { return [this.note.trim(), this.context.trim()].filter(Boolean).join("\n\n"); }

  send(cx) {
    const text = this.text(), agent = this.target();
    if (this.sending) return;
    if (!text) { this.error = "Type a note first"; cx.notify(); return; }
    if (!agent) { this.start(cx); return; }
    // Pasting into a busy agent's input can interleave with what it is doing; wait for idle.
    if (busy(agent)) { this.error = `${this.name(agent)} is ${agent.status}. Wait until it is idle, or pick another agent.`; cx.notify(); return; }
    this.sending = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", agent.address, text]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      this.sending = false;
      if (r.code === 0) {
        this.close();
        notify({ title: `Sent to ${this.name(agent)}`, body: this.title || this.note.trim().slice(0, 80), level: "success" });
        if (props()?.sent) setShared(props().sent, Date.now());
        run("pane.focus", { terminal: agent.address });
      } else { this.error = (r.stderr || r.stdout).trim().slice(0, 300) || "hc send failed"; cx.notify(); }
    });
  }

  /** No agent in the space: start Claude in a new tab with the text as its first message. */
  start(cx) {
    const f = focused(), text = this.text();
    if (!f?.space) { this.error = "No space is shown"; cx.notify(); return; }
    this.close();
    run("tab.new", { space: f.space, argv: ["claude"], task: text });
    if (props()?.sent) setShared(props().sent, Date.now());
    notify({ title: "Started Claude with your review", level: "success" });
  }

  name(a) { return a.program?.name ?? a.app ?? a.address; }

  render(cx) {
    const t = theme(), list = this.candidates(), agent = this.target(), blocked = busy(agent);
    const button = (id, text, primary, action, disabled) => h_flex().id(id).h(34).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(14).font_medium()
      .when(disabled, (e) => e.opacity(0.5)).when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action)).child(text);
    const lines = this.context.split("\n"), shown = lines.slice(0, 600);
    const width = Math.max(...shown.map((l) => l.length)) * 7.8 + 24;
    const dot = (a) => div().size(8).rounded(4).bg(t[a.status] ?? t.unknown);
    const agentBox = (a, opens) => h_flex().id("to-box").h(30).px(10).gap(8).items_center().rounded(7).border_1().border_color(this.choosing ? t.accent : t.input).bg(t.raised)
      .when(opens, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .child(dot(a)).child(div().text_size(14).child(`${this.name(a)} · ${a.tab_name}`)).child(div().text_size(12).text_color(t.dim).child(a.status))
      .when(opens, (e) => e.child(svg("mods/review/chevron-down.svg").size(12).text_color(t.dim)));
    return v_flex().id("ask-agent").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        else if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.send(cx); cx.stop_propagation(); }
      })
      .size_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(14)
      .child(h_flex().items_center().gap(8)
        .child(div().text_size(16).font_semibold().child("Send to agent"))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.dim).child(this.title))
        .child(div().text_size(12).text_color(t.dim).child("Esc")))
      .child(!list.length
        ? div().text_size(13).text_color(t.muted).child("No agent is running in this space. Send starts Claude in a new tab with this text.")
        : h_flex().gap(8).items_center()
          .child(div().text_size(13).text_color(t.dim).child("To"))
          .child(list.length > 1
            ? Popover.new("to").open(this.choosing).on_open_change((open, cx) => { this.choosing = open; cx.notify(); })
              .trigger(agentBox(agent, true))
              .content(v_flex().mt(4).min_w(280).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md().children(list.map((a) =>
                h_flex().id(`to-${a.address}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => { this.pick = a.address; this.error = null; this.choosing = false; cx.notify(); })
                  .child(dot(a))
                  .child(div().flex_1().text_size(14).child(`${this.name(a)} · ${a.tab_name}`))
                  .child(div().text_size(12).text_color(t.dim).child(a.status))
                  .child(a.address === agent?.address ? svg("mods/review/check.svg").size(12).text_color(t.accent) : div().w(12)))))
            : agentBox(agent, false)))
      .child(Textarea.new(this.input).w_full().px(10).py(8).rounded(9).border_1().border_color(t.input).bg(t.background).text_size(14).text_color(t.foreground))
      .when(Boolean(this.context), (el) => el.child(v_flex().flex_1().min_h(100).gap(4)
        .child(h_flex().items_center().gap(6)
          .child(div().text_size(13).text_color(t.dim).child(`Sent after your note · ${lines.length} lines`))
          .child(div().flex_1())
          .child(h_flex().id("context-copy").h(22).px(6).gap(4).items_center().rounded(4).text_size(13).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground).bg(t.hover))
            .on_click((_e, cx) => { try { cx.write_to_clipboard(this.context); this.copied = true; } catch (e) { this.error = `Copy failed: ${e}`; } cx.notify(); })
            .child(svg(`mods/review/${this.copied ? "check" : "copy"}.svg`).size(12)).child(this.copied ? "Copied" : "Copy")))
        .child(div().id("ask-context-x").flex_1().min_h(0).rounded(8).border_1().border_color(t.border).bg(t.background).overflow_x_scrollbar()
          .child(v_flex().id("ask-context").h_full().min_w(width).overflow_y_scrollbar().p(8)
            .font_family(settings().font_family ?? "JetBrains Mono").text_size(13).text_color(t.muted).whitespace_nowrap()
            .children(shown.map((l) => div().h(19).flex_none().child(l || " ")))
            .when(lines.length > shown.length, (el) => el.child(div().text_color(t.dim).child(`… ${lines.length - shown.length} more lines are sent too`)))))))
      .when(this.context.length > 8000, (el) => el.child(div().text_size(13).text_color(t.blocked).whitespace_normal().child(`This is ${(this.context.length / 1024).toFixed(0)} KB pasted into the agent's terminal; some agents are slow or cut it short at this size.`)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(13).text_color(t.ansi1).whitespace_normal().child(this.error)))
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(blocked ? t.blocked : t.dim)
          .child(blocked ? `${this.name(agent)} is ${agent.status}; sending waits for idle` : agent ? `cmd-enter sends · goes to ${this.name(agent)} as one message` : "cmd-enter sends"))
        .child(button("ask-cancel", "Cancel", false, () => this.close()))
        .child(button("ask-send", this.sending ? "Sending…" : agent ? "Send" : "Start Claude", true, (_e, cx) => this.send(cx), this.sending || blocked)));
  }
}
