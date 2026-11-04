/**
 * The brief's freeform "Overnight" section is short HTML from the user's own agent (<p>, <strong>, <em>…).
 * Home rendered it as-is; here only formatting tags survive and every attribute except a safe href is dropped.
 */
const ALLOWED = new Set(["P", "STRONG", "B", "EM", "I", "BR", "UL", "OL", "LI", "A", "CODE", "SPAN"]);

export function safeHtml(html: string | undefined): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (!ALLOWED.has(child.tagName)) {
        child.replaceWith(...(["SCRIPT", "STYLE", "IFRAME", "OBJECT"].includes(child.tagName) ? [] : [doc.createTextNode(child.textContent ?? "")]));
        continue;
      }
      const href = child.tagName === "A" ? child.getAttribute("href") : null;
      for (const a of [...child.attributes]) child.removeAttribute(a.name);
      if (href && /^https:\/\//i.test(href)) {
        child.setAttribute("href", href);
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener");
      }
      walk(child);
    }
  };
  const root = doc.body.firstElementChild!;
  walk(root);
  return root.innerHTML;
}
