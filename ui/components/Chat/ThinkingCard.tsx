/**
 * ThinkingCard Component - Displays AI reasoning/thinking process
 * Based on Paprwork v1 design with liquid glass styling
 */

import React, { useState, useEffect, useRef, useMemo } from "react";
import "./ThinkingCard.css";

interface ThinkingCardProps {
  content: string;
  isStreaming?: boolean;
  isCollapsible?: boolean;
}

// Fun random thinking phrases (like Paprwork V1)
const THINKING_PHRASES = [
  "Thinking...",
  "Pondering...",
  "Contemplating...",
  "Mulling it over...",
  "Cogitating...",
  "Ruminating...",
  "Deep in thought...",
  "Processing...",
  "Analyzing...",
  "Reasoning...",
  "Figuring it out...",
  "Working on it...",
  "Calculating...",
  "Deliberating...",
  "Considering...",
];

export const ThinkingCard: React.FC<ThinkingCardProps> = ({
  content,
  isStreaming = false,
  isCollapsible = true,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const wasStreamingRef = useRef(isStreaming);
  
  // Pick a random phrase when the component mounts (stable across re-renders)
  const thinkingPhrase = useMemo(
    () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)],
    [] // Empty deps - only pick once when component first renders
  );

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && content) {
      // Streaming just finished - collapse the card
      setIsCollapsed(true);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, content]);

  // Don't show if there's no content at all
  if (!content && !isStreaming) {
    return null;
  }

  return (
    <div className="thinking-card">
      <div className="thinking-card-header" onClick={() => isCollapsible && setIsCollapsed(!isCollapsed)}>
        {isCollapsible && (
          <span className={`thinking-chevron ${isCollapsed ? "thinking-chevron-collapsed" : ""}`}>
            ▼
          </span>
        )}
        <span className="thinking-label-text">
          {isStreaming ? thinkingPhrase : thinkingPhrase.replace('...', '')}
        </span>
      </div>
      <div 
        className="thinking-card-content"
        style={{
          maxHeight: isCollapsed ? '0px' : '200px',
          opacity: isCollapsed ? '0' : '1',
        }}
      >
        {content}
        {isStreaming && <span className="thinking-cursor">▊</span>}
      </div>
    </div>
  );
};
