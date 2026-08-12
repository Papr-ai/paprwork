export type CloudCompatibilityLevel = "cloud-ready" | "hybrid" | "desktop-only";

export type CloudCompatibilityCategory =
  | "papr-api"
  | "localhost-gateway"
  | "chrome-automation"
  | "bash-run"
  | "job-create"
  | "job-trigger"
  | "absolute-path"
  | "cloud-db"
  | "cloud-files";

export interface CloudCompatibilityFinding {
  category: CloudCompatibilityCategory;
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  message: string;
  remediation: string;
}

export interface CloudCompatibilityReport {
  level: CloudCompatibilityLevel;
  summary: string;
  publishAllowed: boolean;
  requiresAcknowledgement: boolean;
  cloudWorks: string[];
  desktopOnly: string[];
  findings: CloudCompatibilityFinding[];
}
