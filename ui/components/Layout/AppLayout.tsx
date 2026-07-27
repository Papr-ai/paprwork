/**
 * AppLayout - Main layout for Paprwork v2
 * Sidebar + (TabBar + Content) with Liquid Glass design
 */

import React from "react";
import "./AppLayout.css";

interface AppLayoutProps {
  sidebar: React.ReactNode;
  topBar: React.ReactNode;
  content: React.ReactNode;
  sidebarCollapsed?: boolean;
}

export function AppLayout({
  sidebar,
  topBar,
  content,
  sidebarCollapsed = false,
}: AppLayoutProps) {
  return (
    <div
      className={`app-layout${sidebarCollapsed ? " app-layout--sidebar-collapsed" : ""}`}
    >
      <aside
        className="app-layout__sidebar"
        aria-hidden={sidebarCollapsed}
      >
        {sidebar}
      </aside>
      <div className="app-layout__main">
        <div className="app-layout__topbar">{topBar}</div>
        <div className="app-layout__content">{content}</div>
      </div>
    </div>
  );
}
