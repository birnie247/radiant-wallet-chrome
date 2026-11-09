/**
 * Startup watchdog for the popup.
 *
 * This lives in its own module graph (see `popup.html`) on purpose. If the app
 * bundle throws while evaluating — a missing global, a bad import — then nothing
 * inside it can render an error, because none of its code ever ran. An independent
 * script is what still gets to report the failure.
 *
 * Worth the effort because a blank popup in a wallet is worse than an ugly one:
 * users read a blank balance as "no funds" rather than "broken".
 */

let shown = false;

function report(kind: string, detail: string): void {
  if (shown) return;
  shown = true;
  const root = document.getElementById("root");
  if (!root) return;
  const pre = document.createElement("pre");
  pre.className = "boot-error";
  pre.textContent = `Lumen RXD Wallet failed to start\n\n${kind}\n${detail}`;
  root.replaceChildren(pre);
}

window.addEventListener("error", (event) => {
  const error = event.error as Error | undefined;
  report("Uncaught error", `${event.message}\n${error?.stack ?? ""}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as Error | string | undefined;
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? "") : "";
  report("Unhandled promise rejection", `${message}\n${stack}`);
});

// If the bundle loaded but React never mounted, say so rather than sit blank.
setTimeout(() => {
  if (!document.querySelector("#root .app")) {
    report("Watchdog", "The bundle loaded but never mounted the app.");
  }
}, 8000);
