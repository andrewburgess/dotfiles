// File actions for a changed file (open in VS Code, a terminal, the agent, copy, Finder),
// adapted from the Files mod's context menu.
import { exec, run, notify, panes, focused, openOverlay } from "herdr";
import { MOD } from "./store.js";
import { pickAgent } from "./ask.js";

/**
 * A changed file the actions work on.
 * @typedef {{ root: string, path: string, on: string | null, status: string, agent: string | null }} FileTarget
 * `root` is the repository, `path` is relative to it, `on` is the machine (null here), `status`
 * is the change letter (A, M, D, U) and `agent` the session's preferred agent address.
 */

/**
 * The target for a file in a review session.
 * @param {{ root: string, on?: string | null, agent?: string | null }} session The shared review session
 * @param {{ path: string, status: string }} file One of the session's files
 * @returns {FileTarget}
 */
export const fileTarget = (session, file) => ({ root: session.root, path: file.path, on: session.on ?? null, status: file.status, agent: session.agent ?? null });

/** @param {FileTarget} target @returns {string} The absolute path. */
export const absolute = (target) => `${target.root}/${target.path}`;

/** @param {string} p @returns {string} The parent folder of an absolute path. */
const parent = (p) => p.replace(/\/[^/]*$/, "") || "/";

/**
 * A POSIX path from one absolute folder to an absolute path.
 * @param {string} from Folder the result is relative to
 * @param {string} to Absolute path to reach
 * @returns {string} Relative path, or "." when they are the same
 */
function relative(from, to) {
  const a = from.split("/").filter(Boolean), b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || ".";
}

/** @param {string} title @param {string} [body] */
const fail = (title, body) => notify({ title, body, level: "error" });

/**
 * Puts text on this computer's clipboard.
 * @param {string} text Text to copy
 * @returns {Promise<boolean>} Whether it was copied
 */
async function copyText(text) {
  const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(() => null);
  return r?.code === 0;
}

/**
 * Opens the file in VS Code, through the `code` command or else the app itself.
 * @param {FileTarget} target
 */
export async function openInCode(target) {
  const abs = absolute(target);
  const r = await exec("code", [abs]).catch(() => null);
  if (r?.code === 0) return;
  const fallback = await exec("open", ["-a", "Visual Studio Code", abs]).catch(() => null);
  if (fallback?.code !== 0) fail("Couldn't open VS Code", (fallback?.stderr || r?.stderr || "").trim().slice(0, 200));
}

/**
 * Starts a Herdr terminal in the file's folder, split beside the focused pane, else as a new tab.
 * @param {FileTarget} target
 */
function openInTerminal(target) {
  const folder = parent(absolute(target));
  try {
    if (!focused()?.pane) throw new Error("no pane to split");
    run("terminal.open", { folder, place: "right" });
  } catch {
    try { run("terminal.open", { folder, place: "tab" }); }
    catch (e) { fail("Couldn't open a terminal", String(e)); }
  }
}

/** @param {FileTarget} target @param {boolean} rel Relative to the repository (else absolute) */
async function copyPath(target, rel) {
  const text = rel ? target.path : absolute(target);
  if (await copyText(text)) notify({ title: "Copied", body: text, level: "success", timeout: 2000 });
  else fail("Couldn't copy the path");
}

/** @param {FileTarget} target */
async function reveal(target) {
  const r = await exec("open", ["-R", absolute(target)]).catch(() => null);
  if (r?.code !== 0) fail("Couldn't reveal in Finder", r?.stderr?.trim());
}

/** @param {FileTarget} target */
async function openDefault(target) {
  const r = await exec("open", [absolute(target)]).catch(() => null);
  if (r?.code !== 0) fail("Couldn't open the file", r?.stderr?.trim());
}

/**
 * Types `@<path> ` into the space's agent without submitting it. hc can only send text with
 * Enter (and `hc keys` can't type "@"), so this pastes through the clipboard into the agent's
 * focused pane, then puts the previous clipboard text back.
 * @param {FileTarget} target
 * @param {import("gpui-kit").AsyncContext} cx A task's context, for the wait before restoring
 */
async function referenceInChat(target, cx) {
  const agent = pickAgent(target.agent);
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
 * Menu items for a file: [label, icon, action]. Items that only work on this computer are left
 * out for another machine's session, and a deleted file only offers copying its path.
 * @param {FileTarget} target
 * @returns {[string, string, string][]}
 */
export function menuItems(target) {
  const local = !target.on, exists = target.status !== "D";
  return [
    ...(exists && local ? [["Open in VS Code", "code", "code"]] : []),
    ...(exists ? [["Open in Terminal", "terminal", "terminal"], ["Reference in Chat", "at-sign", "chat"], ["-", "", ""]] : []),
    ["Copy Path", "copy", "copy"],
    ["Copy Relative Path", "link", "copy-relative"],
    ...(exists && local ? [["-", "", ""], ["Reveal in Finder", "search", "reveal"], ["Open with Default App", "external-link", "default"]] : []),
  ];
}

/**
 * Runs a menu action by its id.
 * @param {string} id One of the ids `menuItems` returns
 * @param {FileTarget} target
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
 * Opens the file's action menu as a popup at the pointer.
 * @param {FileTarget} target
 */
export function openFileMenu(target) {
  const items = menuItems(target), lines = items.filter((it) => it[0] === "-").length;
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 250, height: 10 + (items.length - lines) * 30 + lines * 9, props: { menu: target } });
}
