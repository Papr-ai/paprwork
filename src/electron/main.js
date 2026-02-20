// Minimal shim to load Electron main process in CommonJS mode
// This file bypasses the "type": "module" setting in root package.json
require("./index.cjs");
