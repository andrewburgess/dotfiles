import { exec, run, notify, agents, panes, focused, openOverlay } from "herdr";

/**
 * A file or folder the menu and viewer act on.
 * @typedef {{ root: string, path: string, dir: boolean, on: string | null, top: string | null }} Target
 * `root` is the folder the panel shows, `path` is relative to it, `top` is its git checkout (if any)
 * and `on` is the machine (null here).
 */

/** @param {Target} target @returns {string} The absolute path. */
export const absolute = (target) => (target.path ? `${target.root}/${target.path}` : target.root);

/** @param {string} p @returns {string} The parent folder of an absolute path. */
const parent = (p) => p.replace(/\/[^/]*$/, "") || "/";

/**
 * A POSIX path from one absolute folder to an absolute path.
 * @param {string} from Folder the result is relative to
 * @param {string} to Absolute path to reach
 * @returns {string} Relative path, or "." when they are the same
 */
export function relative(from, to) {
  const a = from.split("/").filter(Boolean), b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || ".";
}

/**
 * Puts text on this computer's clipboard.
 * @param {string} text Text to copy
 * @returns {Promise<boolean>} Whether it was copied
 */
export async function copyText(text) {
  const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(() => null);
  return r?.code === 0;
}

/**
 * The agent a reference goes to: the focused agent in this space, else an idle one, else the first.
 * @returns {import("herdr").AgentInfo | null}
 */
export function pickAgent() {
  const space = focused()?.space, list = agents().filter((a) => a.space === space);
  return list.find((a) => a.focused) ?? list.find((a) => a.status === "idle") ?? list[0] ?? null;
}

/** @param {string} title @param {string} [body] */
const fail = (title, body) => notify({ title, body, level: "error" });

/** @param {Target} target */
export async function openInCode(target) {
  const abs = absolute(target);
  const r = await exec("code", [abs]).catch(() => null);
  if (r?.code === 0) return;
  const fallback = await exec("open", ["-a", "Visual Studio Code", abs]).catch(() => null);
  if (fallback?.code !== 0) fail("Couldn't open VS Code", (fallback?.stderr || r?.stderr || "").trim().slice(0, 200));
}

/**
 * Starts a Herdr terminal in the folder (a file's own folder), split beside the focused pane,
 * else as a new tab when no pane can be split.
 * @param {Target} target
 */
export function openInTerminal(target) {
  const folder = target.dir ? absolute(target) : parent(absolute(target));
  try {
    if (!focused()?.pane) throw new Error("no pane to split");
    run("terminal.open", { folder, place: "right" });
  } catch {
    try { run("terminal.open", { folder, place: "tab" }); }
    catch (e) { fail("Couldn't open a terminal", String(e)); }
  }
}

/** @param {Target} target @param {boolean} rel Relative to the checkout (else the panel's folder) */
export async function copyPath(target, rel) {
  const abs = absolute(target);
  const text = rel ? relative(target.top ?? target.root, abs) : abs;
  if (await copyText(text)) notify({ title: "Copied", body: text, level: "success", timeout: 2000 });
  else fail("Couldn't copy the path");
}

/** @param {Target} target */
export async function reveal(target) {
  const r = await exec("open", ["-R", absolute(target)]).catch(() => null);
  if (r?.code !== 0) fail("Couldn't reveal in Finder", r?.stderr?.trim());
}

/** @param {Target} target */
export async function openDefault(target) {
  const r = await exec("open", [absolute(target)]).catch(() => null);
  if (r?.code !== 0) fail("Couldn't open the file", r?.stderr?.trim());
}

/**
 * Types `@<path> ` into this space's agent without submitting it. hc can only send text with
 * Enter (and `hc keys` can't type "@"), so this pastes through the clipboard into the agent's
 * focused pane, then puts the previous clipboard text back.
 * @param {Target} target
 * @param {import("gpui-kit").AsyncContext} cx A task's context, for the wait before restoring
 */
export async function referenceInChat(target, cx) {
  const agent = pickAgent();
  if (!agent) return fail("No agent in this space", "Start one, then try again.");
  const cwd = panes().find((p) => p.pane === agent.pane)?.cwd ?? target.root;
  const text = `@${relative(cwd, absolute(target))} `;
  const before = await exec("pbpaste", []).catch(() => null);
  if (!(await copyText(text))) return fail("Couldn't reference the file");
  try {
    run("pane.focus", { terminal: agent.address });
    run("terminal.paste", {});
  } catch {
    return notify({ title: "Copied the reference", body: `Paste ${text.trim()} into the agent.`, level: "info" });
  }
  await cx.sleep(400);
  if (before?.code === 0) await copyText(before.stdout);
}

/**
 * Menu items for a target: [label, icon, action]. Items that only work on this computer are
 * left out for another machine's space.
 * @param {Target} target
 * @returns {[string, string, string][]}
 */
export function menuItems(target) {
  const local = !target.on;
  return [
    ...(local ? [["Open in VS Code", "code", "code"]] : []),
    ["Open in Terminal", "terminal", "terminal"],
    ["Reference in Chat", "at-sign", "chat"],
    ["-", "", ""],
    ["Copy Path", "copy", "copy"],
    ["Copy Relative Path", "link", "copy-relative"],
    ...(local ? [["-", "", ""], ["Reveal in Finder", "search", "reveal"], ["Open with Default App", "external-link", "default"]] : []),
  ];
}

/**
 * Runs a menu or viewer action by its id.
 * @param {string} id One of the ids `menuItems` returns
 * @param {Target} target
 * @param {import("gpui-kit").AsyncContext} cx
 */
export async function act(id, target, cx) {
  switch (id) {
    case "code": return openInCode(target);
    case "terminal": return openInTerminal(target);
    case "chat": return referenceInChat(target, cx);
    case "copy": return copyPath(target, false);
    case "copy-relative": return copyPath(target, true);
    case "reveal": return reveal(target);
    case "default": return openDefault(target);
  }
}

/**
 * Opens the context menu for a row as a popup at the pointer.
 * @param {Target} target
 */
export function openMenu(target) {
  const items = menuItems(target), lines = items.filter((it) => it[0] === "-").length;
  openOverlay({ mod: "my-files", kind: "popup", at: "pointer", width: 250, height: 10 + (items.length - lines) * 30 + lines * 9, props: { menu: target } });
}

/**
 * Opens a file in the viewer dialog.
 * @param {Target} target
 */
export function openViewer(target) {
  openOverlay({ mod: "my-files", kind: "dialog", width: 0.86, height: 0.86, props: { viewer: target } });
}
