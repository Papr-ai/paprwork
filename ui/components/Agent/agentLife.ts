/**
 * One motion concept for the agent: "it notices you."
 *  - Eyes glance toward the pointer (max ~2px), then settle back when you stop moving.
 *  - Lids blink at irregular, human-like intervals (3–6s, sometimes twice); a fixed beat reads as mechanical.
 *  - A single acknowledging blink when the pointer reaches an element marked [data-agent-hover].
 * Reduced-motion users get a still face. One shared set of listeners serves every glyph on screen.
 */
const FACE_EYES = ".agent-glyph--face .agent-glyph__eyes";
const MAX_GLANCE = 2.4; // px in the 40-unit viewBox; keeps pupils well inside the outline
const SETTLE_MS = 2200;

let started = false;
let px = 0;
let py = 0;
let raf = 0;
let idle = 0;

function eyes(root: ParentNode = document): NodeListOf<SVGGElement> {
  return root.querySelectorAll<SVGGElement>(FACE_EYES);
}

function glance(): void {
  raf = 0;
  eyes().forEach((g) => {
    const box = g.closest(".agent-glyph")?.getBoundingClientRect();
    if (!box || !box.width) return;
    const dx = px - (box.left + box.width / 2);
    const dy = py - (box.top + box.height / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, dist / 260) * MAX_GLANCE; // near the face: small move; far away: full glance
    g.style.setProperty("--agent-ex", `${((dx / dist) * reach).toFixed(2)}px`);
    g.style.setProperty("--agent-ey", `${((dy / dist) * reach * 0.75).toFixed(2)}px`);
  });
}

function settle(): void {
  eyes().forEach((g) => {
    g.style.setProperty("--agent-ex", "0px");
    g.style.setProperty("--agent-ey", "0px");
  });
}

function blink(root: ParentNode = document): void {
  eyes(root).forEach((g) => {
    const lids = g.firstElementChild;
    if (!(lids instanceof SVGGElement)) return;
    lids.classList.remove("is-blinking");
    void lids.getBoundingClientRect(); // restart the CSS animation
    lids.classList.add("is-blinking");
  });
}

function scheduleBlink(): void {
  window.setTimeout(() => {
    if (!document.hidden) {
      blink();
      if (Math.random() < 0.18) window.setTimeout(() => blink(), 240);
    }
    scheduleBlink();
  }, 2600 + Math.random() * 3800);
}

function onPointerMove(e: PointerEvent): void {
  px = e.clientX;
  py = e.clientY;
  if (!raf) raf = requestAnimationFrame(glance);
  window.clearTimeout(idle);
  idle = window.setTimeout(settle, SETTLE_MS);
}

function onPointerOver(e: PointerEvent): void {
  const target = e.target instanceof Element ? e.target.closest("[data-agent-hover]") : null;
  if (!target) return;
  const from = e.relatedTarget instanceof Element ? e.relatedTarget.closest("[data-agent-hover]") : null;
  if (target !== from) blink(target);
}

/** Idempotent — every AgentGlyph calls this on mount; only the first call wires listeners. */
export function startAgentLife(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerover", onPointerOver, { passive: true });
  document.documentElement.addEventListener("pointerleave", settle);
  window.addEventListener("blur", settle);
  scheduleBlink();
}
