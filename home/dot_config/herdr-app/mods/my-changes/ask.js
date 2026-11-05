// Adapted from herdr-reviewer by Vytas Gavelis, MIT License (LICENSE-herdr-reviewer).
import { agents, focused, openOverlay, notify } from "herdr";

/**
 * The agent a review goes to by default: the preferred address when it is in the space,
 * else the focused agent, else an idle one, else the first one in the space.
 * @param preferred Agent address to favor, such as the one a full review tab was opened from
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
 * @returns "dialog" when the dialog opened, "none" otherwise
 */
export function ask({ title, context, sent, agent }) {
  try {
    openOverlay({ mod: "my-changes", kind: "dialog", width: 720, height: 600, props: { dialog: true, title, context, sent, agent } });
    return "dialog";
  } catch (e) {
    notify({ title: "Couldn't open the send dialog", body: String(e), level: "error" });
    return "none";
  }
}
