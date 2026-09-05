import type { JobRecord } from "../hooks/useJobs";

export type JobTriggerKind = "scheduled" | "dependency" | "manual";

export function jobTriggerKind(job: JobRecord): JobTriggerKind {
  const deps = job.dependsOn ?? [];
  if (job.schedule?.enabled && deps.length === 0) return "scheduled";
  if (deps.length > 0) return "dependency";
  return "manual";
}

/** Minutes since midnight for timeline ordering (0–1439). */
export function scheduleSortMinutes(job: JobRecord): number {
  const s = job.schedule;
  if (!s?.enabled) return 24 * 60;

  if (s.cron) {
    const parts = s.cron.trim().split(/\s+/);
    if (parts.length >= 2) {
      const min = parseInt(parts[0], 10);
      const hour = parseInt(parts[1], 10);
      if (!Number.isNaN(hour) && !Number.isNaN(min) && parts[0] !== "*" && parts[1] !== "*") {
        return hour * 60 + min;
      }
      if (parts[0] !== "*" && parts[1] === "*") {
        return parseInt(parts[0], 10) || 0;
      }
    }
  }

  if (s.atTime) {
    const match = /^(\d{1,2}):(\d{2})/.exec(s.atTime.trim());
    if (match) {
      const hour = parseInt(match[1], 10);
      const min = parseInt(match[2], 10);
      if (!Number.isNaN(hour) && !Number.isNaN(min)) return hour * 60 + min;
    }
  }

  if (s.intervalMs) return 0;

  const nextRun = job.scheduleState?.nextRunAt;
  if (nextRun) {
    const d = new Date(nextRun);
    if (!Number.isNaN(d.getTime())) {
      return d.getHours() * 60 + d.getMinutes();
    }
  }

  return 12 * 60;
}

/** Short time label for the workflow timeline gutter. */
export function scheduleTimeLabel(job: JobRecord): string | null {
  const s = job.schedule;
  if (!s?.enabled) return null;

  if (s.cron) {
    const parts = s.cron.trim().split(/\s+/);
    if (parts.length >= 2) {
      const min = parts[0];
      const hour = parts[1];
      if (hour !== "*" && min !== "*") {
        const hr = parseInt(hour, 10);
        const mn = parseInt(min, 10);
        if (!Number.isNaN(hr) && !Number.isNaN(mn)) {
          const ampm = hr >= 12 ? "PM" : "AM";
          const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
          return mn === 0
            ? `${h12} ${ampm}`
            : `${h12}:${String(mn).padStart(2, "0")} ${ampm}`;
        }
      }
    }
  }

  if (s.atTime) return s.atTime;

  if (s.intervalMs) {
    const sec = s.intervalMs / 1000;
    if (sec < 60) return `/${sec}s`;
    if (sec < 3600) return `/${Math.round(sec / 60)}m`;
    return `/${Math.round(sec / 3600)}h`;
  }

  return null;
}

function humanCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  const fmtTime = (h: string, m: string): string => {
    const hr = parseInt(h, 10);
    const mn = parseInt(m, 10);
    if (Number.isNaN(hr)) return "";
    const ampm = hr >= 12 ? "PM" : "AM";
    const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
    return mn === 0 ? `${h12} ${ampm}` : `${h12}:${String(mn).padStart(2, "0")} ${ampm}`;
  };

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monNames = [
    "",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const time = fmtTime(hour, min);

  if (dom === "*" && mon === "*" && dow === "*") {
    if (hour === "*" && min === "*") return "Every minute";
    if (hour === "*") return `Every hour at :${min.padStart(2, "0")}`;
    return `Daily at ${time}`;
  }
  if (dom === "*" && mon === "*" && dow !== "*") {
    const days = dow.split(",").map((d) => dayNames[parseInt(d, 10)] ?? d).join(", ");
    return `${days} at ${time}`;
  }
  if (dow === "*" && mon === "*" && dom !== "*") {
    return `${dom}${dom === "1" ? "st" : dom === "2" ? "nd" : dom === "3" ? "rd" : "th"} of month at ${time}`;
  }
  if (dom !== "*" && mon !== "*") {
    const m = monNames[parseInt(mon, 10)] ?? mon;
    return `${m} ${dom} at ${time}`;
  }
  return cron;
}

export function jobTriggerLabel(job: JobRecord, jobs: JobRecord[]): string {
  const s = job.schedule;
  const deps = job.dependsOn ?? [];

  if (s?.enabled) {
    if (s.cron) return humanCron(s.cron);
    if (s.intervalMs) {
      const sec = s.intervalMs / 1000;
      if (sec < 60) return `Every ${sec}s`;
      if (sec < 3600) return `Every ${Math.round(sec / 60)}m`;
      if (sec < 86400) return `Every ${Math.round(sec / 3600)}h`;
      return `Every ${Math.round(sec / 86400)}d`;
    }
    if (s.atTime) return `At ${s.atTime}`;
    return "Scheduled";
  }
  if (deps.length > 0) {
    const depNames = deps.map((d) => {
      const depJob = jobs.find((j) => j.id === d.jobId);
      return depJob ? depJob.name : d.jobId.slice(0, 8);
    });
    return `After ${depNames.join(", ")}`;
  }
  return "Manual";
}
