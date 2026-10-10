"""机械证明：产物里「没被补丁碰过」的字节与底稿逐字节相同。

做法：拿产物反向套用 build.py 的补丁表（new -> old），再补回底稿的头部，
要求还原结果与 baseline/562519-v2.1.0-online.user.js **逐字节相同**。
不相等就是有人绕过 builder 手改了产物。

    python tools/verify_preserved.py
"""
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import BUILDTREE, COUNTTOTAL, HEADER, PATCHES, PROVIDERS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = (ROOT / "baseline" / "562519-v2.1.0-online.user.js").read_text(encoding="utf-8")
OUT = (ROOT / "pan-tree-export.user.js").read_text(encoding="utf-8")


def base_header() -> str:
    start = BASE.index("// ==UserScript==")
    end = BASE.index("// ==/UserScript==") + len("// ==/UserScript==")
    return BASE[start:end]


def main() -> int:
    text = OUT
    # 头部回到 v2.1 原样
    if HEADER not in text:
        raise SystemExit("产物里找不到本版头部")
    text = text.replace(HEADER, base_header(), 1)

    # 其余补丁逐条反向套用
    for name, old, new in reversed(PATCHES):
        if old is None:
            continue
        body = {"PROVIDERS": PROVIDERS, "COUNTTOTAL": COUNTTOTAL, "BUILDTREE": BUILDTREE}.get(new, new)
        hits = text.count(body)
        if hits != 1:
            raise SystemExit("反向补丁 %s 命中 %d 次（应为 1）" % (name, hits))
        text = text.replace(body, old, 1)

    ok = text == BASE
    print("还原结果 == 底稿 : %s" % ("YES" if ok else "NO"))
    print("  底稿 sha256 %s" % hashlib.sha256(BASE.encode("utf-8")).hexdigest()[:16])
    print("  还原 sha256 %s" % hashlib.sha256(text.encode("utf-8")).hexdigest()[:16])
    if not ok:
        # 指出第一处不同，方便定位
        for i, (a, b) in enumerate(zip(BASE, text)):
            if a != b:
                print("  首个差异 @%d: 底稿 %r / 还原 %r" % (i, BASE[i:i + 60], text[i:i + 60]))
                break
        else:
            print("  长度不同：底稿 %d / 还原 %d" % (len(BASE), len(text)))
        return 1
    print("结论：百度网盘那段逻辑除 15 处补丁锚点外，与线上 v2.1.0 逐字节一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
