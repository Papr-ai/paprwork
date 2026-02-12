/**
 * Renderer entry point
 * Initializes React app and mounts to DOM
 */

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

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
