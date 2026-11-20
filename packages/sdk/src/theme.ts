import type { Theme } from "./types.js";

const FONT_STYLE_ID = "misty-theme-fonts";

/** Sets the host's tokens and fonts on the document so the app matches Misty. Safe to call again. */
export function applyTheme(theme: Theme, doc: Document = document): void {
  const root = doc.documentElement;
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
  root.style.setProperty("--font-sans", theme.fonts.sans);
  root.style.setProperty("--font-mono", theme.fonts.mono);
  root.style.setProperty("color-scheme", theme.mode);
  root.dataset.mistyTheme = theme.mode;

  let style = doc.getElementById(FONT_STYLE_ID);
  if (theme.fonts.css) {
    if (!style) {
      style = doc.createElement("style");
      style.id = FONT_STYLE_ID;
      doc.head.appendChild(style);
    }
    if (style.textContent !== theme.fonts.css) style.textContent = theme.fonts.css;
  } else {
    style?.remove();
  }
}
