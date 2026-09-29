/* The goal form inside Edit Focus: what you want, how often, what counts as done, and by when.
   A one-time goal gets a date picker. A daily or weekly goal is a habit, so it has no end date:
   "1 post on X and LinkedIn" every day. Switching repeat never repaints, so typed text stays put. */
const ThreeForm = {
  REPEATS: [['', 'One time'], ['daily', 'Daily'], ['weekly', 'Weekly']],
  COPY: {
    '': { what: 'Close Tranche 2', done: 'Done when', ph: '$1.25M raised',
      tip: 'Name a result you can count, not an activity. "$1.25M raised" beats "work on the raise".' },
    daily: { what: 'Post daily on X and LinkedIn', done: 'Each day', ph: '1 post on X and LinkedIn',
      tip: 'Small enough to do every day. Pen puts it on your list each morning.' },
    weekly: { what: 'Publish every week', done: 'Each week', ph: '3 posts and 1 long-form piece',
      tip: 'What a good week looks like. Pen checks in each Monday.' },
  },
  /** yyyy-mm-dd in local time, the format <input type="date"> reads and writes. */
  ymd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  /** Saved due ("2026-11-30", or older free text like "Nov 30") → yyyy-mm-dd, or '' if unreadable. */
  isoDate(due) {
    const s = String(due || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const year = new Date().getFullYear();
    const d = new Date(/\b\d{4}\b/.test(s) ? s : `${s} ${year}`);
    return Number.isNaN(d.getTime()) ? '' : this.ymd(d);
  },
  html(g, own, esc) {
    const v = (s) => (own ? '' : esc(s || ''));
    const r = own ? '' : g.repeat || '';
    const c = this.COPY[r] || this.COPY[''];
    const seg = this.REPEATS.map(([k, label]) => `<button type="button" role="radio" aria-checked="${k === r}"
      data-three="repeat" data-repeat="${k}">${label}</button>`).join('');
    return `<div class="t3edit" data-repeat="${r}">
      <label><span>Outcome</span><input id="te-t" value="${v(g.title)}" placeholder="${c.what}" /></label>
      <div class="t3field"><span>How often</span><div class="t3seg" role="radiogroup" aria-label="How often">${seg}</div></div>
      <div class="t3pair"><label><span id="te-ml">${c.done}</span><input id="te-m" value="${v(g.target)}" placeholder="${c.ph}" /></label>
        <label class="t3by"><span>By</span><input id="te-d" type="date" min="${this.ymd(new Date())}" value="${own ? '' : this.isoDate(g.due)}" /></label></div>
      <p class="t3tip" id="te-tip">${esc(c.tip)}</p>
      <div class="t3btns"><button type="button" class="t3save" data-three="save" data-gid="${esc(g.id)}">Save</button>
        <button type="button" class="t3cancel" data-three="cancel">Cancel</button></div></div>`;
  },
  /** Flip One time / Daily / Weekly in place: labels, placeholders and the date field follow. */
  setRepeat(btn) {
    const box = btn.closest('.t3edit');
    if (!box) return;
    const r = btn.dataset.repeat || '';
    const c = this.COPY[r] || this.COPY[''];
    box.dataset.repeat = r;
    box.querySelectorAll('.t3seg [data-repeat]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
    box.querySelector('#te-ml').textContent = c.done;
    box.querySelector('#te-m').placeholder = c.ph;
    box.querySelector('#te-t').placeholder = c.what;
    box.querySelector('#te-tip').textContent = c.tip;
  },
  read() {
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const repeat = document.querySelector('.t3edit')?.dataset.repeat || '';
    return { title: val('te-t'), target: val('te-m'), due: repeat ? '' : val('te-d'), repeat: repeat || undefined };
  },
};
