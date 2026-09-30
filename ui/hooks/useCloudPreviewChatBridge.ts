import { useEffect } from "react";
import { openCloudSyncAgentChat } from "../utils/openCloudSyncAgentChat";

/** Credential/setup pages in cloud preview iframes postMessage here to open desktop chat. */
export function useCloudPreviewChatBridge(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const handleMessage = (event: MessageEvent): void => {
      if (event.data?.type !== "papr-open-chat") return;
      const message = event.data.message;
      if (typeof message !== "string" || message.trim().length === 0) return;
      openCloudSyncAgentChat(message.trim());
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [enabled]);
}
