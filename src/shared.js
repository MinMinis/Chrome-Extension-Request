export const MAX_BODY_CHARS = 65_536;
export const MAX_CAPTURES = 250;
export const DEFAULT_CAPTURE_SETTINGS = {
  includeRegex: "",
  excludeRegex: "",
  regexFlags: "i",
};

export function clampBody(value, maxChars = MAX_BODY_CHARS) {
  if (value === undefined || value === null) {
    return "";
  }

  const text = typeof value === "string" ? value : safeStringify(value);
  if (text.length <= maxChars) {
    return text;
  }

  const truncated = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated ${truncated} characters]`;
}

export function normalizeHeaders(headers = []) {
  if (!headers) {
    return [];
  }

  if (Array.isArray(headers)) {
    return headers
      .filter(Boolean)
      .map((header) => ({
        name: String(header.name ?? header[0] ?? "").trim(),
        value: String(header.value ?? header[1] ?? ""),
      }))
      .filter((header) => header.name);
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Array.from(headers.entries()).map(([name, value]) => ({ name, value }));
  }

  if (typeof headers === "object") {
    return Object.entries(headers).map(([name, value]) => ({
      name,
      value: Array.isArray(value) ? value.join(", ") : String(value),
    }));
  }

  return [];
}

export function normalizeCapture(capture = {}) {
  const status = toNumberOrNull(capture.status ?? capture.statusCode);
  const startedAt = toNumberOrNow(capture.startedAt);
  const endedAt = toNumberOrNull(capture.endedAt);
  const durationMs =
    capture.durationMs === undefined || capture.durationMs === null
      ? null
      : Math.max(0, Math.round(Number(capture.durationMs)));

  return {
    id: capture.id || createCaptureId(),
    requestId: capture.requestId || "",
    source: capture.source || "page",
    type: capture.type || "fetch",
    method: String(capture.method || "GET").toUpperCase(),
    url: String(capture.url || ""),
    pageUrl: String(capture.pageUrl || ""),
    initiator: String(capture.initiator || ""),
    tabId: toNumberOrNull(capture.tabId),
    frameId: toNumberOrNull(capture.frameId),
    status,
    statusText: String(capture.statusText || ""),
    ok: capture.ok ?? (status !== null ? status >= 200 && status < 400 : false),
    error: capture.error ? String(capture.error) : "",
    startedAt,
    endedAt,
    durationMs,
    requestHeaders: normalizeHeaders(capture.requestHeaders),
    responseHeaders: normalizeHeaders(capture.responseHeaders),
    requestBody: clampBody(capture.requestBody),
    responseBody: clampBody(capture.responseBody),
    mimeType: String(capture.mimeType || ""),
  };
}

export function normalizeCaptureSettings(settings = {}) {
  settings = settings || {};
  return {
    includeRegex: String(settings.includeRegex || "").trim(),
    excludeRegex: String(settings.excludeRegex || "").trim(),
    regexFlags: normalizeRegexFlags(settings.regexFlags),
  };
}

export function validateCaptureSettings(settings = {}) {
  const normalized = normalizeCaptureSettings(settings);
  compileUserRegex(normalized.includeRegex, normalized.regexFlags, "Include regex");
  compileUserRegex(normalized.excludeRegex, normalized.regexFlags, "Exclude regex");
  return normalized;
}

export function matchesCaptureSettings(capture, settings = {}) {
  const normalized = normalizeCaptureSettings(settings);
  const target = captureMatchTarget(capture);
  let include = null;
  let exclude = null;
  try {
    include = compileUserRegex(normalized.includeRegex, normalized.regexFlags);
    exclude = compileUserRegex(normalized.excludeRegex, normalized.regexFlags);
  } catch {
    return true;
  }

  if (include && !include.test(target)) {
    return false;
  }

  if (exclude && exclude.test(target)) {
    return false;
  }

  return true;
}

export function filterCaptures(captures, filters = {}) {
  const method = String(filters.method || "ALL").toUpperCase();
  const query = String(filters.query || "").trim().toLowerCase();
  const statusGroup = String(filters.statusGroup || "all").toLowerCase();

  return captures.filter((capture) => {
    if (method !== "ALL" && capture.method !== method) {
      return false;
    }

    if (!matchesStatusGroup(capture, statusGroup)) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      capture.method,
      capture.url,
      capture.status,
      capture.statusText,
      capture.type,
      capture.pageUrl,
      capture.requestBody,
      capture.responseBody,
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

export function buildCurlCommand(capture) {
  const method = String(capture.method || "GET").toUpperCase();
  const parts = ["curl", "-i", "-X", method, quoteShell(capture.url || "")];

  for (const header of normalizeHeaders(capture.requestHeaders)) {
    parts.push("-H", quoteShell(`${header.name}: ${header.value}`));
  }

  if (capture.requestBody) {
    parts.push("--data-raw", quoteShell(capture.requestBody));
  }

  return parts.join(" ");
}

export function serializeForExport(captures) {
  const normalized = captures.map((capture) => normalizeCapture(capture));
  return JSON.stringify(
    {
      tool: "Request Lens",
      exportedAt: new Date().toISOString(),
      count: normalized.length,
      captures: normalized,
    },
    null,
    2,
  );
}

export function summarizeStats(captures = []) {
  const stats = {
    total: captures.length,
    ok: 0,
    errors: 0,
    methods: {},
  };

  for (const capture of captures) {
    stats.methods[capture.method] = (stats.methods[capture.method] || 0) + 1;
    if (capture.error || (capture.status !== null && capture.status >= 400)) {
      stats.errors += 1;
    } else {
      stats.ok += 1;
    }
  }

  return stats;
}

function matchesStatusGroup(capture, statusGroup) {
  if (statusGroup === "all") {
    return true;
  }

  if (statusGroup === "error") {
    return Boolean(capture.error) || capture.status === null || capture.status >= 400;
  }

  const match = statusGroup.match(/^([1-5])xx$/);
  if (!match || capture.status === null) {
    return false;
  }

  return Math.floor(capture.status / 100) === Number(match[1]);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function captureMatchTarget(capture = {}) {
  return [
    capture.method,
    capture.url,
    capture.status,
    capture.statusText,
    capture.type,
    capture.pageUrl,
    capture.mimeType,
  ]
    .filter((part) => part !== undefined && part !== null)
    .join(" ");
}

function normalizeRegexFlags(flags) {
  const allowed = new Set(["i", "m", "s", "u", "y"]);
  const raw = flags === undefined || flags === null ? "i" : String(flags);
  return Array.from(new Set(raw.split("")))
    .filter((flag) => allowed.has(flag))
    .join("");
}

function compileUserRegex(pattern, flags, label = "Regex") {
  if (!pattern) {
    return null;
  }

  try {
    return new RegExp(pattern, normalizeRegexFlags(flags));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toNumberOrNow(value) {
  const number = toNumberOrNull(value);
  return number === null ? Date.now() : number;
}

function createCaptureId() {
  const random =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `capture-${Date.now()}-${random}`;
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
