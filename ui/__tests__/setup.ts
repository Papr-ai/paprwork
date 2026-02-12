/**
 * Vitest Setup File
 * Configures testing environment
 */

import { expect, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock WebSocket
global.WebSocket = vi.fn() as any;

// Mock navigator.geolocation
Object.defineProperty(global.navigator, "geolocation", {
  value: {
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
  },
  writable: true,
});

// Mock fetch
global.fetch = vi.fn();

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Mock window object for browser-specific code
if (typeof global.window === "undefined") {
  (global as any).window = {};
}
(global as any).window.__chatStore__ = null;
