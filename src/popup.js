const enabledToggle = document.querySelector("#enabledToggle");
const stateText = document.querySelector("#stateText");
const totalCount = document.querySelector("#totalCount");
const okCount = document.querySelector("#okCount");
const errorCount = document.querySelector("#errorCount");
const methodMix = document.querySelector("#methodMix");
const recentList = document.querySelector("#recentList");
const openDashboard = document.querySelector("#openDashboard");
const clearCaptures = document.querySelector("#clearCaptures");

enabledToggle.addEventListener("change", async () => {
  await request("setEnabled", { enabled: enabledToggle.checked });
  await refresh();
});

openDashboard.addEventListener("click", () => {
  request("openDashboard");
});

clearCaptures.addEventListener("click", async () => {
  await request("clearCaptures");
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "capturesUpdated" || message.type === "stateChanged") {
    refresh();
  }
});

refresh();

async function refresh() {
  const state = await request("getState");
  enabledToggle.checked = state.enabled;
  stateText.textContent = state.enabled
    ? captureModeText(state.captureSettings)
    : "Capture off";
  totalCount.textContent = state.stats.total;
  okCount.textContent = state.stats.ok;
  errorCount.textContent = state.stats.errors;
  methodMix.textContent = formatMethodMix(state.stats.methods);
  renderRecent(state.recent || []);
}

function renderRecent(captures) {
  recentList.replaceChildren();

  if (!captures.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No captures yet";
    recentList.append(empty);
    return;
  }

  for (const capture of captures) {
    const item = document.createElement("li");

    const method = document.createElement("span");
    method.className = `method ${capture.method}`;
    method.textContent = capture.method;

    const url = document.createElement("div");
    url.className = "url";
    const parsed = parseUrl(capture.url);
    const host = document.createElement("strong");
    host.textContent = parsed.host;
    const path = document.createElement("span");
    path.textContent = parsed.path;
    url.append(host, path);

    const status = document.createElement("span");
    status.className = `status ${capture.status >= 400 || capture.error ? "bad" : "good"}`;
    status.textContent = capture.error ? "ERR" : capture.status || "-";

    item.append(method, url, status);
    recentList.append(item);
  }
}

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    throw new Error(response?.error || "Request Lens background error");
  }
  return response;
}

function parseUrl(value) {
  try {
    const url = new URL(value);
    return { host: url.host, path: `${url.pathname}${url.search}` || "/" };
  } catch {
    return { host: value || "unknown", path: "" };
  }
}

function formatMethodMix(methods = {}) {
  const entries = Object.entries(methods);
  if (!entries.length) {
    return "Idle";
  }
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([method, count]) => `${method} ${count}`)
    .join(" / ");
}

function captureModeText(settings = {}) {
  if (settings.includeRegex || settings.excludeRegex) {
    return "Capture on / regex";
  }
  return "Capture on";
}
