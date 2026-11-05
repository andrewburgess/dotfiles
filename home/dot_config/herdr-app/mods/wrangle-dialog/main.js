// Starts `/wrangle:start <issue>` in a Claude tab named `#<issue>` in the `product` space,
// after collecting optional extra context. Props: { issue: number, title?: string, overlay }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, EditorState, Editor } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, home, settings } from "herdr";

const SPACE_NAME = "product";

/** @returns The local `product` space, if one is open */
function productSpace() {
  return spaces().find((s) => !s.machine && s.name === SPACE_NAME) ?? null;
}

/**
 * Builds the first message for the wrangle agent.
 * @param issue Issue number
 * @param extra Free-form context; labeled so wrangle doesn't read it as a mode like `resume`
 * @returns The prompt Claude starts with
 */
function wranglePrompt(issue, extra) {
  const base = `/wrangle:start ${issue}`;
  return extra ? `${base}\n\nAdditional context:\n${extra}` : base;
}

export default class WrangleDialog extends View {
  init(_props, cx) {
    this.editor = EditorState.new({
      language: "markdown",
      line_numbers: false,
      folding: false,
      soft_wrap: true,
      font_family: settings().font_family,
      font_size: 13,
    });
    this.handle = cx.focus_handle();
  }

  existingTab(issue) {
    return productSpace()?.tabs.find((tab) => tab.name === `#${issue}`) ?? null;
  }

  start() {
    const { issue, overlay } = props();
    const name = `#${issue}`;
    // Claude takes the prompt as an argument, so it arrives even before the agent is ready.
    const argv = ["claude", wranglePrompt(issue, this.editor.value().trim())];
    const folder = `${home()}/Projects/product`;
    const space = productSpace();
    closeOverlay(overlay);
    if (space) {
      run("space.select", { id: space.id });
      run("tab.new", { space: space.id, name, folder, argv });
    } else {
      run("space.new", { name: SPACE_NAME, folder, tab: name, argv });
    }
  }

  goTo(tab) {
    closeOverlay(props().overlay);
    run("space.select", { id: productSpace().id });
    run("tab.select", { id: tab.id });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const existing = p.issue != null ? this.existingTab(p.issue) : null;
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("wrangle-dialog").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(15).font_semibold().child(`Wrangle #${p.issue ?? "?"}`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(p.title), (el) => el.child(div().pt(4).text_size(12.5).text_color(t.muted).child(p.title)))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Additional context (optional)"))
      .child(div().h(160).p(8).rounded(9).border_1().border_color(t.input).bg(t.background).overflow_hidden()
        .child(Editor.new(this.editor)))
      .child(div().pt(6).text_size(11.5).text_color(existing ? t.blocked : t.dim).child(existing
        ? `A ${SPACE_NAME} tab named #${p.issue} is already open.`
        : `Opens Claude in a new #${p.issue} tab in the ${SPACE_NAME} space.`))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("wd-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .when(Boolean(existing), (el) => el.child(button("wd-go", `Go to #${p.issue}`, false, () => this.goTo(existing))))
        .child(button("wd-start", "Start wrangle", true, () => this.start())));
  }
}
