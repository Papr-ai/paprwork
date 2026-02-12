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
}

export function AppLayout({ sidebar, topBar, content }: AppLayoutProps) {
  return (
    <div className="app-layout">
      <aside className="app-layout__sidebar">{sidebar}</aside>
      <div className="app-layout__main">
        <div className="app-layout__topbar">{topBar}</div>
        <div className="app-layout__content">{content}</div>
      </div>
    </div>
  );
}
