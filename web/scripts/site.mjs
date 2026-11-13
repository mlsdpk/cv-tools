// Hosting settings from web/site.config.json, shared by the Vite, Playwright and build configs.
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url), "utf8"));

/** Always has a leading and a trailing slash. */
export const BASE = ("/" + config.base + "/").replace(/\/+/g, "/");
export const ORIGIN = config.origin.replace(/\/+$/, "");
export const SITE_URL = ORIGIN + BASE;
export const SCHEMA_URL = SITE_URL + "schema/v2.json";
export const REPOSITORY = config.repository;
export const ENGINE_SOURCES_TAG_PREFIX = config.engineSourcesTagPrefix;
/** A "Buy me a coffee" page, or null for no link. */
export const COFFEE = config.coffee ?? null;

// 'wasm-unsafe-eval' lets Pyodide and pdfTeX compile WebAssembly; 'unsafe-inline' styles are
// needed because CodeMirror injects its theme as a <style> element.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
