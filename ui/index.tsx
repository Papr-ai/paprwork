/**
 * Renderer entry point
 * Initializes React app and mounts to DOM
 */

// Web-demo mode: install mock Electron bridges before anything else loads
import "./src/lib/demoBoot";

// Set up global error handlers to catch any errors that might not show in console
window.addEventListener("error", (event) => {
  console.error("[Global Error Handler]", event.error);
  console.error("[Global Error] Message:", event.message);
  console.error("[Global Error] Filename:", event.filename);
  console.error("[Global Error] Line:", event.lineno, "Column:", event.colno);
  if (event.error && event.error.stack) {
    console.error("[Global Error] Stack:", event.error.stack);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[Unhandled Promise Rejection]", event.reason);
  if (event.reason && event.reason.stack) {
    console.error("[Unhandled Promise] Stack:", event.reason.stack);
  }
});

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Web-demo only: seed a default Chat tab so we don't show "No tab selected"
import { seedDemoTabs } from "./src/lib/demoSeedTabs";

seedDemoTabs();

console.log('[React] Entry point reached - starting React initialization');
const reactStartTime = performance.now();

// Hide loading screen once React starts
document.body.classList.add('react-loaded');

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

console.log(`[React] Root created at +${(performance.now() - reactStartTime).toFixed(2)}ms`);

root.render(
  <App />
);

console.log(`[React] Render called at +${(performance.now() - reactStartTime).toFixed(2)}ms`);
