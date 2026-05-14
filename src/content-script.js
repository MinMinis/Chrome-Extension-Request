const PAGE_SOURCE = "request-lens-page";
const CONTENT_SOURCE = "request-lens-content";
const ENABLED_KEY = "requestLens.enabled";

let enabled = false;

loadState();
injectHook();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[ENABLED_KEY]) {
    enabled = Boolean(changes[ENABLED_KEY].newValue);
    postState();
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE) {
    return;
  }

  if (event.data.type === "ready") {
    postState();
    return;
  }

  if (event.data.type === "capture" && enabled) {
    chrome.runtime
      .sendMessage({ type: "captureFromPage", capture: event.data.capture })
      .catch(() => {});
  }
});

async function loadState() {
  const data = await chrome.storage.local.get(ENABLED_KEY);
  enabled = Boolean(data[ENABLED_KEY]);
  postState();
}

function postState() {
  window.postMessage({ source: CONTENT_SOURCE, type: "state", enabled }, "*");
}

function injectHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/injected.js");
  script.async = false;
  script.onload = () => script.remove();

  const mount = document.documentElement || document.head || document.body;
  if (mount) {
    mount.appendChild(script);
    return;
  }

  document.addEventListener("DOMContentLoaded", () => {
    (document.documentElement || document.head || document.body)?.appendChild(script);
  });
}
