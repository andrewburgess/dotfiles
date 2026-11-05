import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, closeOverlay, theme, settings, readTextFile, exec, appHome, shared, setShared } from "herdr";
import { act, absolute } from "./actions.js";
import { fileIcon } from "./icon-map.js";

// EditorState resolves a language by name or file extension; these send the rest to the closest one it knows.
const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js",
  json5: "json", jsonc: "json", webmanifest: "json", tsbuildinfo: "json", "code-workspace": "json",
  toml: "yaml", yml: "yaml", lock: "yaml",
  svelte: "html", vue: "html", astro: "html", htm: "html", xhtml: "html", hbs: "html", ejs: "html", erb: "html",
  scss: "css", sass: "css", less: "css", pcss: "css", postcss: "css",
  zsh: "sh", bash: "sh", fish: "sh", ksh: "sh", env: "sh", envrc: "sh", bashrc: "sh", zshrc: "sh", profile: "sh",
  mdx: "md", markdown: "md", rst: "md",
  kt: "java", kts: "java", gradle: "groovy",
  hpp: "cpp", hh: "cpp", hxx: "cpp", cc: "cpp", cxx: "cpp", mm: "cpp",
  svg: "xml", plist: "xml", xsd: "xml", csproj: "xml",
  gql: "js", graphql: "js", prisma: "js", proto: "c", swift: "c", dart: "java", tf: "yaml", hcl: "yaml",
  ex: "rb", exs: "rb", rake: "rb", gemspec: "rb", ru: "rb", txt: "txt", log: "txt",
};
// Files known by name rather than extension.
const NAMES = {
  makefile: "makefile", gnumakefile: "makefile", dockerfile: "sh", containerfile: "sh", gemfile: "rb", rakefile: "rb",
  podfile: "rb", brewfile: "rb", vagrantfile: "rb", procfile: "yaml", justfile: "makefile", ".gitignore": "sh",
  ".dockerignore": "sh", ".npmrc": "sh", ".editorconfig": "sh", ".gitattributes": "sh", "cmakelists.txt": "sh",
};
const MAX = 400000;

/**
 * The language name EditorState should highlight a file as.
 * @param {string} name File name without its folder
 * @returns {string}
 */
export function language(name) {
  const lower = name.toLowerCase();
  if (NAMES[lower]) return NAMES[lower];
  if (lower.startsWith(".env")) return "sh";
  if (lower.startsWith("dockerfile")) return "sh";
  const ext = lower.includes(".") ? lower.split(".").pop() : "txt";
  return LANG[ext] ?? ext;
}

/** Token colors matching the Changes panel's theme palette. @param {Record<string, string>} t */
const syntax = (t) => ({ keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi3, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, variable: t.ansi6, operator: t.ansi5, punctuation: t.muted, boolean: t.ansi1 });

const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const BINARY = new Set([
  "pdf", "zip", "gz", "tgz", "tar", "bz2", "xz", "zst", "7z", "rar", "jar", "war", "dmg", "pkg", "iso", "deb", "rpm",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "mp4", "m4v", "mov",
  "avi", "mkv", "webm", "wmv", "flv", "tif", "tiff", "heic", "heif", "avif", "psd", "ai", "sketch", "fig", "xcf",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "pyc", "wasm", "node", "db", "sqlite", "sqlite3",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "numbers", "pages", "odt", "ods", "odp", "parquet", "avro",
]);
// image() only loads from the app home, so local images are copied here while a viewer shows them.
const CACHE = "data/my-files-cache";

/** @param {string} name @returns {string} Lowercase extension, or "" */
const extension = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");

/** @param {number} n @returns {string} */
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** @param {string} s @returns {string} A short stable hash, for cache file names */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** @param {string} text SVG source @returns {{ width: number, height: number } | null} Its intrinsic size */
function svgSize(text) {
  const tag = text.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const attr = (n) => parseFloat(tag.match(new RegExp(`\\s${n}\\s*=\\s*["']?([\\d.]+)(px)?["'\\s>]`, "i"))?.[1] ?? "");
  const box = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  const width = attr("width") || parseFloat(box?.[1] ?? ""), height = attr("height") || parseFloat(box?.[2] ?? "");
  return width > 0 && height > 0 ? { width, height } : null;
}

// localStorage is per mod copy and every viewer is a new copy, so the choice lives in shared state.
const MODE_KEY = "my-files.viewer-mode";

/** The file viewer, drawn when this mod is opened as a dialog with props { viewer: Target }. */
export class FileViewer {
  /** @param {import("gpui-kit").Context} cx */
  constructor(cx) {
    this.target = props().viewer;
    const name = this.target.path.split("/").pop(), ext = extension(name);
    this.kind = MARKDOWN.has(ext) ? "markdown" : ext === "svg" ? "svg" : IMAGES.has(ext) ? "image" : BINARY.has(ext) ? "binary" : "text";
    this.mode = this.kind === "markdown" || this.kind === "svg" ? (shared(MODE_KEY)?.[this.kind] === "source" ? "source" : "rich") : null;
    this.code = null; this.text = null; this.error = null; this.picture = null; this.size = null; this.info = "";
    if (this.kind === "binary") return;
    if (this.kind !== "image") this.load(cx);
    if (this.kind === "image" || this.kind === "svg") this.loadPicture(cx);
  }

  /** @param {import("gpui-kit").Context} cx */
  load(cx) {
    const target = this.target;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(absolute(target), { on: target.on });
        if (text === null) this.error = "This file is no longer available";
        else if (text.includes("\0")) this.error = "Binary file · no text preview";
        else {
          const s = settings();
          this.text = text.length > MAX ? text.slice(0, MAX) + "\n… (file truncated)" : text;
          if (this.kind === "svg") this.size ??= svgSize(text);
          this.code = EditorState.new({
            language: language(target.path.split("/").pop()), readonly: true, value: this.text,
            font_family: s.font_family ?? s.font, font_size: Number(s.font_size) || 14, syntax: syntax(theme()),
          });
        }
      } catch { this.error = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  /** Copies a local image into the cache and reads its size. @param {import("gpui-kit").Context} cx */
  loadPicture(cx) {
    const target = this.target;
    if (target.on) { this.pictureError = "Preview unavailable for images on a remote machine"; return; }
    cx.spawn(async (cx) => {
      try {
        const abs = absolute(target), dir = `${appHome()}/${CACHE}`;
        const st = await exec("stat", ["-f", "%m %z", abs]);
        if (st.code !== 0) throw new Error("This file is no longer available");
        const [mtime, size] = st.stdout.trim().split(" ").map(Number);
        const name = `${hash(abs)}-${mtime}.${extension(abs)}`;
        // Copies from earlier viewers that didn't get to clean up after themselves.
        await exec("sh", ["-c", 'mkdir -p "$1" && find "$1" -type f -mmin +60 -delete; cp "$2" "$1/$3"', "cache", dir, abs, name]);
        this.cached = `${dir}/${name}`;
        if (this.kind === "image") {
          const dims = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs]).catch(() => null);
          const w = Number(dims?.stdout.match(/pixelWidth: (\d+)/)?.[1]), h = Number(dims?.stdout.match(/pixelHeight: (\d+)/)?.[1]);
          if (w > 0 && h > 0) this.size = { width: w, height: h };
        }
        this.picture = `${CACHE}/${name}`;
        this.info = bytes(size);
      } catch (e) { this.pictureError = e instanceof Error ? e.message : "Cannot show this image"; }
      finally { cx.notify(); }
    });
  }

  /** Releases the editor and removes this viewer's cached image. */
  async release() {
    this.code?.release();
    if (this.cached) await exec("rm", ["-f", this.cached]).catch(() => null);
  }

  /**
   * @param {string} id Element id
   * @param {string} icon Name of an svg in this mod
   * @param {string} label
   * @param {(e: unknown, cx: import("gpui-kit").Context) => void} onClick
   * @param {Record<string, string>} t
   */
  button(id, icon, label, onClick, t) {
    return h_flex().id(id).h(30).px(10).gap(6).items_center().rounded(7).cursor_pointer().border_1().border_color(t.border)
      .text_size(14).font_medium().text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(svg(`mods/my-files/${icon}.svg`).size(14).flex_none().text_color(t.muted))
      .when(Boolean(label), (el) => el.child(div().child(label)));
  }

  /** The Rich / Source switch. @param {Record<string, string>} t */
  toggle(t) {
    const segment = (mode, label) => div().id(`mfv-mode-${mode}`).h(26).px(10).flex().items_center().rounded(5).cursor_pointer().text_size(14)
      .text_color(this.mode === mode ? t.foreground : t.muted)
      .when(this.mode === mode, (el) => el.bg(t.selected))
      .when(this.mode !== mode, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => {
        this.mode = mode;
        setShared(MODE_KEY, { ...shared(MODE_KEY), [this.kind]: mode });
        cx.notify();
      })
      .child(label);
    return h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border).child(segment("rich", "Rich")).child(segment("source", "Source"));
  }

  /** @param {Record<string, string>} t @param {string} text */
  message(t, text, withOpen) {
    const overlay = props().overlay;
    return v_flex().flex_1().min_h(0).items_center().justify_center().gap(12).text_size(13).text_color(t.dim)
      .child(div().child(text))
      .when(withOpen && !this.target.on, (el) => el.child(this.button("mfv-default", "external-link", "Open with Default App",
        (_e, cx) => cx.spawn(async (cx) => { await act("default", this.target, cx); closeOverlay(overlay); }), t)));
  }

  /** The image, contained in the space below the header. @param {Record<string, string>} t */
  picturePane(t) {
    if (!this.picture) return this.message(t, this.pictureError || "Loading image…", Boolean(this.pictureError) && !this.target.on);
    const zoom = Number(settings().zoom) || 1, area = this.area, pad = 24;
    let el = image(this.picture);
    if (this.size && area) {
      const room = { width: area.width / zoom - pad * 2, height: area.height / zoom - pad * 2 };
      const limit = this.kind === "svg" ? Infinity : 1;
      const scale = Math.max(0.01, Math.min(limit, room.width / this.size.width, room.height / this.size.height));
      el = el.w(this.size.width * scale).h(this.size.height * scale);
    } else el = el.size_full();
    return div().id("mfv-picture").flex_1().min_h(0).flex().items_center().justify_center().p(pad).bg(t.canvas ?? t.background)
      .on_size_change((size, cx) => { this.area = size; cx.notify(); })
      .child(el);
  }

  /** @param {Record<string, string>} t */
  body(t) {
    if (this.kind === "binary") return this.message(t, "Binary file · no preview", true);
    if (this.kind === "image" || (this.kind === "svg" && this.mode === "rich")) return this.picturePane(t);
    if (!this.code) return this.message(t, this.error || "Loading file…", false);
    if (this.kind === "markdown" && this.mode === "rich")
      return div().id("mfv-markdown").flex_1().min_h(0).overflow_y_scrollbar().px(32).py(20).text_size(16).line_height("25px").text_color(t.foreground)
        .child(TextView.markdown("mfv-md", this.text).selectable(true));
    return Editor.new(this.code).flex_1().min_h(0);
  }

  /** @param {import("gpui-kit").Context} _cx */
  render(_cx) {
    const t = theme(), target = this.target, overlay = props().overlay;
    const then = (id, close) => (_e, cx) => cx.spawn(async (cx) => {
      await act(id, target, cx);
      if (close) closeOverlay(overlay);
    });
    const details = [this.size && `${Math.round(this.size.width)} × ${Math.round(this.size.height)}`, this.info].filter(Boolean).join(" · ");
    return v_flex().id("my-files-viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14)
      .child(h_flex().h(54).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(image(fileIcon(target.path.split("/").pop(), settings().dark !== false)).size(18).flex_none())
        .child(div().flex_shrink_1().min_w(0).truncate().text_size(16).font_semibold().child(target.path))
        .when(Boolean(details), (el) => el.child(div().flex_none().text_size(13).text_color(t.dim).child(details)))
        .child(div().flex_1())
        .when(Boolean(this.mode), (el) => el.child(this.toggle(t)))
        .when(!target.on, (el) => el.child(this.button("mfv-code", "code", "Open in VS Code", then("code", true), t)))
        .child(this.button("mfv-chat", "at-sign", "Reference in Chat", then("chat", true), t))
        .child(this.button("mfv-copy", "copy", "Copy Path", then("copy", false), t))
        .child(this.button("mfv-close", "x", "", () => closeOverlay(overlay), t)))
      .child(this.body(t));
  }
}
