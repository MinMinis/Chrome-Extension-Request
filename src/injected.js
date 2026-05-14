(() => {
  if (window.__REQUEST_LENS_HOOKED__) {
    return;
  }
  window.__REQUEST_LENS_HOOKED__ = true;

  const PAGE_SOURCE = "request-lens-page";
  const CONTENT_SOURCE = "request-lens-content";
  const MAX_INLINE_BODY = 65_536;
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  let enabled = false;

  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.source === CONTENT_SOURCE && event.data.type === "state") {
      enabled = Boolean(event.data.enabled);
    }
  });

  window.postMessage({ source: PAGE_SOURCE, type: "ready" }, "*");

  window.fetch = async function requestLensFetch(input, init = {}) {
    if (!enabled) {
      return originalFetch.apply(this, arguments);
    }

    const startedAt = Date.now();
    const timerStart = performance.now();
    const request = inspectFetchRequest(input, init);

    try {
      const response = await originalFetch.apply(this, arguments);
      captureFetchResponse(response.clone(), request, startedAt, timerStart);
      return response;
    } catch (error) {
      const requestBody = await request.requestBody.catch(() => "");
      publishCapture({
        ...request,
        requestBody,
        id: createId(),
        type: "fetch",
        error: error?.message || String(error),
        startedAt,
        endedAt: Date.now(),
        durationMs: performance.now() - timerStart,
      });
      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function requestLensOpen(method, url) {
    this.__requestLens = {
      method: String(method || "GET").toUpperCase(),
      url: absolutizeUrl(url),
      requestHeaders: [],
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function requestLensSetRequestHeader(name, value) {
    if (this.__requestLens) {
      this.__requestLens.requestHeaders.push({ name: String(name), value: String(value) });
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function requestLensSend(body) {
    if (!enabled || !this.__requestLens) {
      return originalSend.apply(this, arguments);
    }

    const meta = this.__requestLens;
    const startedAt = Date.now();
    const timerStart = performance.now();
    const requestBody = serializeBody(body);

    this.addEventListener(
      "loadend",
      async () => {
        publishCapture({
          id: createId(),
          type: "xhr",
          method: meta.method,
          url: meta.url,
          requestHeaders: meta.requestHeaders,
          requestBody: await requestBody,
          status: this.status || null,
          statusText: this.statusText || "",
          ok: this.status >= 200 && this.status < 400,
          responseHeaders: parseRawHeaders(this.getAllResponseHeaders()),
          responseBody: await readXhrBody(this),
          mimeType: this.getResponseHeader("content-type") || "",
          startedAt,
          endedAt: Date.now(),
          durationMs: performance.now() - timerStart,
        });
      },
      { once: true },
    );

    return originalSend.apply(this, arguments);
  };

  function inspectFetchRequest(input, init) {
    const request = input instanceof Request ? input : null;
    const method = String(init.method || request?.method || "GET").toUpperCase();
    const headers = mergeHeaders(request?.headers, init.headers);
    const requestBody =
      init.body !== undefined ? serializeBody(init.body) : request ? readRequestBody(request) : Promise.resolve("");

    return {
      method,
      url: request ? request.url : absolutizeUrl(input),
      requestHeaders: headers,
      requestBody,
      pageUrl: location.href,
    };
  }

  async function captureFetchResponse(response, request, startedAt, timerStart) {
    try {
      const [requestBody, responseBody] = await Promise.all([
        request.requestBody,
        readResponseBody(response),
      ]);
      publishCapture({
        ...request,
        requestBody,
        id: createId(),
        type: "fetch",
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        responseHeaders: headersToArray(response.headers),
        responseBody,
        mimeType: response.headers.get("content-type") || "",
        startedAt,
        endedAt: Date.now(),
        durationMs: performance.now() - timerStart,
      });
    } catch (error) {
      publishCapture({
        ...request,
        requestBody: "",
        id: createId(),
        type: "fetch",
        error: error?.message || String(error),
        startedAt,
        endedAt: Date.now(),
        durationMs: performance.now() - timerStart,
      });
    }
  }

  function mergeHeaders(baseHeaders, overrideHeaders) {
    const map = new Map();
    for (const header of headersToArray(baseHeaders)) {
      map.set(header.name.toLowerCase(), header);
    }
    for (const header of headersToArray(overrideHeaders)) {
      map.set(header.name.toLowerCase(), header);
    }
    return Array.from(map.values());
  }

  function headersToArray(headers) {
    if (!headers) {
      return [];
    }
    if (headers instanceof Headers) {
      return Array.from(headers.entries()).map(([name, value]) => ({ name, value }));
    }
    if (Array.isArray(headers)) {
      return headers.map(([name, value]) => ({ name: String(name), value: String(value) }));
    }
    return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
  }

  async function readRequestBody(request) {
    try {
      const contentType = request.headers.get("content-type") || "";
      const buffer = await request.clone().arrayBuffer();
      return formatBinaryBody(new Uint8Array(buffer), "Request body", contentType);
    } catch {
      return "";
    }
  }

  async function readResponseBody(response) {
    try {
      if (response.type === "opaque") {
        return "[opaque response body unavailable]";
      }
      const contentType = response.headers.get("content-type") || "";
      const buffer = await response.clone().arrayBuffer();
      return formatBinaryBody(new Uint8Array(buffer), "Response body", contentType);
    } catch {
      return "[response body unavailable]";
    }
  }

  async function readXhrBody(xhr) {
    try {
      if (!xhr.responseType || xhr.responseType === "text") {
        return clampText(xhr.responseText || "");
      }
      if (xhr.responseType === "json") {
        return clampText(JSON.stringify(xhr.response, null, 2));
      }
      if (xhr.responseType === "arraybuffer" && xhr.response) {
        return formatBinaryBody(
          new Uint8Array(xhr.response),
          "ArrayBuffer response",
          xhr.getResponseHeader("content-type") || "",
        );
      }
      if (xhr.responseType === "blob" && xhr.response) {
        return formatBlobBody(xhr.response, "Blob response");
      }
      if (xhr.response) {
        return formatUnknownBody(xhr.response, `${xhr.responseType || "unknown"} response`);
      }
      return "";
    } catch {
      return "[response body unavailable]";
    }
  }

  async function serializeBody(body) {
    if (body === undefined || body === null) {
      return "";
    }
    if (typeof body === "string") {
      return clampText(body);
    }
    if (body instanceof URLSearchParams) {
      return clampText(body.toString());
    }
    if (body instanceof FormData) {
      return clampText(
        Array.from(body.entries())
          .map(([key, value]) => `${key}=${formatFormValue(value)}`)
          .join("&"),
      );
    }
    if (body instanceof Blob) {
      return formatBlobBody(body, "Blob request");
    }
    if (body instanceof ArrayBuffer) {
      return formatBinaryBody(new Uint8Array(body), "ArrayBuffer request");
    }
    if (ArrayBuffer.isView(body)) {
      return formatBinaryBody(
        new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        `${body.constructor.name} request`,
      );
    }
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      return "[ReadableStream body unavailable]";
    }
    try {
      return clampText(JSON.stringify(body, null, 2));
    } catch {
      return clampText(String(body));
    }
  }

  async function formatBlobBody(blob, label) {
    const contentType = blob.type || "";
    try {
      const buffer = await blob.arrayBuffer();
      return formatBinaryBody(new Uint8Array(buffer), label, contentType);
    } catch {
      return `${label} (${blob.type || "application/octet-stream"} ${blob.size} bytes)\n\n[body read failed]`;
    }
  }

  function formatUnknownBody(value, label) {
    if (value instanceof ArrayBuffer) {
      return formatBinaryBody(new Uint8Array(value), label);
    }
    if (ArrayBuffer.isView(value)) {
      return formatBinaryBody(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        label || value.constructor.name,
      );
    }
    try {
      return clampText(JSON.stringify(value, null, 2));
    } catch {
      return clampText(String(value));
    }
  }

  function formatBinaryBody(bytes, label, mimeType = "") {
    const decoded = decodeReadableText(bytes, mimeType);
    if (decoded !== null) {
      return clampText(decoded);
    }

    return clampText(
      `${label} (${bytes.byteLength} bytes)\n\nhex:\n${bytesToHexDump(bytes)}\n\nbase64:\n${bytesToBase64(bytes)}`,
    );
  }

  function decodeReadableText(bytes, mimeType) {
    if (!bytes.byteLength) {
      return "";
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (isTextMime(mimeType) || looksLikeReadableText(text)) {
      return text;
    }

    return null;
  }

  function isTextMime(mimeType) {
    return /(^text\/|json|xml|javascript|typescript|graphql|x-www-form-urlencoded|svg)/i.test(
      mimeType || "",
    );
  }

  function looksLikeReadableText(text) {
    if (!text || text.includes("\uFFFD")) {
      return false;
    }

    let suspicious = 0;
    for (const char of text) {
      const code = char.charCodeAt(0);
      const allowedControl = code === 9 || code === 10 || code === 13;
      if ((code < 32 && !allowedControl) || code === 127) {
        suspicious += 1;
      }
    }

    return suspicious / Math.max(text.length, 1) < 0.02;
  }

  function bytesToHexDump(bytes) {
    const rows = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const chunk = bytes.slice(offset, offset + 16);
      const hex = Array.from(chunk)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" ")
        .padEnd(47, " ");
      const ascii = Array.from(chunk)
        .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."))
        .join("");
      rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
    }
    return rows.join("\n");
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function formatFormValue(value) {
    if (value instanceof File) {
      return `[File ${value.name} ${value.type || "application/octet-stream"} ${value.size} bytes]`;
    }
    return String(value);
  }

  function parseRawHeaders(rawHeaders) {
    return String(rawHeaders || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator === -1) {
          return { name: line, value: "" };
        }
        return {
          name: line.slice(0, separator).trim(),
          value: line.slice(separator + 1).trim(),
        };
      });
  }

  function publishCapture(capture) {
    window.postMessage(
      {
        source: PAGE_SOURCE,
        type: "capture",
        capture: {
          ...capture,
          pageUrl: location.href,
        },
      },
      "*",
    );
  }

  function absolutizeUrl(url) {
    try {
      return new URL(String(url), location.href).href;
    } catch {
      return String(url);
    }
  }

  function clampText(text) {
    const value = String(text ?? "");
    if (value.length <= MAX_INLINE_BODY) {
      return value;
    }
    return `${value.slice(0, MAX_INLINE_BODY)}\n\n[truncated ${value.length - MAX_INLINE_BODY} characters]`;
  }

  function createId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();
