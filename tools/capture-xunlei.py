"""定格迅雷云盘分享页的目录接口：真实浏览器抓 XHR + 请求头。

用法:
    python tools/capture-xunlei.py <share_url> [out.json]

抓的是站点自己发的请求（不凭记忆落值），产物落 docs/evidence/xunlei-capture.json。
本宿主 Chrome 旧 headless 会 0xC0000005 崩，改用 playwright 自带 chromium。
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "docs" / "evidence" / "xunlei-capture.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BODY_KEEP = 1200


def is_api(u: str) -> bool:
    return "api-pan.xunlei.com" in u or "api-gateway-pan.xunlei.com" in u


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://pan.xunlei.com/s/VNfakeCaptureProbe0000?pwd=1234"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)

    calls = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
        ctx = browser.new_context(user_agent=UA, locale="zh-CN", viewport={"width": 1440, "height": 900})

        def on_request(req):
            if not is_api(req.url):
                return
            calls.append({
                "phase": "request",
                "method": req.method,
                "url": req.url,
                "headers": dict(req.headers),
                "post_data": req.post_data,
            })

        def on_response(resp):
            if not is_api(resp.url):
                return
            try:
                body = resp.text()[:BODY_KEEP]
            except Exception as exc:  # noqa: BLE001
                body = "<unreadable: %s>" % exc
            calls.append({"phase": "response", "status": resp.status, "url": resp.url, "body": body})

        ctx.on("request", on_request)
        ctx.on("response", on_response)

        page = ctx.new_page()
        page.goto("https://pan.xunlei.com/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)

        storage = page.evaluate("() => ({local:{...localStorage}, session:{...sessionStorage}})")
        title = page.title()
        browser.close()

    out.write_text(json.dumps({
        "probe_url": url,
        "page_title": title,
        "storage_keys": {"local": sorted(storage["local"].keys()), "session": sorted(storage["session"].keys())},
        "calls": calls,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out, "calls=", len(calls))
    for c in calls:
        if c["phase"] == "request":
            print("REQ", c["method"], c["url"][:170])
        else:
            print("RES", c["status"], c["url"][:130])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
