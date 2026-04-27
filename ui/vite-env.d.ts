/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REQUIRE_PAPR_AUTH?: string;
  // Add other env variables here as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
