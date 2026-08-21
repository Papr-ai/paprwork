import type { RefObject } from "react";
import { useEffect } from "react";

export type PreviewLifecycleMessageType =
  | "papr:preview-hidden"
  | "papr:preview-visible"
  | "papr:preview-evicting";

export function postPreviewLifecycleToIframe(
  iframe: HTMLIFrameElement | null | undefined,
  type: PreviewLifecycleMessageType,
  targetOrigin = "*",
): void {
  iframe?.contentWindow?.postMessage({ type }, targetOrigin);
}

/** Notify embedded mini-app when preview tab visibility changes or host unmounts. */
export function usePreviewTabLifecycle(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  previewTabVisible: boolean,
): void {
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    const post = (visible: boolean) => {
      postPreviewLifecycleToIframe(
        iframeRef.current,
        visible ? "papr:preview-visible" : "papr:preview-hidden",
      );
    };

    const onLoad = () => post(previewTabVisible);
    post(previewTabVisible);
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
    };
  }, [iframeRef, previewTabVisible]);

  useEffect(() => {
    return () => {
      postPreviewLifecycleToIframe(iframeRef.current, "papr:preview-evicting");
    };
  }, [iframeRef]);
}
