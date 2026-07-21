/** MIME types and helpers for mini-app static assets served by the gateway. */

const MINI_APP_MIME_TYPES: Record<string, string> = {
  // Fonts
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".eot": "application/vnd.ms-fontobject",
  // Images
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  // Audio / video
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".oga": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".mov": "video/quicktime",
  // Other binary
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  // Text assets (served as UTF-8 through the text pipeline)
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".tsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const MINI_APP_TEXT_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".ts",
  ".tsx",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".md",
]);

/** True when the file must be streamed as raw bytes (fonts, images, etc.). */
export function isMiniAppBinaryExtension(ext: string): boolean {
  const normalized = ext.toLowerCase();
  if (MINI_APP_TEXT_EXTENSIONS.has(normalized)) {
    return false;
  }
  return normalized in MINI_APP_MIME_TYPES;
}

export function getMiniAppContentType(ext: string): string {
  return (
    MINI_APP_MIME_TYPES[ext.toLowerCase()] ?? "application/octet-stream"
  );
}
