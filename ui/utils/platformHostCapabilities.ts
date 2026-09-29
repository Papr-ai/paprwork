import { gateway } from "../src/lib/gateway";

/** Whether Papr can launch real Google Chrome for platform sign-in. */
export async function fetchGoogleChromeInstalled(): Promise<boolean> {
  try {
    const res = await gateway.send("platform:get-host-capabilities", {});
    return Boolean(
      (res.data as { googleChromeInstalled?: boolean } | undefined)
        ?.googleChromeInstalled,
    );
  } catch {
    return false;
  }
}

export interface PlatformConnectData {
  status?: string;
  waitingForConfirmation?: boolean;
  externalChrome?: boolean;
  chromeWindowOpened?: boolean;
  message?: string;
  error?: string;
  requiresGoogleChrome?: boolean;
}

export function connectResultRequiresGoogleChrome(
  data: PlatformConnectData | undefined,
): boolean {
  if (!data) return false;
  if (data.requiresGoogleChrome) return true;
  return (
    data.status === "disconnected" &&
    typeof data.error === "string" &&
    data.error.includes("Google Chrome is required")
  );
}
