"""百度网盘回归：同一条真实分享链接，底稿 v2.1 与产物 v3.0.0 各跑一遍，比目录树。

    python tools/e2e-baidu-regression.py [share_url]

页面里没有油猴引擎，所以先垫一个 GM_xmlhttpRequest（用 fetch 实现）再注入脚本 ——
两台脚本面对的是**同一套垫片、同一条链接**，所以输出差异只可能来自脚本本身。
产物落 docs/evidence/e2e-baidu-regression.json。
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EVID = ROOT / "docs" / "evidence"
NEW_SRC = ROOT / "pan-tree-export.user.js"
OLD_SRC = ROOT / "baseline" / "562519-v2.1.0-online.user.js"
DEFAULT_URL = "https://pan.baidu.com/s/1B7SoVlVo8gmWa0qcqwCMmA?pwd=1234"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

SHIM = """() => {
  window.unsafeWindow = window;
  window.GM_registerMenuCommand = function () {};
  window.GM_xmlhttpRequest = function (opt) {
    opt = opt || {};
    var init = { method: opt.method || 'GET', headers: opt.headers || {}, credentials: 'include' };
    if (opt.data) init.body = opt.data;
    fetch(opt.url, init).then(function (res) {
      return res.text().then(function (t) {
        if (opt.onload) opt.onload({ status: res.status, responseText: t });
      });
    }).catch(function (e) { if (opt.onerror) opt.onerror({ message: String(e) }); });
  };
}"""

WALK = """async (maxDepth) => {
  const T = window.__T;
  if (!T) return { error: '脚本没跑到' };
  let root;
  try {
    root = await T.buildTree(null, 1, maxDepth);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  const strip = (nodes) => nodes.map((n) => {
    const o = { t: n.isDir ? 'd' : 'f', n: n.name, s: n.size || 0 };
    if (n.children) o.c = strip(n.children);
    return o;
  });
  const t = strip(root.children || []);
  const s = JSON.stringify(t);
  return {
    json: s,
    files: (s.match(/"t":"f"/g) || []).length,
    dirs: (s.match(/"t":"d"/g) || []).length,
  };
}"""


def hook(src_path: Path, var: str) -> str:
    src = src_path.read_text(encoding="utf-8")
    tail = "})();"
    if not src.rstrip().endswith(tail):
        raise SystemExit("%s 结构变了，找不到收尾标记" % src_path.name)
    return src.rstrip()[: -len(tail)] + "\n    window.%s = { buildTree };\n})();" % var


def run(page, script, var, depth):
    page.evaluate(SHIM)
    page.add_script_tag(content=script)
    page.wait_for_timeout(1200)
    page.evaluate("(v) => { window.__T = window[v]; }", var)
    return page.evaluate(WALK, depth)


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    depth = 2
    EVID.mkdir(parents=True, exist_ok=True)
    new_js, old_js = hook(NEW_SRC, "__NEW"), hook(OLD_SRC, "__OLD")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(user_agent=UA, locale="zh-CN")
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="commit", timeout=60000)
        except Exception as exc:  # noqa: BLE001
            print("打开页面失败：", exc)
            return 1
        page.wait_for_timeout(12000)
        new = run(page, new_js, "__NEW", depth)
        old = run(page, old_js, "__OLD", depth)
        browser.close()

    same = bool(new.get("json")) and new.get("json") == old.get("json")
    report = {
        "url": url, "depth": depth, "checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "v3": {k: v for k, v in new.items() if k != "json"},
        "v2_1": {k: v for k, v in old.items() if k != "json"},
        "identical": same,
        "v3_first600": (new.get("json") or "")[:600],
        "v21_first600": (old.get("json") or "")[:600],
    }
    (EVID / "e2e-baidu-regression.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("v3.0.0 :", report["v3"])
    print("v2.1   :", report["v2_1"])
    print("目录树完全一致:", "YES" if same else "NO")
    print("证据:", EVID / "e2e-baidu-regression.json")
    return 0 if same else 1


if __name__ == "__main__":
    raise SystemExit(main())
