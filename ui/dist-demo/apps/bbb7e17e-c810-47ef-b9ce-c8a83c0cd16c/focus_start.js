/* First run — "What are you working toward?". Both buttons stay on Home instead of detouring into chat:
     Draft my goals → Pen ranks what it already knows (IDENTITY.md goals, onboarding OKRs, chats, logs)
                      via /api/workspace/focus and shows its picks to confirm (three_edit.js).
     I'll tell you  → the same page with a blank slot, so the user writes their own three.
   Only when Pen has nothing at all to rank (no goals, no onboarding) does drafting fall back to a chat —
   that genuinely needs a conversation, and the result flows back here via IDENTITY.md. */
const FocusStart = {
  async draft(btn) {
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Pen is picking…'; }
    await Three.load();
    if (btn) { btn.disabled = false; btn.textContent = label; }
    if (Three.has()) { Three.show('edit'); return; }
    const msg = typeof Goals !== 'undefined' ? Goals.prompt('draft') : 'Draft my goals for me.';
    if (window.paprAPI?.invoke) window.paprAPI.invoke('chat.open', { message: msg });
  },
  write() {
    Three.show('edit');
    ThreeEdit.startOwn();
  },
};
