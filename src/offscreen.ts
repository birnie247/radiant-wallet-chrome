/**
 * Offscreen document: keeps the Electrum subscription alive while the popup is
 * closed.
 *
 * An MV3 service worker is terminated when idle and cannot hold a WebSocket, so the
 * only supported home for a long-lived connection is an offscreen document (Chrome
 * requires a reason; `WORKERS` is the one that fits). The popup can then be closed
 * and the extension still notices an incoming payment.
 *
 * Two constraints shaped this file:
 *   • **No wallet code**: no SDK, no signing, no keys. It speaks raw JSON-RPC for a
 *     handful of methods and reports "something changed" to the service worker.
 *     Everything it knows — an endpoint and some scripthashes — is already public.
 *   • **No `chrome.storage`**: offscreen documents only get a subset of extension
 *     APIs, and storage is not in it. Configuration therefore arrives by message
 *     from the service worker, which is the only context holding storage.
 */

const WATCH_KEY = "rxd.watch.list";
const ENABLED_KEY = "rxd.watch.enabled";

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const PING_MS = 45_000;
const RPC_TIMEOUT_MS = 10_000;

interface WatchList {
  endpoint: string;
  scripthashes: string[];
}

let socket: WebSocket | null = null;
let current: WatchList | null = null;
let attempt = 0;
let retryTimer: number | undefined;
let pingTimer: number | undefined;
let rpcId = 0;
const pending = new Map<number, (value: unknown) => void>();

/**
 * Observable state, for diagnostics and for the extension smoke test.
 *
 * Holds only what is already public (endpoint, counts, timestamps) so it is safe to
 * leave reachable, and it lets a test assert that the socket really opened and
 * subscribed rather than merely that a document exists.
 */
const diagnostics = {
  status: "starting" as "starting" | "connecting" | "open" | "closed" | "stopped",
  endpoint: null as string | null,
  subscribed: 0,
  notifications: 0,
  lastNotificationAt: 0,
  lastError: "",
  reconnects: 0,
};
(globalThis as { __rxdWatcher?: typeof diagnostics }).__rxdWatcher = diagnostics;

function log(message: string): void {
  console.log(`[watcher] ${message}`);
}

/**
 * Apply configuration pushed by the service worker.
 *
 * Validation lives here as well as in the worker so a malformed message cannot make
 * this document connect somewhere unexpected: only `wss://` and 64-hex scripthashes
 * are accepted.
 */
function applyConfig(endpoint: unknown, scripthashes: unknown): void {
  const valid =
    typeof endpoint === "string" &&
    endpoint.startsWith("wss://") &&
    Array.isArray(scripthashes) &&
    scripthashes.length > 0 &&
    scripthashes.every((s) => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s));

  if (!valid) {
    current = null;
    stop();
    return;
  }

  const next: WatchList = {
    endpoint: endpoint as string,
    scripthashes: scripthashes as string[],
  };
  const changed =
    !current ||
    current.endpoint !== next.endpoint ||
    current.scripthashes.join(",") !== next.scripthashes.join(",");
  current = next;
  if (changed) {
    attempt = 0;
    void connect();
  }
}

/** Tell the service worker the balance situation changed. */
function reportActivity(scripthash: string, status: string | null): void {
  chrome.runtime
    .sendMessage({ type: "watch:activity", scripthash, status, at: Date.now() })
    .catch(() => {
      /* the worker may be asleep; it will resubscribe on wake */
    });
}

function request(method: string, ...params: unknown[]): Promise<unknown> {
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      resolve(null);
      return;
    }
    const id = ++rpcId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) resolve(null);
    }, RPC_TIMEOUT_MS);
  });
}

function clearTimers(): void {
  if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined; }
  if (pingTimer !== undefined) { clearInterval(pingTimer); pingTimer = undefined; }
}

function scheduleReconnect(): void {
  clearTimers();
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
  attempt = Math.min(attempt + 1, 5);
  diagnostics.reconnects += 1;
  log(`reconnecting in ${Math.round(delay / 1000)}s`);
  retryTimer = setTimeout(() => void connect(), delay) as unknown as number;
}

/** Open the socket, subscribe to every watched scripthash, and stay subscribed. */
async function connect(): Promise<void> {
  clearTimers();
  if (!current) return;

  try {
    socket?.close();
  } catch {
    /* ignore */
  }

  const url = current.endpoint;
  log(`connecting to ${url}`);
  diagnostics.status = "connecting";
  diagnostics.endpoint = url;
  diagnostics.subscribed = 0;
  const ws = new WebSocket(url);
  socket = ws;

  ws.addEventListener("open", () => {
    attempt = 0;
    diagnostics.status = "open";
    log(`open, subscribing to ${current?.scripthashes.length ?? 0} scripthash(es)`);
    // Subscribing is what makes the server push; the initial status is ignored
    // because it describes the state we already have.
    for (const scripthash of current?.scripthashes ?? []) {
      void request("blockchain.scripthash.subscribe", scripthash);
      diagnostics.subscribed += 1;
    }
    pingTimer = setInterval(() => {
      // Some servers drop idle sockets; a cheap request proves the link is alive.
      void request("server.ping");
    }, PING_MS) as unknown as number;
  });

  ws.addEventListener("message", (event) => {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown[];
      result?: unknown;
    };
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      pending.get(msg.id)?.(msg.result);
      pending.delete(msg.id);
      return;
    }

    // Push: the status for a scripthash changed, i.e. balance or history moved.
    if (msg.method === "blockchain.scripthash.subscribe" && Array.isArray(msg.params)) {
      const [scripthash, status] = msg.params as [string, string | null];
      diagnostics.notifications += 1;
      diagnostics.lastNotificationAt = Date.now();
      reportActivity(scripthash, status ?? null);
    }
  });

  ws.addEventListener("close", () => {
    clearTimers();
    if (!socket || socket !== ws) return;
    diagnostics.status = "closed";
    log("socket closed");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // "error" is always followed by "close", which owns the retry.
    diagnostics.lastError = "socket error";
    log("socket error");
  });
}

function stop(): void {
  clearTimers();
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  socket = null;
  diagnostics.status = "stopped";
  log("stopped");
}

/**
 * Configuration comes from the service worker, which owns storage.
 *
 * The document asks once on load — the worker may have created this document before
 * this script ran — and then listens for pushes when the watch list changes.
 */
function requestConfig(): void {
  chrome.runtime
    .sendMessage({ type: "watch:hello" })
    .then((reply: { endpoint?: string; scripthashes?: string[] } | undefined) => {
      if (reply?.endpoint && reply?.scripthashes) {
        applyConfig(reply.endpoint, reply.scripthashes);
      }
    })
    .catch(() => {
      /* worker asleep; it will push configuration when it wakes */
    });
}

chrome.runtime.onMessage.addListener((message: { type?: string; endpoint?: unknown; scripthashes?: unknown }) => {
  switch (message?.type) {
    case "watch:config":
      applyConfig(message.endpoint, message.scripthashes);
      break;
    case "watch:stop":
      current = null;
      stop();
      break;
    default:
      break;
  }
  // Nothing is returned: no reply is expected for these.
});

void requestConfig();

