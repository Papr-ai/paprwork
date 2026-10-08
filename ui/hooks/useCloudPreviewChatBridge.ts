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
      const title = typeof event.data.title === "string" ? event.data.title.slice(0, 80) : undefined;
      openCloudSyncAgentChat(message.trim(), { send: event.data.send === true, title });
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [enabled]);
}
