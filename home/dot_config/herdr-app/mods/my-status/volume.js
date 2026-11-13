import { div, svg } from "gpui-kit";
import { v_flex, Slider, SliderState, SliderTrack, SliderIndicator, SliderThumb } from "gpui-base";
import { exec, theme, settings, closeOverlay, setShared } from "herdr";

/** Popup size in logical px; the status bar uses it to place the popup above the icon. */
export const VOLUME_POPUP = { width: 52, height: 172 };

/** Shared flag the status bar reads to decide whether leaving its icon should close the popup. */
export const VOLUME_HOVER_KEY = "my-status.spotify-volume-hover";

/** Shared flag that is true while the popup is open, so hovering the icon again doesn't stack popups. */
export const VOLUME_OPEN_KEY = "my-status.spotify-volume-open";

/** Delay before closing once the pointer leaves, so it can cross the gap between icon and popup. */
export const VOLUME_CLOSE_DELAY_MS = 300;

const READ_VOLUME = `if application "Spotify" is running then tell application "Spotify" to return sound volume`;

/**
 * Picks the speaker icon for a volume level.
 * @param volume Spotify volume, 0–100
 * @returns Icon path under the app home
 */
export const volumeIcon = (volume) =>
  `mods/my-status/${volume <= 0 ? "volume-x" : volume < 50 ? "volume-1" : "volume-2"}.svg`;

/**
 * The floating volume slider shown by the status bar's speaker icon. Lives in an overlay copy of
 * `my-status` opened with `props.volumePopup`. `initialVolume` seeds the slider until Spotify's live value is read.
 */
export class VolumePopup {
  constructor(overlay, onChange, cx, initialVolume) {
    this.overlay = overlay;
    this.onChange = onChange;
    this.hovered = false;
    this.dragging = false;
    this.pending = null;
    this.sending = false;
    setShared(VOLUME_OPEN_KEY, true);
    setShared(VOLUME_HOVER_KEY, false);

    this.state = SliderState.new({ min: 0, max: 100, step: 1, value: Number.isFinite(initialVolume) ? initialVolume : 50 });
    this.state.on("change", (v, cx) => {
      this.dragging = true;
      this.send(v, cx);
      cx.notify();
    });
    this.state.on("release", (v, cx) => {
      this.dragging = false;
      this.send(v, cx);
      if (!this.hovered) this.scheduleClose(cx);
    });

    cx.spawn(async (cx) => {
      const r = await exec("osascript", ["-e", READ_VOLUME]);
      const n = Number(r.stdout.trim());
      if (r.code === 0 && r.stdout.trim() !== "" && Number.isFinite(n)) {
        this.state.set_value(n);
        this.onChange(n);
        cx.notify();
      }
    });
  }

  // A drag reports every pixel; only the latest value is sent once the previous osascript finishes.
  send(value, cx) {
    this.pending = Math.round(value);
    this.onChange(this.pending);
    if (this.sending) return;
    this.sending = true;
    cx.spawn(async () => {
      while (this.pending !== null) {
        const n = this.pending;
        this.pending = null;
        await exec("osascript", ["-e", `if application "Spotify" is running then tell application "Spotify" to set sound volume to ${n}`]);
      }
      this.sending = false;
    });
  }

  scheduleClose(cx) {
    cx.spawn(async (cx) => {
      await cx.sleep(VOLUME_CLOSE_DELAY_MS);
      if (!this.hovered && !this.dragging) closeOverlay(this.overlay);
    });
  }

  close() {
    setShared(VOLUME_OPEN_KEY, false);
    setShared(VOLUME_HOVER_KEY, false);
  }

  render() {
    const t = theme();
    const volume = Math.round(this.state.value());
    // The overlay window is sized in logical px but element sizes are zoomed units.
    const zoom = Number(settings().zoom) || 1;
    const width = VOLUME_POPUP.width / zoom, height = VOLUME_POPUP.height / zoom;
    // Popups size to their content, so the slider needs a fixed height or its track collapses.
    return v_flex().id("volume-root").w(width).h(height).py(10).gap(8).items_center().text_size(11).text_color(t.muted)
      .on_hover((h, cx) => {
        this.hovered = h;
        setShared(VOLUME_HOVER_KEY, h);
        if (!h && !this.dragging) this.scheduleClose(cx);
      })
      .child(div().child(`${volume}`))
      .child(Slider.new(this.state).axis("vertical").h(height - 72).w(24).child(
        SliderTrack.new(this.state).axis("vertical").flex().justify_center().h_full().w(24).child(
          SliderIndicator.new(this.state).axis("vertical")
            .relative().h_full().w(4).rounded(2).bg(t.border)
            .range_style((fill) => fill.rounded(2).bg(t.accent))
            .child(SliderThumb.new(this.state).axis("vertical").size(12).rounded(6).bg(t.foreground).ml(-4).mb(-6)))))
      .child(svg(volumeIcon(volume)).size(13));
  }
}
