/** Detail for the global auto-send event (heard by mounted ChatContainers). */
export type PaprOnboardingSendDetail = {
  message: string;
  /** When set, only the ChatContainer for this chatId may send. */
  chatId?: string;
};

export const PAPR_ONBOARDING_SEND_EVENT = "papr-onboarding-send";

export function dispatchPaprOnboardingSend(
  message: string,
  chatId?: string,
): void {
  const detail: PaprOnboardingSendDetail = { message };
  if (chatId) {
    detail.chatId = chatId;
  }
  window.dispatchEvent(
    new CustomEvent(PAPR_ONBOARDING_SEND_EVENT, { detail }),
  );
}
