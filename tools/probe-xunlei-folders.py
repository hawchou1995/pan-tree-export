"""点进分享里的子目录，看站点自己发哪个请求 —— 子目录列表接口只能这样定格。

用法:
    python tools/probe-xunlei-folders.py <share_url> [out.json]
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "docs" / "evidence" / "xunlei-folder-nav.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def main() -> int:
    share_url = sys.argv[1]
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)

    log = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(user_agent=UA, locale="zh-CN")

        def on_request(req):
            if "api-pan.xunlei.com" in req.url and "/drive/" in req.url:
                log.append({"t": "req", "method": req.method, "url": req.url,
                            "headers": {k: v for k, v in req.headers.items()
                                        if k.startswith("x-")}})

        def on_response(resp):
            if "api-pan.xunlei.com" in resp.url and "/drive/" in resp.url:
                try:
                    body = resp.text()[:2500]
                except Exception as exc:  # noqa: BLE001
                    body = "<unreadable %s>" % exc
                log.append({"t": "res", "status": resp.status, "url": resp.url, "body": body})

        ctx.on("request", on_request)
        ctx.on("response", on_response)
        page = ctx.new_page()
        page.goto("https://pan.xunlei.com/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        mark = len(log)
        page.goto(share_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        root_calls = log[mark:]

        # 找根目录里第一个文件夹的名字，然后点它
        names = []
        for rec in root_calls:
            if rec["t"] != "res" or rec["status"] != 200:
                continue
            try:
                j = json.loads(rec["body"])
            except Exception:
                continue
            for f in (j.get("files") or []):
                if "folder" in str(f.get("kind", "")):
                    names.append(f.get("name"))
        clicked = None
        for nm in names:
            try:
                loc = page.get_by_text(nm, exact=True).first
                loc.click(timeout=8000)
                clicked = nm
                page.wait_for_timeout(7000)
                break
            except Exception:  # noqa: BLE001
                continue

        out.write_text(json.dumps({
            "share_url": share_url, "folder_names": names, "clicked": clicked,
            "root_calls": root_calls, "after_click_calls": log[len(log) - (len(log) - mark - len(root_calls)):],
            "all": log,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print("clicked:", clicked)
        print("--- requests after click ---")
        for rec in log[mark + len(root_calls):]:
            if rec["t"] == "req":
                print("REQ", rec["method"], rec["url"][:220])
        browser.close()
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
