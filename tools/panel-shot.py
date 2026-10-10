"""面板长什么样，用截图说话：真分享页注入产物 → 打开对话框 → 给对话框本身截图。

    python tools/panel-shot.py [platform] [url]

产物落 docs/evidence/panel-<platform>.png。
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "pan-tree-export.user.js"
EVID = ROOT / "docs" / "evidence"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

CASES = {
    "baidu": "https://pan.baidu.com/s/1B7SoVlVo8gmWa0qcqwCMmA?pwd=1234",
    "quark": "https://pan.quark.cn/s/1ad38e600f1e",
    "pan123": "https://1833371601.share.123pan.cn/123pan/uurhTd-CkYUv?pwd=O3uu",
    "xunlei": "https://pan.xunlei.com/s/VOMNKH0I4WyxhBUH85Mjx-e5A1?pwd=7kyx",
}

HOOK = """
    window.__T = { createDialog, PROVIDER };
})();"""


def main() -> int:
    platform = sys.argv[1] if len(sys.argv) > 1 else "xunlei"
    url = sys.argv[2] if len(sys.argv) > 2 else CASES[platform]
    EVID.mkdir(parents=True, exist_ok=True)

    src = SRC.read_text(encoding="utf-8")
    tail = "})();"
    patches = src.rstrip()[: -len(tail)] + HOOK

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(user_agent=UA, locale="zh-CN", viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(8000)
        page.evaluate("""() => {
            window.unsafeWindow = window;
            window.GM_registerMenuCommand = function () {};
            window.GM_xmlhttpRequest = function () {};
        }""")
        page.add_script_tag(content=patches)
        page.wait_for_timeout(1200)
        info = page.evaluate("() => (window.__T && window.__T.PROVIDER) ? window.__T.PROVIDER.name : null")
        if not info:
            print("本页没有匹配的平台，无法出图")
            return 1
        page.evaluate("() => window.__T.createDialog()")
        page.wait_for_timeout(800)
        out = EVID / ("panel-%s.png" % platform)
        page.locator("#baiduExportDialog").screenshot(path=str(out))
        ok = page.evaluate("""() => {
            const d = document.querySelector('#baiduExportDialog');
            const links = Array.from(d.querySelectorAll('a')).map(a => a.href);
            return { links: links, text: d.innerText.slice(-120) };
        }""")
        browser.close()

    print("平台:", info)
    print("对话框里的链接:", ok["links"])
    print("面板尾部文案:", ok["text"].replace("\n", " | "))
    print("截图:", out)
    return 0 if len(ok["links"]) >= 2 else 1


if __name__ == "__main__":
    raise SystemExit(main())
