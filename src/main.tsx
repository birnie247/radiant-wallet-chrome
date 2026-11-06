// Polyfills MUST come first: they install `Buffer`/`global`/`process` before any
// Radiant library module body is evaluated.
import "./polyfills";

// Brand typeface, bundled locally so the popup never depends on the network for
// its own UI.
import "@fontsource-variable/inter";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { hydrate } from "./lib/storage";

async function start(): Promise<void> {
  // Preferences and the vault live in chrome.storage.local, which is asynchronous,
  // while the wallet reads them synchronously during render. Hydrating first means
  // a returning user never sees the onboarding screen for a frame — which matters,
  // because "Create a new wallet" sitting over an existing vault is a way to lose
  // funds that no amount of care in the UI can fix.
  await hydrate();

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element missing");

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
