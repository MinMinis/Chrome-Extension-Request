import { MAX_CAPTURES, normalizeCapture, summarizeStats } from "./shared.js";

const STORAGE_KEYS = {
  enabled: "requestLens.enabled",
  captures: "requestLens.captures",
};

const headerTimeline = new Map();
let enabled = false;

bootstrap();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([STORAGE_KEYS.enabled, STORAGE_KEYS.captures]);
  if (existing[STORAGE_KEYS.enabled] === undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.enabled]: false });
  }
  if (!Array.isArray(existing[STORAGE_KEYS.captures])) {
    await chrome.storage.local.set({ [STORAGE_KEYS.captures]: [] });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEYS.enabled]) {
    enabled = Boolean(changes[STORAGE_KEYS.enabled].newValue);
    broadcast({ type: "stateChanged", enabled });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

registerWebRequestObservers();

async function bootstrap() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.enabled);
  enabled = Boolean(data[STORAGE_KEYS.enabled]);
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "getState":
      return getState();
    case "setEnabled":
      enabled = Boolean(message.enabled);
      await chrome.storage.local.set({ [STORAGE_KEYS.enabled]: enabled });
      return getState();
    case "clearCaptures":
      await chrome.storage.local.set({ [STORAGE_KEYS.captures]: [] });
      broadcast({ type: "capturesUpdated" });
      return getState();
    case "getCaptures":
      return getState({ includeCaptures: true });
    case "captureFromPage":
      return saveCaptureFromPage(message.capture, sender);
    case "openDashboard":
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard.html") });
      return {};
    default:
      throw new Error(`Unknown message type: ${message?.type || "empty"}`);
  }
}

async function getState(options = {}) {
  const data = await chrome.storage.local.get([STORAGE_KEYS.enabled, STORAGE_KEYS.captures]);
  const captures = Array.isArray(data[STORAGE_KEYS.captures]) ? data[STORAGE_KEYS.captures] : [];
  const state = {
    enabled: Boolean(data[STORAGE_KEYS.enabled]),
    count: captures.length,
    stats: summarizeStats(captures),
    recent: captures.slice(0, 8),
  };

  if (options.includeCaptures) {
    state.captures = captures;
  }

  return state;
}

async function saveCaptureFromPage(rawCapture, sender) {
  if (!enabled) {
    return { ignored: true };
  }

  const snapshot = findHeaderSnapshot(rawCapture, sender);
  const capture = normalizeCapture({
    ...rawCapture,
    source: "page",
    tabId: sender.tab?.id ?? rawCapture.tabId,
    frameId: sender.frameId ?? rawCapture.frameId,
    pageUrl: rawCapture.pageUrl || sender.url,
    requestHeaders: rawCapture.requestHeaders?.length
      ? rawCapture.requestHeaders
      : snapshot?.requestHeaders,
    responseHeaders: rawCapture.responseHeaders?.length
      ? rawCapture.responseHeaders
      : snapshot?.responseHeaders,
    status: rawCapture.status ?? snapshot?.statusCode,
    requestId: snapshot?.requestId || rawCapture.requestId,
    initiator: snapshot?.initiator || rawCapture.initiator,
  });

  const data = await chrome.storage.local.get(STORAGE_KEYS.captures);
  const captures = Array.isArray(data[STORAGE_KEYS.captures]) ? data[STORAGE_KEYS.captures] : [];
  captures.unshift(capture);
  await chrome.storage.local.set({
    [STORAGE_KEYS.captures]: captures.slice(0, MAX_CAPTURES),
  });

  broadcast({ type: "capturesUpdated", capture });
  return { capture };
}

function registerWebRequestObservers() {
  const filter = { urls: ["<all_urls>"] };
  addWebRequestListener(
    chrome.webRequest.onBeforeSendHeaders,
    captureRequestHeaders,
    filter,
    ["requestHeaders", "extraHeaders"],
    ["requestHeaders"],
  );
  addWebRequestListener(
    chrome.webRequest.onHeadersReceived,
    captureResponseHeaders,
    filter,
    ["responseHeaders", "extraHeaders"],
    ["responseHeaders"],
  );
  chrome.webRequest.onCompleted.addListener(markWebRequestDone, filter);
  chrome.webRequest.onErrorOccurred.addListener(markWebRequestDone, filter);
}

function addWebRequestListener(event, listener, filter, preferredOptions, fallbackOptions) {
  try {
    event.addListener(listener, filter, preferredOptions);
  } catch {
    event.addListener(listener, filter, fallbackOptions);
  }
}

function captureRequestHeaders(details) {
  if (!enabled || details.tabId < 0) {
    return;
  }

  headerTimeline.set(details.requestId, {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    tabId: details.tabId,
    frameId: details.frameId,
    type: details.type,
    initiator: details.initiator || "",
    startedAt: details.timeStamp,
    requestHeaders: details.requestHeaders || [],
    responseHeaders: [],
    statusCode: null,
  });
  pruneHeaderTimeline();
}

function captureResponseHeaders(details) {
  if (!enabled || details.tabId < 0) {
    return;
  }

  const existing = headerTimeline.get(details.requestId) || {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    tabId: details.tabId,
    frameId: details.frameId,
    startedAt: details.timeStamp,
    requestHeaders: [],
  };
  existing.responseHeaders = details.responseHeaders || [];
  existing.statusCode = details.statusCode ?? null;
  existing.endedAt = details.timeStamp;
  headerTimeline.set(details.requestId, existing);
}

function markWebRequestDone(details) {
  const existing = headerTimeline.get(details.requestId);
  if (existing) {
    existing.endedAt = details.timeStamp;
    existing.error = details.error || "";
    headerTimeline.set(details.requestId, existing);
  }
  pruneHeaderTimeline();
}

function findHeaderSnapshot(capture, sender) {
  const tabId = sender.tab?.id ?? capture.tabId;
  const method = String(capture.method || "GET").toUpperCase();
  const startedAt = Number(capture.startedAt || Date.now());
  const candidates = Array.from(headerTimeline.values())
    .filter((item) => item.tabId === tabId)
    .filter((item) => item.url === capture.url)
    .filter((item) => String(item.method || "").toUpperCase() === method)
    .filter((item) => Math.abs(startedAt - item.startedAt) < 15_000)
    .sort((a, b) => Math.abs(startedAt - a.startedAt) - Math.abs(startedAt - b.startedAt));

  return candidates[0] || null;
}

function pruneHeaderTimeline() {
  const cutoff = Date.now() - 60_000;
  for (const [requestId, item] of headerTimeline.entries()) {
    if ((item.endedAt || item.startedAt) < cutoff) {
      headerTimeline.delete(requestId);
    }
  }
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
