/* Demo theme sync for bundled demo apps.
 * Follows the emulator that hosts this iframe (same origin): dark when the OS is
 * dark OR the emulator forces dark via html.demo-force-dark (landing ?theme=dark
 * or a papr-demo-theme postMessage). Standalone, it follows the OS.
 * Sets html[data-theme] for variable-driven demos, and re-keys
 * @media (prefers-color-scheme) rules onto html[data-theme] for apps that theme
 * with media queries (X Action Engine, Meetings, Focus). */
(function () {
  var root = document.documentElement;
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  var forced = null;

  function parentRoot() {
    try {
      if (window.parent !== window) return window.parent.document.documentElement;
    } catch (e) { /* cross-origin host */ }
    return null;
  }
  function isDark() {
    if (forced !== null) return forced;
    var p = parentRoot();
    if (p && p.classList.contains("demo-force-dark")) return true;
    return mq.matches;
  }
  function scope(sel, mode) {
    var pre = "html[data-theme=" + mode + "]";
    return sel.split(",").map(function (s) {
      s = s.trim();
      return s === ":root" || s === "html" ? pre : pre + " " + s;
    }).join(",");
  }
  /* Re-key every prefers-color-scheme rule on html[data-theme] and switch the
     original off, so the emulator's theme wins over the OS in both directions
     (X Action Engine is dark-by-default with a light media override). */
  function rekeySchemeRules() {
    if (document.getElementById("demo-theme-rekeyed")) return;
    var out = [];
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      var rules;
      try { rules = sheet.cssRules; } catch (e) { return; }
      Array.prototype.forEach.call(rules || [], function (r) {
        var m = r.media && /prefers-color-scheme\s*:\s*(dark|light)/i.exec(r.media.mediaText);
        if (!m) return;
        var mode = m[1].toLowerCase();
        Array.prototype.forEach.call(r.cssRules, function (i) {
          if (i.selectorText) out.push(scope(i.selectorText, mode) + "{" + i.style.cssText + "}");
        });
        try { r.media.mediaText = "not all"; } catch (e) { /* leave native rule */ }
      });
    });
    var st = document.createElement("style");
    st.id = "demo-theme-rekeyed";
    st.textContent = out.join("\n");
    document.head.appendChild(st);
  }
  function apply() {
    var d = isDark();
    root.setAttribute("data-theme", d ? "dark" : "light");
    root.style.colorScheme = d ? "dark" : "light";
    root.classList.toggle("demo-force-dark", d);
  }

  apply();
  window.addEventListener("load", function () { rekeySchemeRules(); apply(); });
  if (mq.addEventListener) mq.addEventListener("change", apply);
  var p = parentRoot();
  if (p) new MutationObserver(apply).observe(p, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "papr-demo-theme") { forced = !!e.data.dark; apply(); }
  });
})();
