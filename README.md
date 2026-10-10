# 网盘目录导出（多图标版+进度）

导出**分享页**的完整树状目录，一个脚本支持四家网盘：

| 平台 | 分享页 | 目录接口（实测） |
|---|---|---|
| 百度网盘 | `pan.baidu.com/s/*`、`yun.baidu.com/s/*` | `/share/wxlist`（POST，首选）→ 失败降级 `/share/list` |
| 夸克网盘 | `pan.quark.cn/s/*` | `drive-pc.quark.cn/1/clouddrive/share/sharepage/detail` |
| 123 云盘 | `*.123pan.com/s/*`、`*.123pan.cn/123pan/*` 等镜像域 | `/api/share/get` |
| 迅雷云盘 | `pan.xunlei.com/s/*` | `api-pan.xunlei.com/drive/v1/share`（根）＋ `/share/detail`（子目录） |

右上角 📂 悬浮球 → 填目录层级深度（留空=全部）→ 导出 `.txt`：文件夹 `📂`、视频 `📽️`、图片 `🖼️`、
文档 `📝`、压缩包 `📦`、音频 `🎵`，带文件大小、文件夹递归总大小、导出进度百分比。

安装：装到 Tampermonkey / Violentmonkey 后打开分享页即可（123 云盘若设了提取码，用带 `?pwd=` 的完整链接打开）。

---

## 来源与署名

这一版不是从零写的，是把几家现成实现合成一个脚本。**百度网盘那段逻辑逐字节保留**（见下方"怎么证明"），
夸克网盘部分来自作者本人的现成脚本：

| 部分 | 来源 | 许可 |
|---|---|---|
| 百度网盘目录导出（多图标版+进度）v2.1 | greasyfork 脚本 [`562519`](https://greasyfork.org/zh-CN/scripts/562519)，作者 XAUTHUB / intumu.com | MIT |
| 夸克网盘目录导出（夸克在线分享链接文件目录导出）v1.6 | greasyfork 脚本 [`534789`](https://greasyfork.org/zh-CN/scripts/534789)，作者 知识君眼镜哥（XAUTHUB） | MIT |
| 123 云盘分享目录接口口径 | 本机已实测的 [`123pan_unlock`](https://github.com/hawchou1995/123pan_unlock)（greasyfork [598793](https://greasyfork.org/zh-CN/scripts/598793)） | Apache-2.0 |
| 迅雷云盘分享目录接口 | 2026-10-10 在真实分享页抓包定格，原始记录见 `docs/evidence/xunlei-*.json` | — |

夸克部分的功能与文件名解析口径照搬自 534789，仅做了「接入统一取列表层」的封装；原作者署名保留在上表与本仓库提交记录里。

---

## 结构（为什么只有这么点改动）

脚本里多了一层，只加这一层：

```js
// 每个平台只交两件事：detect() 认页，list(handle) 列一层
{ id, name, filePrefix, detect(), list(handle) -> [{ isDir, name, size, handle }] }
```

目录树构建、进度统计、文本渲染、UI 全部四家共用，**不按平台复制**。
百度网盘原有的 `initApi` / `wxlist`⇄`share/list` 双方案降级 / `yunData` 三路获取 / `tplconfig` 签名 /
风控限速全部原样保留，只把「取列表」包了一层壳。

改动集中在 15 个锚点（`tools/build.py` 里逐条列出，每条锚点必须命中恰好 1 次否则整体中止不落盘）。

---

## 怎么证明"百度那段没被动过"

```bash
python tools/verify_preserved.py
# 还原结果 == 底稿 : YES
# 结论：百度网盘那段逻辑除 15 处补丁锚点外，与线上 v2.1.0 逐字节一致。
```

做法：把产物反向套用补丁表（new → old），要求还原结果与 `baseline/562519-v2.1.0-online.user.js`
**逐字节相同**。有人绕过 builder 手改产物，这条就会红。

---

## 验证

```bash
node test/pan-tree-export.test.js        # 88 项，测产物字节本身
python tools/verify_preserved.py         # 百度逻辑逐字节保留
python tools/e2e-providers.py            # 夸克 / 123 / 迅雷 真机（公开分享链接）
python tools/e2e-baidu-regression.py     # 百度：v2.1 与新版同链接跑，目录树逐字节比
```

单测在 vm 里跑**产物原文**（只在末尾把 `})();` 换成导出钩子），覆盖：四平台认页、条目字段归一、
`formatSize`/图标边界、`shareKey`/`shareId`/提取码兜底、迅雷三个必需请求头来源、建树与目录总大小、
`exportText` 全文渲染与落盘文件名、123 与迅雷的载荷与翻页、以及**反向用例**（旧产物字段名不许被别的平台误吃）。

活体结果（2026-10-10，公开分享链接，证据在 `docs/evidence/`）：

| 平台 | 节点 | 目录 | 文件 | 实测最深 | 耗时 |
|---|---|---|---|---|---|
| 夸克网盘 | 138 | 14 | 124 | 3 层 | 2.7 s |
| 123 云盘 | 15 | 8 | 7 | 4 层 | 1.9 s |
| 迅雷云盘 | 1601 | 1050 | 551 | 4 层 | 7.0 s |

百度：v2.1 与 v3.0.0 在同一链接上输出**完全相同**的目录树（`docs/evidence/e2e-baidu-regression.json`）。

---

产物 sha256：`3cf6cd2e6729ae1ef88e791f86b90bb1e06387dac58602bde06b55a43b024a91`（46,772 B，纯 LF，无 BOM）。

## 发布记录

greasyfork：[脚本 562519](https://greasyfork.org/zh-CN/scripts/562519) 已更新到 **3.0.1**（2026-10-10）。
发布后用 `update.greasyfork.org` 把线上文件抓回来核对：**除 Greasy Fork 自己注入的 `@downloadURL` / `@updateURL`
两行外，与本仓库产物逐字节一致**（46,772 B、纯 LF、无替换字符）。

> 为什么是 3.0.1：3.0.0 首次上传时传输管道把一个注释里的「步」字切成了 3 个替换字符
> （分片边界正好落在该字 3 个字节中间），而 Greasy Fork 不接受重复版本号，所以用 3.0.1 修正；
> 功能与 3.0.0 完全相同，只差 `@version` 一行。
> 上面的百度回归 diff 是在 3.0.0 产物上跑的，3.0.1 与之只差 `@version` 字符串。

## 已知边界

- **123 云盘翻页**：按响应里的 `Total` + `Page` 翻页。没遇到过超过一页的分享（样本都 < 100 项），
  若哪天出现漏项，改成按响应里的 `Next` 游标翻。代码里已标 `shortcut:`。
- **迅雷 `page_token` 翻页**：参数与端点已实测定格，但样本的 `next_page_token` 都是空的，
  多页路径没被真实流量验证过。
- **百度在"没有油猴引擎"的页面里**：`e2e-baidu-regression.py` 垫的 `GM_xmlhttpRequest` 用 `fetch` 实现，
  设不了微信 UA（fetch 禁止改 UA 头）。两台脚本面对同一套垫片，所以对比结论仍然有效，
  但这不是"真油猴环境"的端到端。
- 非分享页只挂悬浮球，不发任何请求。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

- 讨论区：<https://qingju.me>
- 仓库：<https://github.com/hawchou1995/pan-tree-export>
