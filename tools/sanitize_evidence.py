"""公开仓库前给证据脱敏：把迅雷抓包里的会话凭据（设备号 / 客户端号 / 验证码令牌）打码。

    python tools/sanitize_evidence.py

只改 docs/evidence/ 下那三个抓包文件里的 header 值，保留前 6 位与长度，
用于证明"这三个头确实发了"，但不再是一份可复用的凭据。目录树证据不含凭据，不动。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVID = ROOT / "docs" / "evidence"
SECRET_HEADERS = ("x-device-id", "x-client-id", "x-captcha-token")
TARGETS = ("xunlei-capture.json", "xunlei-probe.json", "xunlei-folder-nav.json")
TOKENISH = re.compile(r'(ck0\.)[A-Za-z0-9._~+/=-]{8,}')


def mask(v):
    if not isinstance(v, str) or not v:
        return v
    return v[:6] + "…<%d 字符已打码>" % len(v)


def scrub(node, stats):
    if isinstance(node, dict):
        for k in list(node.keys()):
            v = node[k]
            if isinstance(k, str) and k.lower() in SECRET_HEADERS and isinstance(v, str):
                node[k] = mask(v)
                stats[k] = stats.get(k, 0) + 1
            else:
                scrub(v, stats)
    elif isinstance(node, list):
        for v in node:
            scrub(v, stats)


def main() -> int:
    for name in TARGETS:
        path = EVID / name
        if not path.exists():
            print("跳过（不存在）", name)
            continue
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
        stats = {}
        scrub(data, stats)
        out = json.dumps(data, ensure_ascii=False, indent=2)
        # 兜底：正文里可能直接出现 ck0. 开头的令牌
        out = TOKENISH.sub(lambda m: m.group(1) + "…<已打码>", out)
        path.write_text(out, encoding="utf-8")
        print("%-26s 打码 %s" % (name, stats or "无命中"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
