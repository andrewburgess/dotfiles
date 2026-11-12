// A changed file's action menu: this mod opened as a popup with props { menu: FileTarget }.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { MOD } from "./store.js";
import { menuItems, act } from "./file-actions.js";

export class FileMenu {
  init(_props, cx) {
    this.target = props().menu;
    this.items = menuItems(this.target);
    this.at = this.items.findIndex((it) => it[0] !== "-");
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i, cx) {
    const it = this.items[i];
    if (!it || it[0] === "-") return;
    const overlay = props().overlay;
    cx.spawn(async (cx) => {
      try { await act(it[2], this.target, cx); }
      finally { closeOverlay(overlay); }
    });
  }

  move(step) {
    const n = this.items.length;
    do this.at = (this.at + step + n) % n; while (this.items[this.at][0] === "-");
  }

  render(_cx) {
    const t = theme();
    return v_flex().id("review-file-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(14)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.move(1);
        else if (e.key === "up") this.move(-1);
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(this.items.map((it, i) => it[0] === "-"
        ? div().id(`rf-sep-${i}`).mx(7).my(4).h(1).bg(t.border)
        : h_flex().id(`rf-${i}`).h(30).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(i, cx))
          .child(svg(`mods/${MOD}/${it[1]}.svg`).size(15).flex_none().text_color(t.muted))
          .child(div().flex_1().truncate().child(it[0]))));
  }
}
