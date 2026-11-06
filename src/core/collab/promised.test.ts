import { describe, expect, it } from "vitest";
import { parsePromise, promiseLabel , dueLabel, dueDate } from "./promised";

// Tue Nov 3 2026, 3:00pm local
const now = new Date(2026, 10, 3, 15, 0);
const at = (d: Date | null) => (d ? `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : null);

describe("parsePromise", () => {
  it("reads a weekday and part of day", () => {
    expect(at(parsePromise("On it. I'll have the copy ready Thursday morning.", now))).toBe("5 9:00");
    expect(at(parsePromise("Friday afternoon works", now))).toBe("6 14:00");
  });
  it("reads clock times, tomorrow, EOD", () => {
    expect(at(parsePromise("tomorrow at 10am", now))).toBe("4 10:00");
    expect(at(parsePromise("by EOD", now))).toBe("3 17:00");
    expect(at(parsePromise("Thu 2:30pm", now))).toBe("5 14:30");
  });
  it("defaults to 5pm on a bare day; 'next' skips a week", () => {
    expect(at(parsePromise("Thursday", now))).toBe("5 17:00");
    expect(at(parsePromise("next Thursday", now))).toBe("12 17:00");
  });
  it("rolls a passed time forward instead of going back", () => {
    expect(at(parsePromise("by 9am", now))).toBe("4 9:00");
    expect(at(parsePromise("Tuesday morning", now))).toBe("10 9:00");
  });
  it("says nothing when there's no date", () => {
    expect(parsePromise("On it, will look soon.", now)).toBeNull();
    expect(parsePromise("Thanks!", now)).toBeNull();
  });
});

describe("promiseLabel", () => {
  it("is short", () => {
    expect(promiseLabel(new Date(2026, 10, 5, 9), now)).toBe("Thu 9am");
    expect(promiseLabel(new Date(2026, 10, 4, 14, 30), now)).toBe("tomorrow 2:30pm");
    expect(promiseLabel(new Date(2026, 10, 3, 17), now)).toBe("today 5pm");
    expect(promiseLabel(new Date(2026, 10, 12, 9), now)).toBe("Nov 12 9am");
  });
});

describe("dueLabel", () => {
  const now = new Date(2026, 10, 4, 10, 0); // Wed Nov 4
  it("says the day in words", () => {
    expect(dueLabel("2026-11-04", now)).toBe("today");
    expect(dueLabel("2026-11-05", now)).toBe("tomorrow");
    expect(dueLabel("2026-11-06", now)).toBe("Fri");
    expect(dueLabel("2026-11-20", now)).toBe("Nov 20");
    expect(dueLabel("Friday 5pm", now)).toBe("Friday 5pm");
    expect(dueLabel(null, now)).toBe("");
  });
});

describe("dueDate", () => {
  it("is absolute, for stored text", () => {
    expect(dueDate("2026-11-05")).toBe("Thu, Nov 5");
    expect(dueDate("soon")).toBe("soon");
  });
});
