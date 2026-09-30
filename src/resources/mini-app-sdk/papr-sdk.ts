/**
 * Unified Papr mini-app SDK — one import for app authors.
 *
 * Works in iframe embeds (Paprwork preview + Web toggle) and top-level tabs.
 * Dialog transport is always in-DOM; apps never branch on embed context.
 *
 *   import { papr } from '/__papr__/papr-sdk.ts';
 *   await papr.dialog.text('Name?');
 *   if (!await papr.dialog.confirm('Remove?')) return;
 *
 * Per-module imports (/__papr__/papr-dialog.ts, etc.) remain supported.
 */

import { askConfirm, askText, showAlert } from "./papr-dialog.ts";
import { papr as paprFilesModule } from "./papr-files.ts";
import {
  subscribeJobEvents,
  type SubscribeJobEventsOptions,
} from "./papr-job-events.ts";
import {
  getPreviewLifecyclePhase,
  onPreviewLifecycle,
  registerPausablePreviewResource,
  type PreviewLifecyclePhase,
  type PausablePreviewResource,
} from "./papr-preview-lifecycle.ts";

export { askConfirm, askText, showAlert };
export { subscribeJobEvents };
export type {
  PreviewLifecyclePhase,
  PausablePreviewResource,
  SubscribeJobEventsOptions,
};

export const papr = {
  dialog: {
    text: askText,
    askText,
    confirm: askConfirm,
    askConfirm,
    alert: showAlert,
    showAlert,
  },
  jobs: {
    subscribe: subscribeJobEvents,
    subscribeJobEvents,
  },
  files: paprFilesModule.files,
  preview: {
    onLifecycle: onPreviewLifecycle,
    onPreviewLifecycle,
    registerPausable: registerPausablePreviewResource,
    registerPausablePreviewResource,
    getPhase: getPreviewLifecyclePhase,
    getPreviewLifecyclePhase,
  },
} as const;

export default papr;
