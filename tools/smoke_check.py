from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ID_SELECTOR_PATTERN = re.compile(r'document\.querySelector\("#([^"]+)"\)')


def main() -> None:
    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert manifest["manifest_version"] == 3
    assert manifest["background"]["type"] == "module"
    assert "<all_urls>" in manifest["host_permissions"]
    assert "storage" in manifest["permissions"]
    assert "webRequest" in manifest["permissions"]
    assert "scripting" in manifest["permissions"]
    assert "unlimitedStorage" in manifest["permissions"]
    assert all(item.get("world") != "MAIN" for item in manifest["content_scripts"])

    required_paths = {
        manifest["background"]["service_worker"],
        "src/shared.js",
        "src/popup.html",
        "src/popup.css",
        "src/popup.js",
        "src/dashboard.html",
        "src/dashboard.css",
        "src/dashboard.js",
        "src/content-script.js",
        "src/injected.js",
        "tests/shared.test.js",
    }

    for content_script in manifest["content_scripts"]:
        required_paths.update(content_script["js"])

    for resource_group in manifest["web_accessible_resources"]:
        required_paths.update(resource_group["resources"])

    missing = sorted(path for path in required_paths if not (ROOT / path).exists())
    assert not missing, f"Missing referenced files: {missing}"

    shared = (ROOT / "src/shared.js").read_text(encoding="utf-8")
    for export_name in (
        "clampBody",
        "normalizeCapture",
        "normalizeCaptureSettings",
        "matchesCaptureSettings",
        "filterCaptures",
        "buildCurlCommand",
        "serializeForExport",
    ):
        assert re.search(rf"export function {export_name}\b", shared), export_name

    for path in required_paths:
        text = (ROOT / path).read_text(encoding="utf-8")
        assert "TODO" not in text, f"Unexpected TODO in {path}"

    injected = (ROOT / "src/injected.js").read_text(encoding="utf-8")
    assert "matchesCaptureSettings" in injected
    assert "captureSettings" in injected
    assert "function formatBinaryBody" in injected
    assert "function bytesToHexDump" in injected
    assert "function bytesToBase64" in injected
    assert "async function captureFetchResponse" in injected
    assert "const responseBody = await readResponseBody(response);" not in injected
    assert "async function serializeBody" in injected
    assert "requestBody: await requestBody" in injected
    assert "responseBody: await readXhrBody(this)" in injected
    assert "readResponseText" not in injected
    assert "return `[ArrayBuffer ${body.byteLength} bytes]`;" not in injected
    assert "return `[${body.constructor.name} ${body.byteLength} bytes]`;" not in injected
    assert "return `[${xhr.responseType} response body unavailable]`;" not in injected

    content_script = (ROOT / "src/content-script.js").read_text(encoding="utf-8")
    assert "window.__REQUEST_LENS_BRIDGE_READY__" in content_script
    assert "type: \"settings\"" in content_script
    assert "injectMainWorld" in content_script
    assert 'type: "capture" && enabled' not in content_script

    dashboard_css = (ROOT / "src/dashboard.css").read_text(encoding="utf-8")
    assert "[hidden]" in dashboard_css
    assert "display: none !important" in dashboard_css

    dashboard_js = (ROOT / "src/dashboard.js").read_text(encoding="utf-8")
    assert "serializeForExport(state.filtered.length ? state.filtered : state.captures)" not in dashboard_js
    assert "serializeForExport(state.filtered)" in dashboard_js
    assert "setCaptureSettings" in dashboard_js
    assert "includeRegex" in dashboard_js

    background = (ROOT / "src/background.js").read_text(encoding="utf-8")
    assert "injectIntoOpenTabs" in background
    assert "injectMainWorld" in background
    assert 'world: "MAIN"' in background
    assert "setCaptureSettings" in background
    assert "matchesCaptureSettings" in background

    assert_selectors_exist(ROOT / "src/dashboard.js", ROOT / "src/dashboard.html")
    assert_selectors_exist(ROOT / "src/popup.js", ROOT / "src/popup.html")

    print("smoke check ok")


def assert_selectors_exist(js_path: Path, html_path: Path) -> None:
    js = js_path.read_text(encoding="utf-8")
    html = html_path.read_text(encoding="utf-8")
    ids = set(re.findall(r'id="([^"]+)"', html))
    missing = sorted(selector for selector in ID_SELECTOR_PATTERN.findall(js) if selector not in ids)
    assert not missing, f"{js_path.name} references missing HTML ids: {missing}"


if __name__ == "__main__":
    main()
