// Adapted from herdr-reviewer by Vytas Gavelis, MIT License (LICENSE-herdr-reviewer).
import { agents, focused, openOverlay, notify, setShared } from "herdr";
import { MOD, SENT, PENDING, reviewMessage, remoteItems, generalMessage } from "./store.js";

/**
 * The agent a review goes to by default: the preferred address when it is in the space,
 * else the focused agent, else an idle one, else the first one in the space.
 * @param preferred Agent address to favor, such as the one last focused in the space
 * @returns The agent, or null when the space runs none
 */
export function pickAgent(preferred = null) {
  const space = focused()?.space, list = agents().filter((a) => a.space === space);
  return list.find((a) => a.address === preferred) ?? list.find((a) => a.focused) ?? list.find((a) => a.status === "idle") ?? list[0] ?? null;
}

/**
 * Opens the send dialog (this mod as a dialog overlay) with text for the agent.
 * @param options.title Short label shown in the dialog
 * @param options.context The formatted text the agent receives after the person's note
 * @param options.sent Shared key the dialog sets to the send time once the text went out
 * @param options.agent Preferred agent address
 * @param options.remote PR comments the person may add, from `remoteItems`; they go only when the person opts in
 * @param options.general The context only says what the review is about, so a note or PR comments must go with it
 * @returns "dialog" when the dialog opened, "none" otherwise
 */
export function ask({ title, context, sent = null, agent, remote = null, general = false }) {
  try {
    openOverlay({ mod: MOD, kind: "dialog", width: 720, height: remote ? 660 : 600, props: { dialog: true, title, context, sent, agent: pickAgent(agent)?.address ?? null, remote, general } });
    return "dialog";
  } catch (e) {
    notify({ title: "Couldn't open the send dialog", body: String(e), level: "error" });
    return "none";
  }
}

/**
 * Sends a session's draft comments as one review. They move to the session's history once
 * the dialog reports the send (see `settlePending`). With no drafts, the dialog sends general
 * feedback: the person's note and any PR comments they pick.
 */
export function submitReview(session, comments) {
  if (!comments.length) { ask({ ...generalMessage(session), agent: session.agent, remote: remoteItems(session.remote), general: true }); return; }
  const { title, context, round } = reviewMessage(session, comments);
  setShared(PENDING, { key: session.key, at: Date.now(), round });
  if (ask({ title, context, sent: SENT, agent: session.agent, remote: remoteItems(session.remote) }) === "none") setShared(PENDING, null);
}
