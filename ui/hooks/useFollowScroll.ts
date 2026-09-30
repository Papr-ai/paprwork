import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const PAGE_SCROLL_ROOT_SELECTOR =
  ".message-list, .embedded-app-agent-chat__messages";

interface UseFollowScrollOptions {
  /** When false, listeners and auto-scroll are inactive. */
  enabled: boolean;
  /** Re-enable follow when work becomes active again (e.g. new exploring session). */
  resetFollow?: boolean;
  /** Optional scroll container for the chat/page; auto-detected when omitted. */
  pageScrollRoot?: HTMLElement | null;
  /** Stay in follow mode while within this many px of the bottom. */
  threshold?: number;
}

/**
 * Keeps a scroll container pinned to the bottom while content grows,
 * unless the user scrolls up inside the container or on the page.
 */
export function useFollowScroll(
  containerRef: RefObject<HTMLElement | null>,
  scrollTriggers: readonly unknown[],
  {
    enabled,
    resetFollow = false,
    pageScrollRoot = null,
    threshold = 48,
  }: UseFollowScrollOptions,
): void {
  const followRef = useRef(true);
  const wasResetFollowRef = useRef(false);

  useEffect(() => {
    if (resetFollow && !wasResetFollowRef.current) {
      followRef.current = true;
    }
    wasResetFollowRef.current = resetFollow;
  }, [resetFollow]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    const pageRoot =
      pageScrollRoot ??
      container.closest<HTMLElement>(PAGE_SCROLL_ROOT_SELECTOR) ??
      null;

    const syncFollow = (element: HTMLElement) => {
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      followRef.current = distanceFromBottom <= threshold;
    };

    const onContainerScroll = () => syncFollow(container);
    const onPageScroll = pageRoot ? () => syncFollow(pageRoot) : undefined;

    container.addEventListener("scroll", onContainerScroll, { passive: true });
    pageRoot?.addEventListener("scroll", onPageScroll!, { passive: true });

    return () => {
      container.removeEventListener("scroll", onContainerScroll);
      if (pageRoot && onPageScroll) {
        pageRoot.removeEventListener("scroll", onPageScroll);
      }
    };
  }, [containerRef, enabled, pageScrollRoot, threshold]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled || !followRef.current) return;
    container.scrollTop = container.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- explicit content triggers only
  }, [containerRef, enabled, ...scrollTriggers]);
}
