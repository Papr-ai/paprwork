/** Denormalized on cloud publish for Community catalog cards. */
export interface CatalogAutomation {
  /** Lowercase phrase, e.g. "every weekday at 8:00am" */
  scheduleLabel: string;
  scheduledJobCount: number;
  hasAgentJob: boolean;
  /** Ready-to-render card copy */
  cardLine: string;
}
