/**
 * NavButton - Reusable navigation button
 */

import React from "react";
import "./NavButton.css";

interface NavButtonProps {
  icon: React.ReactNode;
  label: string;
  isActive?: boolean;
  onClick?: () => void;
  badge?: string | number;
}

export function NavButton({
  icon,
  label,
  isActive = false,
  onClick,
  badge,
}: NavButtonProps) {
  return (
    <button
      className={`nav-button ${isActive ? "nav-button--active" : ""}`}
      onClick={onClick}
    >
      <span className="nav-button__icon">{icon}</span>
      <span className="nav-button__label">{label}</span>
      {badge !== undefined && (
        <span className="nav-button__badge">{badge}</span>
      )}
    </button>
  );
}
