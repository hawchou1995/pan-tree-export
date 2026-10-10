"""面板体检：四个平台各开一次对话框，量控件计算样式 + 真点一下看能不能切，并出图。

    python tools/panel-audit.py            # 四个平台全跑
    python tools/panel-audit.py xunlei     # 只跑一个

产物：docs/evidence/panel-audit-<platform>.json + panel-<platform>.png + panel-audit-summary.json

判据（任一不满足即为缺陷）——注意：只看 display/visibility 是不够的，
宿主页把 checkbox 的 appearance 抹成 none 时它仍然"可见"，但用户看到一个空框、以为不可选：
  1. 五个复选框 appearance 必须是 auto（原生绘制），尺寸落在 13–20px
  2. 勾选框点击后 checked 必须真的翻转，且命中点就是它自己
  3. 深度输入框高 28–42px、按钮高 28–42px、面板字号 12–17px
  4. 跨平台一致性：四个平台的面板字号 / 勾选框尺寸 / 按钮高度必须完全一致
"""
import json
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

CHECKBOXES = ['#optTree', '#optIcons', '#optSize', '#optHeader', '#optStats']

PROBE = """(boxes) => {
  const d = document.querySelector('#baiduExportDialog');
  if (!d) return { found: false };
  const out = { found: true, controls: [], probe: {} };
  const sels = boxes.concat(['#depthInput', '#cancelBtn', '#confirmBtn']);
  for (const s of sels) {
    const el = d.querySelector(s);
    if (!el) { out.controls.push({ sel: s, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.controls.push({
      sel: s, tag: el.tagName, type: el.type || '',
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      appearance: cs.appearance, webkitAppearance: cs.webkitAppearance,
      pointerEvents: cs.pointerEvents,
      w: Math.round(r.width), h: Math.round(r.height),
      fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      borderW: cs.borderTopWidth, background: cs.backgroundColor,
      visible: cs.display !== 'none' && cs.visibility === 'visible' && Number(cs.opacity) > 0
             && r.width > 0 && r.height > 0
    });
  }
  const cb = d.querySelector('#optTree');
  if (cb) {
    const before = cb.checked;
    cb.click();
    out.probe.toggleBefore = before;
    out.probe.toggleAfter = cb.checked;
    out.probe.toggleWorks = cb.checked !== before;
    const r2 = cb.getBoundingClientRect();
    const mid = document.elementFromPoint(r2.x + r2.width / 2, r2.y + r2.height / 2);
    out.probe.hitAtCheckboxCentre = mid ? (mid.id || mid.tagName) : null;
    out.probe.hitIsCheckbox = !!mid && mid.id === 'optTree';
  }
  const ds = getComputedStyle(d);
  const dr = d.getBoundingClientRect();
  out.dialog = {
    fontFamily: ds.fontFamily.slice(0, 60), fontSize: ds.fontSize,
    background: ds.backgroundColor, color: ds.color,
    w: Math.round(dr.width), h: Math.round(dr.height)
  };
  // 面板里那段 <style> 有没有被 CSP 拦掉：看 checkbox 的 appearance 是不是我们的规则生效
  out.styleTagApplied = !!d.querySelector('style');
  return out;
}"""


def between(v, lo, hi):
    return isinstance(v, (int, float)) and lo <= v <= hi


def find(rec, sel, key):
    for c in rec.get("controls", []):
        if c.get("sel") == sel:
            return c.get(key)
    return None


def judge(rec):
    bad = []
    for s in CHECKBOXES:
        c = next((x for x in rec.get("controls", []) if x.get("sel") == s), None)
        if c is None or c.get("missing"):
            bad.append(s + " 不存在")
            continue
        if not c.get("visible"):
            bad.append("%s 不可见(display=%s vis=%s opacity=%s %sx%s)" % (
                s, c["display"], c["visibility"], c["opacity"], c["w"], c["h"]))
        if c.get("appearance") == "none" or c.get("webkitAppearance") == "none":
            bad.append("%s 原生外观被宿主页抹掉（appearance=none → 用户看到空框）" % s)
        if not between(c.get("w"), 13, 20) or not between(c.get("h"), 13, 20):
            bad.append("%s 尺寸异常 %sx%s（应 13–20）" % (s, c["w"], c["h"]))
    if rec.get("probe"):
        if rec["probe"].get("toggleWorks") is False:
            bad.append("勾选框点了不切换")
        if rec["probe"].get("hitIsCheckbox") is False:
            bad.append("勾选框中心命中的是 %s（被别的元素盖住）" % rec["probe"].get("hitAtCheckboxCentre"))
    inp = next((x for x in rec.get("controls", []) if x.get("sel") == "#depthInput"), None)
    if inp and not between(inp.get("h"), 28, 42):
        bad.append("深度输入框高 %s（应 28–42）" % inp.get("h"))
    for b in ("#cancelBtn", "#confirmBtn"):
        c = next((x for x in rec.get("controls", []) if x.get("sel") == b), None)
        if c and not between(c.get("h"), 28, 42):
            bad.append("%s 高 %s（应 28–42）" % (b, c.get("h")))
    fs = rec.get("dialog", {}).get("fontSize")
    if fs and not between(float(str(fs).replace("px", "")), 12, 17):
        bad.append("面板字号 %s（应 12–17，被宿主页放大）" % fs)
    return bad


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    cases = {k: v for k, v in CASES.items() if (only is None or k == only)}
    EVID.mkdir(parents=True, exist_ok=True)

    src = SRC.read_text(encoding="utf-8")
    tail = "})();"
    if not src.rstrip().endswith(tail):
        raise SystemExit("产物结构变了，找不到收尾标记")
    patched = src.rstrip()[: -len(tail)] + HOOK

    summary = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for pid, url in cases.items():
            ctx = browser.new_context(user_agent=UA, locale="zh-CN", viewport={"width": 1280, "height": 900})
            page = ctx.new_page()
            rec = {"platform": pid, "url": url}
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(8000)
                page.evaluate("""() => {
                    window.unsafeWindow = window;
                    window.GM_registerMenuCommand = function () {};
                    window.GM_xmlhttpRequest = function () {};
                }""")
                page.add_script_tag(content=patched)
                page.wait_for_timeout(1200)
                page.evaluate("() => window.__T.createDialog()")
                page.wait_for_timeout(700)
                rec.update(page.evaluate(PROBE, CHECKBOXES))
                page.locator("#baiduExportDialog").screenshot(path=str(EVID / ("panel-%s.png" % pid)))
            except Exception as exc:  # noqa: BLE001
                rec["error"] = "%s: %s" % (type(exc).__name__, exc)
            rec["defects"] = judge(rec)
            summary[pid] = rec
            print("[%s] found=%s 缺陷=%s" % (pid, rec.get("found"), rec["defects"] if rec["defects"] else "无"))
            for c in rec.get("controls", []):
                if not c.get("missing"):
                    print("    %-12s %-8s %sx%s app=%-6s webkit=%-12s font=%-6s border=%s" % (
                        c["sel"], c["type"], c["w"], c["h"], c["appearance"],
                        c["webkitAppearance"], c["fontSize"], c["borderW"]))
            if rec.get("probe"):
                print("    点击翻转=%s 命中=%s 命中即勾选框=%s" % (
                    rec["probe"].get("toggleWorks"), rec["probe"].get("hitAtCheckboxCentre"),
                    rec["probe"].get("hitIsCheckbox")))
            if rec.get("dialog"):
                print("    面板: %s %s  %sx%s" % (
                    rec["dialog"]["fontFamily"], rec["dialog"]["fontSize"],
                    rec["dialog"]["w"], rec["dialog"]["h"]))
            (EVID / ("panel-audit-%s.json" % pid)).write_text(
                json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
            ctx.close()
        browser.close()

    fonts = sorted({r["dialog"]["fontSize"] for r in summary.values() if r.get("dialog")})
    boxes = sorted({(find(r, "#optTree", "w"), find(r, "#optTree", "h")) for r in summary.values()})
    btns = sorted({find(r, "#confirmBtn", "h") for r in summary.values() if find(r, "#confirmBtn", "h")})
    cbfonts = sorted({find(r, "#optTree", "fontSize") for r in summary.values()})
    inpapp = sorted({str(find(r, "#depthInput", "appearance")) for r in summary.values()})
    widths = sorted({r["dialog"]["w"] for r in summary.values() if r.get("dialog")})
    uni = {"dialogFontSizes": fonts, "checkboxSizes": boxes, "confirmBtnHeights": btns,
           "dialogWidths": widths, "checkboxFontSizes": cbfonts, "depthInputAppearance": inpapp}
    uni_bad = []
    if len(fonts) > 1:
        uni_bad.append("面板字号跨平台不一致: %s" % fonts)
    if len(boxes) > 1:
        uni_bad.append("勾选框尺寸跨平台不一致: %s" % boxes)
    if len(btns) > 1:
        uni_bad.append("按钮高度跨平台不一致: %s" % btns)
    if len(widths) > 1:
        uni_bad.append("面板宽度跨平台不一致: %s" % widths)
    if len(cbfonts) > 1:
        uni_bad.append("勾选框继承字号跨平台不一致: %s" % cbfonts)
    if len(inpapp) > 1:
        uni_bad.append("深度输入框 appearance 跨平台不一致: %s" % inpapp)
    print("\n跨平台一致性: %s" % ("OK（%s）" % uni if not uni_bad else uni_bad))

    (EVID / "panel-audit-summary.json").write_text(
        json.dumps({"platforms": summary, "uniformity": uni, "uniformityDefects": uni_bad},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(len(v.get("defects", [])) for v in summary.values()) + len(uni_bad)
    print("缺陷合计: %d" % total)
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())
