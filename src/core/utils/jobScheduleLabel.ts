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

/** Human-readable cron for common community catalog patterns. */
export function humanizeJobCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) {
    return cron;
  }
  const [min, hour, dom, mon, dow] = parts;

  const hourNum = parseInt(hour, 10);
  const minNum = parseInt(min, 10);
  const time =
    hour !== "*" && min !== "*" && !Number.isNaN(hourNum) && !Number.isNaN(minNum)
      ? formatTime12(hourNum, minNum)
      : "";

  if (dom === "*" && mon === "*" && dow === "*") {
    if (hour === "*" && min === "*") {
      return "every minute";
    }
    if (hour === "*") {
      return `every hour at :${min.padStart(2, "0")}`;
    }
    return time ? `daily at ${time.toLowerCase()}` : cron;
  }

  if (dom === "*" && mon === "*" && dow !== "*") {
    if (isWeekdayRange(dow) && time) {
      return `every weekday at ${time.toLowerCase()}`;
    }
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = dow
      .split(",")
      .map((d) => dayNames[parseInt(d, 10)] ?? d)
      .join(", ");
    return time ? `${days} at ${time.toLowerCase()}` : cron;
  }

  if (dow === "*" && mon === "*" && dom !== "*") {
    const suffix =
      dom === "1" ? "st" : dom === "2" ? "nd" : dom === "3" ? "rd" : "th";
    return time ? `${dom}${suffix} of each month at ${time.toLowerCase()}` : cron;
  }

  return cron;
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
