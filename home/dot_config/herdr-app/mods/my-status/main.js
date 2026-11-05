import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, props, settings, shared, openOverlay, closeOverlay } from "herdr";
import { VolumePopup, VOLUME_POPUP, VOLUME_HOVER_KEY, VOLUME_OPEN_KEY, VOLUME_CLOSE_DELAY_MS, volumeIcon } from "./volume.js";

/** How often the Spotify segment re-reads the player, in ms. */
const SPOTIFY_POLL_MS = 3000;

// The `is running` guard keeps polling from launching Spotify when it's closed.
const SPOTIFY_READ = `if application "Spotify" is running then
  tell application "Spotify"
    if player state is stopped then return "stopped"
    return (player state as string) & linefeed & (artist of current track) & linefeed & (name of current track) & linefeed & (sound volume as string)
  end tell
end if
return "closed"`;

/**
 * Sends a command to Spotify only if it's already running.
 * @param verb AppleScript player command, such as `playpause` or `next track`
 */
const spotifyCommand = (verb) => `if application "Spotify" is running then tell application "Spotify" to ${verb}`;

export default class MyStatus extends View {
  init(_props, cx) {
    const p = props();
    if (p?.volumePopup) {
      this.popup = new VolumePopup(p.overlay, () => {}, cx);
      return;
    }
    this.spotify = null;
    cx.timer.every(SPOTIFY_POLL_MS, (cx) => this.refreshSpotify(cx));
    this.refreshSpotify(cx);
  }

  refreshSpotify(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("osascript", ["-e", SPOTIFY_READ]);
      const [state, artist, track, volume] = r.code === 0 ? r.stdout.trim().split("\n") : [];
      const next = state === "playing" || state === "paused" ? { playing: state === "playing", artist, track, volume: Number(volume) } : null;
      if (JSON.stringify(next) !== JSON.stringify(this.spotify)) {
        this.spotify = next;
        cx.notify();
      }
    });
  }

  control(verb, cx) {
    cx.spawn(async (cx) => {
      await exec("osascript", ["-e", spotifyCommand(verb)]);
      this.refreshSpotify(cx);
    });
  }

  // Mouse bounds are unzoomed window px while overlay positions are logical px.
  openVolume(bounds) {
    if (shared(VOLUME_OPEN_KEY)) return;
    const zoom = Number(settings().zoom) || 1;
    const x = (bounds.x + bounds.width / 2) / zoom - VOLUME_POPUP.width / 2;
    const y = bounds.y / zoom - VOLUME_POPUP.height - 6;
    this.volumePopup = openOverlay({ mod: "my-status", kind: "popup", ...VOLUME_POPUP, at: { x, y }, props: { volumePopup: true } });
  }

  leaveVolume(cx) {
    cx.spawn(async (cx) => {
      await cx.sleep(VOLUME_CLOSE_DELAY_MS);
      if (!this.volumeHovered && !shared(VOLUME_HOVER_KEY) && this.volumePopup) {
        closeOverlay(this.volumePopup);
        this.volumePopup = null;
      }
    });
  }

  spotifySegment(t) {
    const s = this.spotify;
    if (!s) return null;
    const button = (id, icon, verb) =>
      div().id(id).p(3).rounded(4).text_color(t.muted).hover((el) => el.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.control(verb, cx))
        .child(svg(`mods/my-status/${icon}.svg`).size(11));
    return h_flex().gap(8).items_center()
      .child(h_flex().id("spotify-info").gap(6).items_center().max_w(320).text_color(s.playing ? t.muted : t.dim)
        .on_click(() => exec("open", ["-a", "Spotify"]))
        .child(svg("mods/my-status/music.svg").size(13))
        .child(div().truncate().child(`${s.artist} — ${s.track}`)))
      .child(h_flex().gap(2).items_center()
        .child(button("spotify-prev", "skip-back", "previous track"))
        .child(button("spotify-toggle", s.playing ? "pause" : "play", "playpause"))
        .child(button("spotify-next", "skip-forward", "next track"))
        .child(div().id("spotify-volume").p(3).rounded(4).text_color(t.muted).hover((el) => el.bg(t.hover).text_color(t.foreground))
          .on_mouse_move((e) => this.openVolume(e.bounds))
          .on_hover((h, cx) => {
            this.volumeHovered = h;
            if (!h) this.leaveVolume(cx);
          })
          .child(svg(volumeIcon(Number.isFinite(s.volume) ? s.volume : 100)).size(12))));
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  close() {
    this.popup?.close();
  }

  render() {
    if (this.popup) return this.popup.render();
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const spotify = this.spotifySegment(t);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)))
      .when(Boolean(spotify), el => el.child(spotify));
  }
}
