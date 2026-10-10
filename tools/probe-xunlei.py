"""在真实页面上下文里直接打接口，定格迅雷云盘分享的目录接口与必需请求头。

用法:
    python tools/probe-xunlei.py <share_url> [out.json]

为什么在页面里打而不是在 Node 里打：/drive/v1/* 只对 pan.xunlei.com 放行 CORS。
请求头不猜：直接复用站点自己那次 /drive/v1/share 请求的 x-device-id / x-client-id /
x-captcha-token，然后逐个抽掉做对照，确定哪几个是必需的。
"""
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "docs" / "evidence" / "xunlei-probe.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
HDR_WHITELIST = ("x-device-id", "x-client-id", "x-captcha-token")

JS_DUMP = "() => ({local: {...localStorage}, session: {...sessionStorage}})"

JS_FETCH = """async ([url, headers]) => {
  const r = await fetch(url, {headers, credentials: 'include'});
  let body = '';
  try { body = await r.text(); } catch (e) { body = '<unreadable ' + e + '>'; }
  return {status: r.status, body: body.slice(0, 8000)};
}"""


def summarize(raw: str):
    try:
        j = json.loads(raw)
    except Exception:
        return {"parse": "fail", "sample": raw[:160]}
    if not isinstance(j, dict):
        return {"parse": "ok", "type": type(j).__name__}
    files = j.get("files")
    return {
        "keys": sorted(j.keys()),
        "share_status": j.get("share_status"),
        "file_num": j.get("file_num"),
        "next_page_token": j.get("next_page_token", ""),
        "pass_code_token": (j.get("pass_code_token") or "")[:12],
        "n_files": len(files) if isinstance(files, list) else None,
        "entries": [
            {"name": f.get("name"), "id": f.get("id"), "kind": f.get("kind"),
             "size": f.get("size"), "isFolder": "folder" in str(f.get("kind", ""))}
            for f in (files or [])[:12]
        ] if isinstance(files, list) else None,
    }


def main() -> int:
    share_url = sys.argv[1]
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)

    u = urlparse(share_url)
    segs = [s for s in u.path.split("/") if s]
    share_id = segs[-1].replace(".html", "")
    pass_code = parse_qs(u.query).get("pwd", [""])[0]

    report = {"share_url": share_url, "share_id": share_id, "pass_code": pass_code, "variants": []}
    seen_headers = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(user_agent=UA, locale="zh-CN")

        def on_request(req):
            if "api-pan.xunlei.com/drive/v1/share" not in req.url:
                return
            for k in HDR_WHITELIST:
                v = req.headers.get(k)
                if v:
                    seen_headers[k] = v

        ctx.on("request", on_request)
        page = ctx.new_page()
        page.goto("https://pan.xunlei.com/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        page.goto(share_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)

        report["storage_keys"] = page.evaluate(
            "() => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage)})")
        report["page_title"] = page.title()
        report["captured_headers"] = {k: (v[:24] + "…" if len(v) > 24 else v) for k, v in seen_headers.items()}
        report["header_value_lens"] = {k: len(v) for k, v in seen_headers.items()}

        base = ("https://api-pan.xunlei.com/drive/v1/share?share_id=%s&pass_code=%s&limit=100"
                "&keyword=&pass_code_token=&page_token=&scene=NORMAL&order=DEFAULT_ORDER"
                "&thumbnail_size=SIZE_MEDIUM" % (share_id, pass_code))

        def call(label, url, headers):
            res = page.evaluate(JS_FETCH, [url, headers])
            rec = {"label": label, "url": url, "sent_headers": sorted(headers.keys()),
                   "status": res["status"], "summary": summarize(res["body"]),
                   "body_head": res["body"][:300]}
            report["variants"].append(rec)
            print("==", label, "->", res["status"], json.dumps(rec["summary"], ensure_ascii=False)[:700])
            return res["body"]

        full = dict(seen_headers)
        body = call("A_baseline_site_headers", base, full)
        for k in HDR_WHITELIST:
            if k in full:
                call("drop_" + k, base, {kk: vv for kk, vv in full.items() if kk != k})
        call("no_headers_at_all", base, {})

        try:
            j = json.loads(body)
        except Exception:
            j = {}
        files = j.get("files") or []
        npt = j.get("next_page_token") or ""
        if npt:
            call("E_page2", base + "&page_token=" + str(npt), full)
        folders = [f for f in files
                   if isinstance(f, dict) and "folder" in str(f.get("kind", "")) and f.get("id")]
        if folders:
            fid = str(folders[0]["id"])
            report["first_folder_id"] = fid
            for label, extra in (
                ("F_parent_id", "&parent_id=" + fid),
                ("G_folder_id", "&folder_id=" + fid),
                ("H_parent_id_empty", "&parent_id="),
            ):
                call(label, base + extra, full)
        browser.close()

    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
