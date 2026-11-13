// Build-time settings (vite.config.ts and web/site.config.json).
declare const __SITE__: { url: string; schemaUrl: string; repository: string; engineSourcesTagPrefix: string; coffee: string | null };
declare const __PYODIDE_DIR__: string;
declare const __ENGINE_DIR__: string;
declare const __PYODIDE_BYTES__: number;

export const SITE = __SITE__;
export const BASE_URL = new URL(import.meta.env.BASE_URL, location.href).href;
/** Pyodide and the engine, in directories versioned by content in a build. */
export const PYODIDE_DIR = __PYODIDE_DIR__;
export const ENGINE_DIR = __ENGINE_DIR__;
export const PYODIDE_BYTES = __PYODIDE_BYTES__;

/** The build of this page, told to the service worker so it keeps that build's cache while the page is open. */
export function sayHello(): string {
  const build = document.querySelector<HTMLMetaElement>('meta[name="cv-build"]')?.content ?? "dev";
  const sw = navigator.serviceWorker;
  if (!sw || !import.meta.env.PROD) return build;
  const hello = () => sw.controller?.postMessage({ type: "hello", build });
  hello();
  sw.addEventListener("controllerchange", hello);
  return build;
}
