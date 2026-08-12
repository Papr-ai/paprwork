import { useEffect, useRef, type RefObject } from "react";

/**
 * Calls onDismiss when the user clicks outside all provided container refs.
 */
export function useDismissOnOutsideClick(
  isOpen: boolean,
  onDismiss: () => void,
  ...containerRefs: Array<RefObject<HTMLElement | null>>
): void {
  const containerRefsRef = useRef(containerRefs);
  containerRefsRef.current = containerRefs;

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInside = containerRefsRef.current.some((ref) =>
        ref.current?.contains(target),
      );
      if (!isInside) {
        onDismiss();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen, onDismiss]);
}
