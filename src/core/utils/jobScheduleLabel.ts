export interface JobScheduleLike {
  enabled?: boolean;
  cron?: string;
  intervalMs?: number;
  atTime?: string;
}

function formatTime12(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return minute === 0
    ? `${h12} ${ampm}`
    : `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

function isWeekdayRange(dow: string): boolean {
  const normalized = dow.trim();
  return normalized === "1-5" || normalized === "MON-FRI" || normalized === "mon-fri";
}

/** Step value of a cron field ("every N"), otherwise null. */
function stepOf(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field.trim());
  return m ? parseInt(m[1], 10) : null;
}

function isNum(field: string): boolean {
  return /^\d+$/.test(field.trim());
}

function hourLabel(h: number): string {
  return formatTime12(h, 0).toLowerCase().replace(" ", "");
}

/**
 * Human-readable cron. Never returns raw cron syntax: anything we can't
 * phrase becomes "on a custom schedule" so users never see raw cron.
 */
export function humanizeJobCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) {
    return "on a custom schedule";
  }
  const [min, hour, dom, mon, dow] = parts;
  const custom = "on a custom schedule";

  const hourNum = parseInt(hour, 10);
  const minNum = parseInt(min, 10);
  const time =
    isNum(hour) && isNum(min) ? formatTime12(hourNum, minNum).toLowerCase() : "";

  // Frequency within a day (minute + hour fields only).
  const minStep = stepOf(min);
  const hourStep = stepOf(hour);
  let freq: string | null = null;
  if (min === "*" && hour === "*") freq = "every minute";
  else if (minStep && hour === "*")
    freq = minStep === 1 ? "every minute" : `every ${minStep} minutes`;
  else if (isNum(min) && hour === "*")
    freq = minNum === 0 ? "every hour" : `every hour at ${minNum} past`;
  else if (/^\d+(,\d+)+$/.test(min) && hour === "*")
    freq = `${min.split(",").length} times an hour`;
  else if (minStep && /^\d+-\d+$/.test(hour)) {
    const [h1, h2] = hour.split("-").map((x) => parseInt(x, 10));
    freq = `every ${minStep} minutes, ${hourLabel(h1)}\u2013${hourLabel(h2)}`;
  } else if (isNum(min) && hourStep)
    freq = hourStep === 1 ? "every hour" : `every ${hourStep} hours`;
  else if (isNum(min) && /^\d+-\d+$/.test(hour)) {
    const [h1, h2] = hour.split("-").map((x) => parseInt(x, 10));
    freq = `every hour, ${hourLabel(h1)}\u2013${hourLabel(h2)}`;
  } else if (isNum(min) && /^\d+(,\d+)+$/.test(hour)) {
    const times = hour.split(",").map((h) => formatTime12(parseInt(h, 10), minNum).toLowerCase());
    freq = `at ${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
  }

  if (dom === "*" && mon === "*" && dow === "*") {
    if (time) return `daily at ${time}`;
    return freq ?? custom;
  }

  if (dom === "*" && mon === "*" && dow !== "*") {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = isWeekdayRange(dow)
      ? "weekdays"
      : /^[\d,]+$/.test(dow)
        ? dow.split(",").map((d) => dayNames[parseInt(d, 10) % 7] ?? d).join(", ")
        : null;
    if (!days) return custom;
    if (time) return days === "weekdays" ? `every weekday at ${time}` : `${days} at ${time}`;
    return freq ? `${freq} on ${days}` : custom;
  }

  if (dow === "*" && mon === "*" && isNum(dom)) {
    const suffix =
      dom === "1" || dom === "21" || dom === "31" ? "st" : dom === "2" || dom === "22" ? "nd" : dom === "3" || dom === "23" ? "rd" : "th";
    return time ? `${dom}${suffix} of each month at ${time}` : custom;
  }

  return custom;
}

export function formatJobScheduleLabel(schedule: JobScheduleLike | undefined): string | null {
  if (!schedule?.enabled) {
    return null;
  }

  if (schedule.cron) {
    return humanizeJobCron(schedule.cron);
  }

  if (schedule.intervalMs) {
    const sec = schedule.intervalMs / 1000;
    if (sec < 60) {
      return `every ${sec}s`;
    }
    if (sec < 3600) {
      return `every ${Math.round(sec / 60)} minutes`;
    }
    if (sec < 86400) {
      const hours = Math.round(sec / 3600);
      return hours === 1 ? "every hour" : `every ${hours} hours`;
    }
    const days = Math.round(sec / 86400);
    return days === 1 ? "every day" : `every ${days} days`;
  }

  if (schedule.atTime) {
    return `at ${schedule.atTime}`;
  }

  return "on a schedule";
}

/**
 * Clean up a schedule label that was stored at publish time by an older
 * humanizer (e.g. "every hour at :*\/5"). Never lets raw cron reach the UI.
 */
export function sanitizeScheduleLabel(label: string): string {
  const t = label.trim();
  const step = /^every hour at :\*\/(\d+)$/.exec(t);
  if (step) return `every ${parseInt(step[1], 10)} minutes`;
  const at = /^every hour at :(\d{1,2})$/.exec(t);
  if (at) return parseInt(at[1], 10) === 0 ? "every hour" : `every hour at ${parseInt(at[1], 10)} past`;
  if (/[*/]/.test(t) || /^[\d\s,*/-]+$/.test(t)) {
    const parts = t.replace(/^(every hour at :|daily at )/, "").split(/\s+/);
    if (parts.length >= 5) return humanizeJobCron(parts.slice(0, 5).join(" "));
    return "on a custom schedule";
  }
  return t;
}
