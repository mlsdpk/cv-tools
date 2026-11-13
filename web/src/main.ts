import "./fonts.css";
import "./styles.css";
import { App } from "./app";
import { sayHello } from "./site";

const app = new App();
app.start();

if ("serviceWorker" in navigator && import.meta.env.PROD && location.protocol !== "file:") {
  const sw = navigator.serviceWorker;
  const build = sayHello();
  let reloading = false;
  sw.addEventListener("controllerchange", () => {
    if (reloading) location.reload();
    else app.notice("cv-tools was updated in another tab. Reload this tab when convenient to use the new version.", [{ label: "Reload", run: () => location.reload() }], 0);
  });
  const offer = (reg: ServiceWorkerRegistration) => {
    // Only an update waits; a first install has nothing to replace.
    if (!reg.waiting || !sw.controller) return;
    app.offerUpdate("A new version of cv-tools is available. Your work is saved; reload to use it.", [
      {
        label: "Reload",
        run: () => {
          app.flush();
          reloading = true;
          reg.waiting?.postMessage({ type: "skip-waiting" });
        },
      },
    ]);
  };
  sw.register(import.meta.env.BASE_URL + "sw.js", { scope: import.meta.env.BASE_URL }).then(
    (reg) => {
      offer(reg);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed") offer(reg);
        });
      });
      // A first install does not control this page: tell it anyway.
      sw.ready.then((r) => r.active?.postMessage({ type: "hello", build })).catch(() => {});
    },
    () => {
      // No offline support (private mode): the app still works.
    },
  );
}
