// Review comments, the send dialog and syntax colors are adapted from herdr-reviewer
// by Vytas Gavelis, MIT License (LICENSE-herdr-reviewer).
import { View } from "gpui-kit";
import { props } from "herdr";
import { Panel } from "./panel.js";
import { DiffTab } from "./diff.js";
import { Dialog } from "./dialog.js";

/**
 * One mod, three roles by props: the send dialog (`dialog`), a space's diff tab
 * (`diff`, `space`), or the Review panel.
 */
export default class Review extends View {
  init(_props, cx) {
    const p = props() ?? {}, Role = p.dialog ? Dialog : p.diff ? DiffTab : Panel;
    this.role = Object.create(Role.prototype);
    this.role.init(_props, cx);
  }

  render(cx) { return this.role.render(cx); }
}
