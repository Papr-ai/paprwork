import type { JobRecord } from "../hooks/useJobs";

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
  return "";
}
