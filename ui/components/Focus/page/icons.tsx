/** The Home app's icons, same paths, so Focus looks identical. */
const p = { stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const AgentIcon = () => (
  <svg viewBox="0 0 20 20" fill="none"><path d="M12.2 16.5c-.22 0-.36-.14-.4-.34-.43-3.02-.83-3.7-3.98-4.01-.21-.03-.35-.18-.35-.38 0-.19.14-.34.35-.37 3.14-.43 3.42-.97 3.98-4.01.06-.2.2-.34.4-.34.18 0 .33.15.37.35.44 2.97.86 3.57 4 4 .2.03.34.18.34.37 0 .2-.14.36-.34.38-3.15.42-3.43.99-4 4.01-.05.19-.19.34-.37.34zm-4.07 1.68c-.15 0-.24-.1-.29-.26-.29-1.48-.16-1.54-1.78-1.79-.17-.03-.27-.12-.27-.28 0-.15.1-.26.25-.28 1.64-.28 1.51-.35 1.8-1.85.05-.16.15-.26.29-.26.16 0 .26.11.3.26.27 1.46.18 1.53 1.81 1.81.14.02.25.13.25.28 0 .14-.11.25-.25.28-1.64.25-1.54.31-1.81 1.82-.04.14-.15.23-.3.27z" fill="currentColor" /></svg>
);
export const CheckIcon = () => <svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" {...p} strokeWidth="1.8" /></svg>;
export const TaskCheckIcon = () => <svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" {...p} strokeWidth="2" /></svg>;
export const DismissIcon = () => <svg viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" {...p} strokeWidth="1.8" /></svg>;
export const UndoIcon = () => (
  <svg viewBox="0 0 16 16" fill="none"><path d="M3 6h7a3 3 0 0 1 0 6H8" {...p} strokeWidth="1.6" /><path d="M5.5 3.5L3 6l2.5 2.5" {...p} strokeWidth="1.6" /></svg>
);
export const ArrowIcon = () => <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" {...p} strokeWidth="1.6" /></svg>;
export const EditIcon = () => <svg viewBox="0 0 16 16" fill="none"><path d="M9.5 3.5l3 3L5 14H2v-3l7.5-7.5z" {...p} strokeWidth="1.4" /></svg>;
export const SparkIcon = () => <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z" /></svg>;
export const BackIcon = () => <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" {...p} strokeWidth="1.8" /></svg>;
export const ChevIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" {...p} strokeWidth="1.8" /></svg>
);
export const DayPrevIcon = () => <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" {...p} strokeWidth="1.6" /></svg>;
export const DayNextIcon = () => <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" {...p} strokeWidth="1.6" /></svg>;
