import { OUTREACH_API_VERSION, PROVIDER_PURPOSES } from '@splitin/outreach-contracts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { WEEKDAYS, isValidDuration, isValidZone } from './calendar';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');
const isoDuration = z.string().refine(isValidDuration, 'expected an ISO-8601 duration such as P3D or PT4H');
const zone = z.string().refine(isValidZone, 'expected an IANA time zone');
const templateRef = z.string().regex(/^[a-z0-9][a-z0-9_.-]*@\d+$/, 'expected name@version');
const stepId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'expected a lowercase step id');
const when = z.enum(['always', 'no_reply']).default('always');

const emailStep = {
  id: stepId,
  template: templateRef,
  approval: z.enum(['inherit', 'always']).default('inherit'),
  when,
};

export const StepSchema = z.discriminatedUnion('type', [
  z.object({ ...emailStep, type: z.literal('email.send') }).strict(),
  z.object({ ...emailStep, type: z.literal('email.reply') }).strict(),
  z.object({ id: stepId, type: z.literal('wait'), duration: isoDuration, calendar: z.enum(['business', 'calendar']).default('business') }).strict(),
  z.object({ id: stepId, type: z.literal('manual.task'), channel: z.string().min(1).max(40), template: templateRef, when }).strict(),
]);

export const PolicySchema = z
  .object({
    approval: z.enum(['none', 'every_action', 'first_batch_then_campaign']).default('first_batch_then_campaign'),
    firstBatchSize: z.number().int().min(1).max(500).default(20),
    window: z
      .object({
        timezone: z.union([z.literal('recipient'), zone]).default('recipient'),
        fallback: zone.default('America/New_York'),
        days: z.array(z.enum(WEEKDAYS)).min(1).default(['Mon', 'Tue', 'Wed', 'Thu']),
        start: hhmm.default('09:30'),
        end: hhmm.default('16:30'),
        holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
      })
      .strict()
      .refine((w) => w.start < w.end, 'window start must be before end')
      .default({ timezone: 'recipient', fallback: 'America/New_York', days: ['Mon', 'Tue', 'Wed', 'Thu'], start: '09:30', end: '16:30', holidays: [] }),
    limits: z
      .object({
        accountPerDay: z.number().int().min(1).max(10_000).default(40),
        domainPerDay: z.number().int().min(1).max(1_000).default(3),
        campaignPerDay: z.number().int().min(1).max(10_000).optional(),
        recipientMinGap: isoDuration.default('P3D'),
      })
      .strict()
      .default({ accountPerDay: 40, domainPerDay: 3, recipientMinGap: 'P3D' }),
    requirePostalAddress: z.boolean().default(true),
    unsubscribe: z.enum(['link', 'reply']).default('link'),
    expireAfter: isoDuration.default('P14D'),
  })
  .strict();

export const AudienceSchema = z
  .object({
    source: z
      .union([
        z.literal('all'),
        z.object({ importBatch: z.string().min(1) }).strict(),
        z.object({ contactIds: z.array(z.string().min(1)).min(1).max(100_000) }).strict(),
      ])
      .default('all'),
    require: z.array(z.literal('email')).default(['email']),
    eligibility: z.array(z.enum(['consent_or_legitimate_interest', 'any'])).default(['consent_or_legitimate_interest']),
  })
  .strict();

export const PlaybookSchema = z
  .object({
    apiVersion: z.literal(OUTREACH_API_VERSION),
    kind: z.literal('Playbook'),
    metadata: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
    spec: z
      .object({
        purpose: z.enum(PROVIDER_PURPOSES),
        audience: AudienceSchema.default({ source: 'all', require: ['email'], eligibility: ['consent_or_legitimate_interest'] }),
        policy: PolicySchema.default(PolicySchema.parse({})),
        steps: z.array(StepSchema).min(1).max(50),
      })
      .strict(),
  })
  .strict();

export type Playbook = z.infer<typeof PlaybookSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type Audience = z.infer<typeof AudienceSchema>;

export class PlaybookError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid playbook:\n- ${issues.join('\n- ')}`);
    this.name = 'PlaybookError';
  }
}

/** Parses YAML or an object into a validated playbook. Structural checks only; see compile for semantic ones. */
export function parsePlaybook(input: string | unknown): Playbook {
  const raw = typeof input === 'string' ? (parseYaml(input) as unknown) : input;
  const result = PlaybookSchema.safeParse(raw);
  if (!result.success) {
    throw new PlaybookError(result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`));
  }
  return result.data;
}
