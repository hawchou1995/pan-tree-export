"""活体验收：把产物脚本注入真实分享页，跑真 buildTree，看能不能把多级目录走下来。

    python tools/e2e-providers.py                 # 跑内置的四条公开分享链接
    python tools/e2e-providers.py xunlei <url>    # 只跑一条

产物落 docs/evidence/e2e-<platform>.json。
只读接口产物，不转存、不下载、不动任何账号数据。
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "pan-tree-export.user.js"
EVID = ROOT / "docs" / "evidence"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

CASES = [
    # 百度网盘另有专项回归（页面里没有油猴引擎，得先垫 GM_xmlhttpRequest）：tools/e2e-baidu-regression.py
    ("quark", "https://pan.quark.cn/s/1ad38e600f1e"),
    ("pan123", "https://www.123pan.com/s/yS8UVv-tqged.html?pwd=6666"),
    ("xunlei", "https://pan.xunlei.com/s/VOMNKH0I4WyxhBUH85Mjx-e5A1?pwd=7kyx"),
]

MAX_DEPTH = 3

HOOK = """
    window.__T = { PROVIDER, PROVIDERS, buildTree, countTotalNodes,
        PROVIDERS_BY_ID: (id) => PROVIDERS.find(function (p) { return p.id === id; }) };
})();"""

JS_WALK = """async (maxDepth) => {
  const T = window.__T;
  if (!T) return { error: 'userscript 没跑到（window.__T 为空）' };
  const p = T.PROVIDER;
  if (!p) return { error: '本页没有匹配的平台', host: location.host, path: location.pathname };
  const t0 = Date.now();
  let root;
  try {
    root = await T.buildTree(null, 1, maxDepth);
  } catch (e) {
    return { platform: p.id, name: p.name, error: String(e && e.message || e) };
  }
  const ms = Date.now() - t0;
  let dirs = 0, files = 0, bytes = 0, maxDepthSeen = 0, nestedDirs = 0;
  const samples = [];
  const walk = (nodes, depth) => {
    maxDepthSeen = Math.max(maxDepthSeen, depth);
    nodes.forEach((n) => {
      if (n.isDir) {
        dirs++;
        if (n.children && n.children.length) nestedDirs++;
        if (samples.length < 6 && n.children && n.children.length) {
          samples.push({ at: depth, dir: n.name, children: n.children.slice(0, 4).map((c) => (c.isDir ? c.name + '/' : c.name)) });
        }
        if (n.children) walk(n.children, depth + 1);
      } else {
        files++;
        bytes += n.size || 0;
      }
    });
  };
  walk(root.children || [], 1);
  return {
    platform: p.id, name: p.name, filePrefix: p.filePrefix,
    host: location.host, path: location.pathname,
    ms, limitDepth: maxDepth,
    nodes: dirs + files, dirs, files, bytes, maxDepthSeen, nestedDirs, samples,
    ok: (dirs + files) > 0,
  };
}"""


def main() -> int:
    args = sys.argv[1:]
    cases = [c for c in CASES if c[0] == args[0]] if args else CASES
    if args and not cases:
        cases = [(args[0], args[1])]
    EVID.mkdir(parents=True, exist_ok=True)

    src = SRC.read_text(encoding="utf-8")
    tail = "})();"
    if not src.rstrip().endswith(tail):
        raise SystemExit("产物结构变了，找不到收尾标记")
    patched = src.rstrip()[: -len(tail)] + HOOK

    report = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for pid, url in cases:
            ctx = browser.new_context(user_agent=UA, locale="zh-CN", viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            rec = {"platform": pid, "url": url}
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(8000)
                page.add_script_tag(content=patched)
                page.wait_for_timeout(1500)
                res = page.evaluate(JS_WALK, MAX_DEPTH)
                rec.update(res if isinstance(res, dict) else {"raw": res})
            except Exception as exc:  # noqa: BLE001
                rec["error"] = "%s: %s" % (type(exc).__name__, exc)
            rec["checked_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            report[pid] = rec
            print("[%s] ok=%s nodes=%s dirs=%s files=%s depth=%s nested=%s %sms %s" % (
                pid, rec.get("ok"), rec.get("nodes"), rec.get("dirs"), rec.get("files"),
                rec.get("maxDepthSeen"), rec.get("nestedDirs"), rec.get("ms"),
                rec.get("error", "")))
            if rec.get("samples"):
                for s in rec["samples"][:3]:
                    print("        lvl%d %s/ -> %s" % (s["at"], s["dir"], " | ".join(s["children"])))
            (EVID / ("e2e-%s.json" % pid)).write_text(
                json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
            ctx.close()
        browser.close()

    (EVID / "e2e-summary.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n证据目录:", EVID)
    bad = [k for k, v in report.items() if not v.get("ok")]
    print("未通过:", bad if bad else "无")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
