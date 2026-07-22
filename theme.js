/* Light / dark toggle.
 *
 * The theme lives in one place — the `data-theme` attribute on <html>, which the
 * inline script in index.html stamps before first paint. Everything visual keys
 * off the two token blocks at the top of style.css; the only consumer that can't
 * read CSS directly is the graph (SVG fills set from JS), so a "themechange"
 * event lets app.js re-read the palette.
 */
(function () {
  "use strict";

  const KEY = "pepys-theme";
  const root = document.documentElement;
  const btn = document.getElementById("theme-toggle");

  function label() {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    btn.setAttribute("aria-label", "Switch to " + next + " mode");
  }

  btn.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try { localStorage.setItem(KEY, root.dataset.theme); } catch (e) { /* private mode */ }
    label();
    window.dispatchEvent(new CustomEvent("themechange"));
  });

  label();
})();
