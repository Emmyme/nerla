// Runs before first paint so there is no flash of the wrong theme. Kept as a
// separate file rather than an inline script so the CSP can forbid inline JS.
(function () {
  var root = document.documentElement;
  var media = function (query) {
    return !!(window.matchMedia && window.matchMedia(query).matches);
  };
  try {
    var mode = localStorage.getItem("nerla-mode");
    root.setAttribute("data-theme", "nerla");
    if (mode !== "light" && mode !== "dark") {
      mode = media("(prefers-color-scheme: dark)") ? "dark" : "light";
    }
    root.setAttribute("data-mode", mode);
    root.classList.toggle("dark", mode === "dark");
  } catch (e) {}
  // The last accessibility choices this browser saw, until the account's arrive (src/lib/accessibility.ts)
  var a11y = {};
  try {
    a11y = JSON.parse(localStorage.getItem("nerla-a11y") || "{}") || {};
  } catch (e) {}
  root.setAttribute("data-motion", a11y.reduceMotion === true || media("(prefers-reduced-motion: reduce)") ? "reduce" : "full");
  root.toggleAttribute("data-still", a11y.reduceMotion === true);
  root.setAttribute("data-contrast", a11y.moreContrast === true || media("(prefers-contrast: more)") ? "more" : "normal");
  root.setAttribute("data-reading", a11y.easierReading === true ? "easier" : "normal");
  root.setAttribute("data-text", a11y.largerText === true ? "larger" : "normal");
  root.setAttribute("data-zs", a11y.stillZs === false ? "moving" : "still");
})();
