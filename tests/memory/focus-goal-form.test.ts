// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const dir = `${process.cwd()}/src/resources/default-apps/home-dashboard`;
it("goal form: repeat switch, date picker, and what gets saved", () => {
  const load = (f: string) => readFileSync(`${dir}/${f}`, "utf8");
  // Top-level consts in the browser scripts → attach to window so they share scope.
  const src = ["three.js", "three_form.js", "three_edit.js"].map(load).join("\n")
    + "\nwindow.Three = Three; window.ThreeForm = ThreeForm; window.ThreeEdit = ThreeEdit;";
  document.body.innerHTML = '<div id="app"><div id="view-three"></div></div>';
  new Function(src)();
  const w = window as any;
  w.Three.data = { three: [{ id: "G1", title: "Close Tranche 2", target: "$1.25M raised", due: "Nov 30", why: "x", signals: {} }], candidates: [], source: "user", confirmed: true };
  w.ThreeEdit.reset("G1"); w.ThreeEdit.paint();
  const box = document.querySelector(".t3edit") as HTMLElement;
  const date = document.getElementById("te-d") as HTMLInputElement;
  expect(date.type).toBe("date");
  expect(date.value).toMatch(/^\d{4}-11-30$/); // old free-text due converts
  expect(box.dataset.repeat).toBe("");
  // Type, then switch to Daily: no repaint, text survives, By folds away.
  (document.getElementById("te-t") as HTMLInputElement).value = "Post daily on X and LinkedIn";
  (document.getElementById("te-m") as HTMLInputElement).value = "1 post on X and LinkedIn";
  const daily = document.querySelector('[data-repeat="daily"]') as HTMLElement;
  w.ThreeEdit.act("repeat", daily);
  expect(document.querySelector(".t3edit")).toBe(box);
  expect(box.dataset.repeat).toBe("daily");
  expect(daily.getAttribute("aria-checked")).toBe("true");
  expect(document.getElementById("te-ml")!.textContent).toBe("Each day");
  expect(w.ThreeForm.read()).toEqual({ title: "Post daily on X and LinkedIn", target: "1 post on X and LinkedIn", due: "", repeat: "daily", scope: "" });
  // Save → draft + PUT body carry repeat; the card reads "Every day".
  const save = document.querySelector('[data-three="save"]') as HTMLElement;
  w.ThreeEdit.act("save", save);
  const picks = w.ThreeEdit.picksFrom(w.ThreeEdit.draft);
  expect(picks[0]).toMatchObject({ goalId: "G1", title: "Post daily on X and LinkedIn", repeat: "daily", due: "" });
  expect(document.querySelector(".t3done")!.textContent).toBe("1 post on X and LinkedIn · Every day");
  // Reopen: the switch remembers Daily.
  w.ThreeEdit.act("edit-one", { dataset: { gid: "G1" } });
  expect((document.querySelector(".t3edit") as HTMLElement).dataset.repeat).toBe("daily");
});
