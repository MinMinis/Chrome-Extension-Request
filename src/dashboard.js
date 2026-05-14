import { buildCurlCommand, filterCaptures, serializeForExport } from "./shared.js";

const state = {
  captures: [],
  filtered: [],
  selectedId: "",
  enabled: false,
  tab: "overview",
  filters: {
    query: "",
    method: "ALL",
    statusGroup: "all",
  },
  captureSettings: {
    includeRegex: "",
    excludeRegex: "",
    regexFlags: "i",
  },
};

const nodes = {
  enabledToggle: document.querySelector("#enabledToggle"),
  captureState: document.querySelector("#captureState"),
  totalCount: document.querySelector("#totalCount"),
  errorCount: document.querySelector("#errorCount"),
  queryInput: document.querySelector("#queryInput"),
  methodFilter: document.querySelector("#methodFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  includeRegex: document.querySelector("#includeRegex"),
  excludeRegex: document.querySelector("#excludeRegex"),
  regexFlags: document.querySelector("#regexFlags"),
  regexStatus: document.querySelector("#regexStatus"),
  saveRegexSettings: document.querySelector("#saveRegexSettings"),
  captureList: document.querySelector("#captureList"),
  detailTitle: document.querySelector("#detailTitle"),
  emptyState: document.querySelector("#emptyState"),
  detailPanel: document.querySelector("#detailPanel"),
  summaryStrip: document.querySelector("#summaryStrip"),
  detailContent: document.querySelector("#detailContent"),
  copyCurl: document.querySelector("#copyCurl"),
  exportJson: document.querySelector("#exportJson"),
  clearCaptures: document.querySelector("#clearCaptures"),
  tabs: Array.from(document.querySelectorAll(".tab")),
};

nodes.enabledToggle.addEventListener("change", async () => {
  await request("setEnabled", { enabled: nodes.enabledToggle.checked });
  await loadCaptures();
});

nodes.queryInput.addEventListener("input", () => {
  state.filters.query = nodes.queryInput.value;
  applyFilters();
});

nodes.methodFilter.addEventListener("change", () => {
  state.filters.method = nodes.methodFilter.value;
  applyFilters();
});

nodes.statusFilter.addEventListener("change", () => {
  state.filters.statusGroup = nodes.statusFilter.value;
  applyFilters();
});

nodes.saveRegexSettings.addEventListener("click", async () => {
  await saveCaptureSettings();
});

for (const input of [nodes.includeRegex, nodes.excludeRegex, nodes.regexFlags]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      saveCaptureSettings();
    }
  });
}

nodes.clearCaptures.addEventListener("click", async () => {
  await request("clearCaptures");
  state.selectedId = "";
  await loadCaptures();
});

nodes.copyCurl.addEventListener("click", async () => {
  const capture = selectedCapture();
  if (!capture) {
    return;
  }
  await navigator.clipboard.writeText(buildCurlCommand(capture));
  flashButton(nodes.copyCurl, "Copied");
});

nodes.exportJson.addEventListener("click", () => {
  const json = serializeForExport(state.filtered);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `request-lens-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

for (const tab of nodes.tabs) {
  tab.addEventListener("click", () => {
    state.tab = tab.dataset.tab;
    renderDetails();
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "capturesUpdated" || message.type === "stateChanged") {
    loadCaptures();
  }
});

loadCaptures();

async function loadCaptures() {
  const response = await request("getCaptures");
  state.enabled = response.enabled;
  state.captureSettings = response.captureSettings || state.captureSettings;
  state.captures = response.captures || [];
  if (!state.selectedId && state.captures[0]) {
    state.selectedId = state.captures[0].id;
  }
  applyFilters();
}

function applyFilters() {
  state.filtered = filterCaptures(state.captures, state.filters);
  if (state.selectedId && !state.filtered.some((capture) => capture.id === state.selectedId)) {
    state.selectedId = state.filtered[0]?.id || "";
  }
  render();
}

function render() {
  nodes.enabledToggle.checked = state.enabled;
  nodes.captureState.textContent = state.enabled ? "Capture on" : "Capture off";
  renderCaptureSettings();
  nodes.totalCount.textContent = state.captures.length;
  nodes.errorCount.textContent = state.captures.filter(
    (capture) => capture.error || capture.status >= 400,
  ).length;
  nodes.copyCurl.disabled = !selectedCapture();
  renderList();
  renderDetails();
}

async function saveCaptureSettings() {
  const settings = {
    includeRegex: nodes.includeRegex.value,
    excludeRegex: nodes.excludeRegex.value,
    regexFlags: nodes.regexFlags.value,
  };

  try {
    const response = await request("setCaptureSettings", { settings });
    state.captureSettings = response.captureSettings || settings;
    renderCaptureSettings("Saved");
  } catch (error) {
    renderCaptureSettings(error.message || "Invalid regex", true);
  }
}

function renderCaptureSettings(message, isError = false) {
  const settings = state.captureSettings || {};
  if (document.activeElement !== nodes.includeRegex) {
    nodes.includeRegex.value = settings.includeRegex || "";
  }
  if (document.activeElement !== nodes.excludeRegex) {
    nodes.excludeRegex.value = settings.excludeRegex || "";
  }
  if (document.activeElement !== nodes.regexFlags) {
    nodes.regexFlags.value = settings.regexFlags || "i";
  }

  nodes.regexStatus.textContent = message || regexSummary(settings);
  nodes.regexStatus.classList.toggle("error", Boolean(isError));
}

function renderList() {
  nodes.captureList.replaceChildren();

  if (!state.filtered.length) {
    const empty = document.createElement("li");
    empty.className = "empty-row";
    empty.textContent = "No matching captures";
    nodes.captureList.append(empty);
    return;
  }

  for (const capture of state.filtered) {
    const item = document.createElement("li");
    item.className = capture.id === state.selectedId ? "active" : "";
    item.addEventListener("click", () => {
      state.selectedId = capture.id;
      render();
    });

    const method = document.createElement("span");
    method.className = `method ${capture.method}`;
    method.textContent = capture.method;

    const urlBlock = document.createElement("div");
    urlBlock.className = "request-url";
    const parsed = parseUrl(capture.url);
    const host = document.createElement("strong");
    host.textContent = parsed.host;
    const path = document.createElement("span");
    path.textContent = parsed.path;
    urlBlock.append(host, path);

    const status = document.createElement("span");
    status.className = `status ${isBad(capture) ? "bad" : ""}`;
    status.textContent = capture.error ? "ERR" : capture.status || "-";

    item.append(method, urlBlock, status);
    nodes.captureList.append(item);
  }
}

function renderDetails() {
  const capture = selectedCapture();
  nodes.emptyState.hidden = Boolean(capture);
  nodes.detailPanel.hidden = !capture;

  if (!capture) {
    nodes.detailTitle.textContent = "No capture selected";
    return;
  }

  nodes.detailTitle.textContent = capture.url;
  renderSummary(capture);
  renderTabs();

  if (state.tab === "request") {
    renderBodyPanel("Request", capture.requestBody, capture.requestHeaders);
  } else if (state.tab === "response") {
    renderBodyPanel("Response", capture.responseBody || capture.error, capture.responseHeaders);
  } else if (state.tab === "headers") {
    renderHeadersPanel(capture);
  } else {
    renderOverview(capture);
  }
}

function renderSummary(capture) {
  nodes.summaryStrip.replaceChildren(
    summaryCell("Method", capture.method),
    summaryCell("Status", capture.error ? "Error" : capture.status || "-"),
    summaryCell("Duration", capture.durationMs === null ? "-" : `${capture.durationMs} ms`),
    summaryCell("Type", capture.type || "-"),
  );
}

function renderTabs() {
  for (const tab of nodes.tabs) {
    tab.classList.toggle("active", tab.dataset.tab === state.tab);
  }
}

function renderOverview(capture) {
  nodes.detailContent.innerHTML = "";
  const list = document.createElement("dl");
  list.className = "kv";
  addPair(list, "URL", capture.url);
  addPair(list, "Page", capture.pageUrl || "-");
  addPair(list, "Started", new Date(capture.startedAt).toLocaleString());
  addPair(list, "MIME", capture.mimeType || "-");
  addPair(list, "Request body", bodySize(capture.requestBody));
  addPair(list, "Response body", bodySize(capture.responseBody));
  addPair(list, "Request ID", capture.requestId || "-");
  nodes.detailContent.append(list);
}

function renderBodyPanel(title, body, headers) {
  nodes.detailContent.innerHTML = "";
  const split = document.createElement("div");
  split.className = "split";

  const bodyBlock = document.createElement("section");
  bodyBlock.className = "block";
  const bodyTitle = document.createElement("h3");
  bodyTitle.textContent = `${title} body`;
  const pre = document.createElement("pre");
  pre.textContent = body || "";
  bodyBlock.append(bodyTitle, pre);

  const headerBlock = document.createElement("section");
  headerBlock.className = "block";
  const headerTitle = document.createElement("h3");
  headerTitle.textContent = `${title} headers`;
  headerBlock.append(headerTitle, headersTable(headers));

  split.append(bodyBlock, headerBlock);
  nodes.detailContent.append(split);
}

function renderHeadersPanel(capture) {
  nodes.detailContent.innerHTML = "";
  const split = document.createElement("div");
  split.className = "split";

  const requestBlock = document.createElement("section");
  requestBlock.className = "block";
  const requestTitle = document.createElement("h3");
  requestTitle.textContent = "Request headers";
  requestBlock.append(requestTitle, headersTable(capture.requestHeaders));

  const responseBlock = document.createElement("section");
  responseBlock.className = "block";
  const responseTitle = document.createElement("h3");
  responseTitle.textContent = "Response headers";
  responseBlock.append(responseTitle, headersTable(capture.responseHeaders));

  split.append(requestBlock, responseBlock);
  nodes.detailContent.append(split);
}

function headersTable(headers = []) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const nameHead = document.createElement("th");
  const valueHead = document.createElement("th");
  nameHead.textContent = "Name";
  valueHead.textContent = "Value";
  headRow.append(nameHead, valueHead);
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  if (!headers.length) {
    const row = document.createElement("tr");
    const empty = document.createElement("td");
    empty.colSpan = 2;
    empty.textContent = "No headers captured";
    row.append(empty);
    tbody.append(row);
  }

  for (const header of headers) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const value = document.createElement("td");
    name.textContent = header.name;
    value.textContent = header.value;
    row.append(name, value);
    tbody.append(row);
  }

  table.append(tbody);
  return table;
}

function summaryCell(label, value) {
  const cell = document.createElement("div");
  const caption = document.createElement("span");
  caption.textContent = label;
  const text = document.createElement("strong");
  text.textContent = String(value);
  cell.append(caption, text);
  return cell;
}

function addPair(list, name, value) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = name;
  dd.textContent = String(value);
  list.append(dt, dd);
}

function selectedCapture() {
  return state.captures.find((capture) => capture.id === state.selectedId) || null;
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

function bodySize(value) {
  if (!value) {
    return "0 characters";
  }
  return `${String(value).length.toLocaleString()} characters`;
}

function isBad(capture) {
  return Boolean(capture.error) || capture.status >= 400;
}

function regexSummary(settings = {}) {
  const hasInclude = Boolean(settings.includeRegex);
  const hasExclude = Boolean(settings.excludeRegex);
  if (hasInclude && hasExclude) {
    return "Include / exclude";
  }
  if (hasInclude) {
    return "Include only";
  }
  if (hasExclude) {
    return "Exclude active";
  }
  return "All requests";
}

function flashButton(button, label) {
  const previous = button.textContent;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = previous;
  }, 900);
}
