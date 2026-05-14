(() => {
  if (window.__REQUEST_LENS_BRIDGE_READY__) {
    return;
  }
  window.__REQUEST_LENS_BRIDGE_READY__ = true;

  const PAGE_SOURCE = "request-lens-page";
  const CONTENT_SOURCE = "request-lens-content";
  const ENABLED_KEY = "requestLens.enabled";
  const SETTINGS_KEY = "requestLens.captureSettings";

  let enabled = false;
  let captureSettings = {};

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes[ENABLED_KEY]) {
      enabled = Boolean(changes[ENABLED_KEY].newValue);
    }
    if (changes[SETTINGS_KEY]) {
      captureSettings = changes[SETTINGS_KEY].newValue || {};
    }
    postSettings();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE) {
      return;
    }

    if (event.data.type === "ready") {
      postSettings();
      return;
    }

    if (event.data.type === "capture") {
      chrome.runtime
        .sendMessage({ type: "captureFromPage", capture: event.data.capture })
        .catch(() => {});
    }
  });

  loadState();
  injectHook();

  async function loadState() {
    const data = await chrome.storage.local.get([ENABLED_KEY, SETTINGS_KEY]);
    enabled = Boolean(data[ENABLED_KEY]);
    captureSettings = data[SETTINGS_KEY] || {};
    postSettings();
  }

  function postSettings() {
    window.postMessage(
      {
        source: CONTENT_SOURCE,
        type: "settings",
        enabled,
        captureSettings,
      },
      "*",
    );
  }

  async function injectHook() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "injectMainWorld" });
      if (response?.ok) {
        return;
      }
    } catch {
      // Fall back to script-tag injection below.
    }

    injectHookWithScriptTag();
  }

  function injectHookWithScriptTag() {
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
})();
