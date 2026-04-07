/**
 * WorkingCard Component - Displays tool execution progress with timer
 * Supports collapsing and shows elapsed time
 */

import React, { useState, useEffect, useRef } from "react";
import { PaprLogoIcon } from "./PaprLogoIcon";
import "./WorkingCard.css";

interface WorkingCardProps {
  children: React.ReactNode;
  isExploring?: boolean;
}

export const WorkingCard: React.FC<WorkingCardProps> = ({
  children,
  isExploring = false,
}) => {
  // Start collapsed by default
  const [isCollapsed, setIsCollapsed] = useState(true);
  
  // Timer state
  const [elapsedTime, setElapsedTime] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Start timer when exploring begins
  useEffect(() => {
    if (isExploring && !startTimeRef.current) {
      // Start timing
      startTimeRef.current = Date.now();
      timerIntervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 1000);
    } else if (!isExploring && startTimeRef.current) {
      // Stop timing
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      // Set final time
      if (startTimeRef.current) {
        setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }

    // Cleanup on unmount
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [isExploring]);

  // Format elapsed time as "Xs" or "Xm Ys" for minutes
  const formatTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="working-card">
      <div className="working-card-header" onClick={() => setIsCollapsed(!isCollapsed)}>
        <span
          className={`working-chevron ${isCollapsed ? "working-chevron-collapsed" : ""}`}
        >
          ▼
        </span>
        <span className="working-label-text">Working</span>
        {isExploring && <PaprLogoIcon />}
        {elapsedTime > 0 && (
          <span className="working-timer">{formatTime(elapsedTime)}</span>
        )}
      </div>
      <div
        className="working-card-content"
        style={{
          maxHeight: isCollapsed ? "0px" : "420px",
          opacity: isCollapsed ? "0" : "1",
        }}
      >
        {children}
      </div>
    </div>
  );
};
