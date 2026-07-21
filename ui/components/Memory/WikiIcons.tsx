import React from "react";

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
}

const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/* ── Entity type icons ─────────────────────────────────────── */

export function ProjectIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" {...s} />
      <path d="M8 12h8M8 8h5M8 16h6" {...s} />
    </svg>
  );
}

export function AppIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" {...s} />
      <rect x="14" y="3" width="7" height="7" rx="1.5" {...s} />
      <rect x="3" y="14" width="7" height="7" rx="1.5" {...s} />
      <rect x="14" y="14" width="7" height="7" rx="1.5" {...s} />
    </svg>
  );
}

export function PersonIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <circle cx="12" cy="8" r="4" {...s} />
      <path d="M20 21a8 8 0 1 0-16 0" {...s} />
    </svg>
  );
}

export function CompanyIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="2" {...s} />
      <path d="M9 6h2M13 6h2M9 10h2M13 10h2M9 14h2M13 14h2M9 18h6" {...s} />
    </svg>
  );
}

export function LearningIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" {...s} />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" {...s} />
    </svg>
  );
}

export function CollectionIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" {...s} />
    </svg>
  );
}

export function IdeaIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <path d="M9 18h6M10 22h4" {...s} />
      <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" {...s} />
    </svg>
  );
}

export function TaskIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" {...s} />
      <path d="M9 12l2 2 4-4" {...s} />
    </svg>
  );
}

export function InvestorIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" {...s} />
    </svg>
  );
}

export function WorkflowIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <circle cx="5" cy="6" r="3" {...s} /><circle cx="19" cy="6" r="3" {...s} />
      <circle cx="12" cy="18" r="3" {...s} />
      <path d="M5 9v3a3 3 0 0 0 3 3h1M19 9v3a3 3 0 0 1-3 3h-1" {...s} />
    </svg>
  );
}

export function GoalIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <circle cx="12" cy="12" r="10" {...s} />
      <circle cx="12" cy="12" r="6" {...s} />
      <circle cx="12" cy="12" r="2" {...s} />
    </svg>
  );
}

export function InsightIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <path d="M12 2L2 7l10 5 10-5-10-5z" {...s} />
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" {...s} />
    </svg>
  );
}

export function EntityIcon({ size = 16, className, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ color }} aria-hidden>
      <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" {...s} />
      <path d="M12 22V15.5M22 8.5L12 15.5 2 8.5" {...s} />
    </svg>
  );
}

/* ── Section icons ─────────────────────────────────────────── */

export function ClipboardIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="8" y="2" width="8" height="4" rx="1" {...s} />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" {...s} />
    </svg>
  );
}

export function ListIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" {...s} />
    </svg>
  );
}

export function MessageIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" {...s} />
    </svg>
  );
}

export function BoltIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" {...s} />
    </svg>
  );
}

export function CheckSquareIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" {...s} />
      <path d="M9 12l2 2 4-4" {...s} />
    </svg>
  );
}

export function HistoryIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" {...s} />
      <path d="M3 3v5h5" {...s} />
      <path d="M12 7v5l4 2" {...s} />
    </svg>
  );
}

export function CheckIcon({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M20 6L9 17l-5-5" {...s} strokeWidth={2.5} />
    </svg>
  );
}

export function SquareIcon({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" {...s} />
    </svg>
  );
}

export function PlusIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M12 5v14M5 12h14" {...s} strokeWidth={2} />
    </svg>
  );
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" {...s} strokeWidth={2} />
    </svg>
  );
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="11" cy="11" r="8" {...s} />
      <path d="M21 21l-4.35-4.35" {...s} />
    </svg>
  );
}

/* ── Icon resolver ─────────────────────────────────────────── */

const TYPE_ICON_MAP: Record<string, React.FC<IconProps>> = {
  project: ProjectIcon, projects: ProjectIcon,
  app: AppIcon, apps: AppIcon,
  person: PersonIcon, people: PersonIcon,
  company: CompanyIcon, companies: CompanyIcon,
  learning: LearningIcon, learnings: LearningIcon,
  collection: CollectionIcon, collections: CollectionIcon,
  idea: IdeaIcon, ideas: IdeaIcon,
  task: TaskIcon, tasks: TaskIcon,
  investor: InvestorIcon, investors: InvestorIcon,
  workflow: WorkflowIcon, workflows: WorkflowIcon,
  goal: GoalIcon, goals: GoalIcon,
  insight: InsightIcon, insights: InsightIcon,
  memory: InsightIcon,
  entity: EntityIcon,
};

const SECTION_ICON_MAP: Record<string, React.FC<IconProps>> = {
  "Context & Background": ClipboardIcon,
  "Key Details": ListIcon,
  "Key Interactions": MessageIcon,
  "Decisions & Insights": BoltIcon,
  "Open Items": CheckSquareIcon,
  "Changelog": HistoryIcon,
};

export function WikiTypeIcon({ type, size = 16, color }: { type: string; size?: number; color?: string }) {
  const Comp = TYPE_ICON_MAP[type] ?? EntityIcon;
  return <Comp size={size} color={color} />;
}

export function WikiSectionIcon({ section, size = 14 }: { section: string; size?: number }) {
  const Comp = SECTION_ICON_MAP[section] ?? ListIcon;
  return <Comp size={size} />;
}
