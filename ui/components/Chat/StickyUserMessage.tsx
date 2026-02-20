/**
 * StickyUserMessage Component - Sticky user message like Cursor
 * Shows the last user message at the top while scrolling through response
 */

import React, { useEffect, useState, useRef } from "react";
import "./StickyUserMessage.css";

interface StickyUserMessageProps {
  content: string;
  userEmail: string;
}

export const StickyUserMessage: React.FC<StickyUserMessageProps> = ({
  content,
  userEmail,
}) => {
  const [isSticky, setIsSticky] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        // When the sentinel goes out of view (scrolling down), make sticky
        setIsSticky(!entry.isIntersecting);
      },
      {
        threshold: 0,
        rootMargin: "-1px 0px 0px 0px", // Trigger just before leaving viewport
      },
    );

    if (sentinelRef.current) {
      observer.observe(sentinelRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <>
      {/* Sentinel div - marks the original position */}
      <div ref={sentinelRef} className="sticky-sentinel" />

      {/* Sticky message */}
      <div
        className={`sticky-user-message ${isSticky ? "sticky-user-message--active" : ""}`}
      >
        <div className="sticky-user-message-content">
          <img
            src={`https://avatar.vercel.sh/${userEmail}`}
            alt="User Avatar"
            className="sticky-user-avatar"
          />
          <div className="sticky-user-text">{content}</div>
        </div>
      </div>
    </>
  );
};
