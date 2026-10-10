"""把 baseline/562519-v2.1.0-online.user.js 编成 pan-tree-export.user.js。

做法：在底稿上打有锚点的补丁，每条锚点必须命中**恰好 1 次**，否则整体中止、不落盘。
百度网盘那段逻辑除下列 4 处外逐字保留（见 tools/verify-baidu-preserved.mjs 的机械核验）。

    python tools/build.py
"""
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "baseline" / "562519-v2.1.0-online.user.js"
DST = ROOT / "pan-tree-export.user.js"

HEADER = """// ==UserScript==
// @name          网盘目录导出（多图标版+进度）
// @namespace     https://greasyfork.org/zh-CN/users/1465036
// @version       3.0.4
// @description   导出分享页完整树状目录，支持 百度网盘 / 夸克网盘 / 123云盘 / 迅雷云盘，适配文件夹📂、视频📽️、图片🖼️、文档📝、压缩包📦等图标，显示导出进度。百度网盘部分沿用 v2.1 原逻辑。
// @author        intumu.com + AI Fix
// @match         https://pan.baidu.com/s/*
// @match         https://pan.baidu.com/disk/*
// @match         https://yun.baidu.com/s/*
// @match         https://pan.quark.cn/s/*
// @match         *://*.123pan.com/*
// @match         *://*.123pan.cn/*
// @match         *://*.123684.com/*
// @match         *://*.123865.com/*
// @match         *://*.123952.com/*
// @match         *://*.123912.com/*
// @match         https://pan.xunlei.com/s/*
// @grant         unsafeWindow
// @grant         GM_xmlhttpRequest
// @grant         GM_registerMenuCommand
// @connect       pan.baidu.com
// @connect       yun.baidu.com
// @connect       drive-pc.quark.cn
// @connect       www.123pan.com
// @connect       api-pan.xunlei.com
// @run-at        document-end
// @license       MIT
// @homepageURL   https://github.com/hawchou1995/pan-tree-export
// @supportURL    https://qingju.me
// ==/UserScript=="""

PROVIDERS = r"""    // ==================== 平台适配层 ====================
    //
    // 每个平台只交两件事：detect()（本页是不是它的分享页）和 list(handle)（列一层）。
    // list 必须返回 [{ isDir, name, size, handle }]，handle 回传给下一层递归；
    // handle 为 null 表示根目录。目录树、进度、导出、UI 全部共用，不按平台复制。

    // ---------- 百度网盘：原有逻辑，只把「取列表」包一层 ----------
    const BAIDU = {
        id: 'baidu',
        name: '百度网盘',
        filePrefix: 'BaiduPan',
        detect: () => /(^|\.)(pan|yun)\.baidu\.com$/.test(location.hostname),
        list: async (handle) => (await baiduList(handle || '/')).map(extractItemFields)
    };

    // ---------- 夸克网盘：见 README「来源与署名」 ----------
    function quarkShareId() {
        const m = location.pathname.match(/\/s\/([a-zA-Z0-9_-]+)/);
        return m ? m[1] : '';
    }

    // 夸克的取件凭证（stoken）挂在会话上，页面同源 fetch 才带得动
    function quarkStoken() {
        try {
            const args = JSON.parse(sessionStorage.getItem('_share_args') || '{}');
            return (args && args.value && args.value.stoken) || '';
        } catch (e) {
            return '';
        }
    }

    async function quarkList(parentFileId) {
        const pageSize = 100;
        let page = 1;
        const allItems = [];
        while (true) {
            const url = new URL('https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail');
            const params = {
                pr: 'ucpro', fr: 'pc', uc_param_str: '', pwd_id: quarkShareId(),
                stoken: quarkStoken(), pdir_fid: parentFileId, force: 0,
                _page: page, _size: pageSize, _fetch_banner: 0,
                _fetch_share: 0, _fetch_total: 1,
                _sort: 'file_type:asc,updated_at:desc',
                __dt: 959945, __t: Date.now()
            };
            Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
            let json = null;
            try {
                const res = await fetch(url, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json;charset=UTF-8',
                        'x-canary': 'client=web,app=adrive,version=v2.3.1'
                    }
                });
                json = await res.json();
            } catch (e) {
                if (page === 1) throw new Error('夸克网盘列表请求失败：' + (e && e.message ? e.message : e));
                break;
            }
            const items = (json && json.data && json.data.list) || [];
            allItems.push(...items);
            if (items.length < pageSize) break;
            page++;
            await delay(150);
        }
        return allItems.map(quarkNormalize);
    }

    function quarkNormalize(item) {
        return {
            isDir: !!item.dir,
            name: item.file_name || item.name || '未知文件',
            size: Number(item.size) || 0,
            handle: item.fid == null ? '' : String(item.fid)
        };
    }

    const QUARK = {
        id: 'quark',
        name: '夸克网盘',
        filePrefix: 'QuarkPan',
        detect: () => location.hostname === 'pan.quark.cn' && /\/s\//.test(location.pathname),
        list: async (handle) => await quarkList(handle == null ? '0' : handle)
    };

    // ---------- 123 云盘 ----------
    // 分享页 shareKey = 路径最后一段（去 .html、排除路由段）；口令兜底链与站点同口径。
    function pan123ShareKey() {
        const segs = location.pathname.split('/').filter(Boolean);
        let k = segs.length ? segs[segs.length - 1] : '';
        k = String(k).replace(/\.html$/i, '');
        if (k === '123pan' || k === 's' || k === 'mshare' || k === 'share') {
            k = segs.length > 1 ? segs[segs.length - 2] : k;
        }
        return k;
    }

    function pan123Pwd(shareKey) {
        const clean = (v) => String(v == null ? '' : v).replace(/^["']|["']$/g, '').trim();
        try {
            for (const prefix of ['sharePwdd_', 'sharePwd_']) {
                const v = localStorage.getItem(prefix + shareKey) || sessionStorage.getItem(prefix + shareKey);
                if (v) { const t = clean(v); if (t) return t; }
            }
        } catch (e) { }
        try {
            const p = new URLSearchParams(location.search).get('pwd');
            if (p) { const t = clean(p); if (t) return t; }
        } catch (e) { }
        for (const k of ['SharePwd', 'sharePwd', 'share_code', 'pwd']) {
            try {
                const v = localStorage.getItem(k) || sessionStorage.getItem(k);
                if (v) { const t = clean(v); if (t) return t; }
            } catch (e) { }
        }
        return '';
    }

    async function pan123List(parentFileId) {
        const shareKey = pan123ShareKey();
        const out = [];
        let page = 1;
        let total = Infinity;
        // shortcut: 只按 Total + Page 翻页，未见过服务端分页边界（本机样本都 <100 项），
        // 若某天出现漏项，改为按响应里的 Next 游标翻页。
        while (out.length < total && page <= 50) {
            const qs = new URLSearchParams({
                ShareKey: shareKey,
                ParentFileId: String(parentFileId == null ? 0 : parentFileId),
                Limit: '100',
                OrderBy: 'FileName',
                OrderDirection: 'asc',
                Next: '0',
                Page: String(page)
            });
            const pwd = pan123Pwd(shareKey);
            if (pwd) qs.set('SharePwd', pwd);   // 无码分享带空值会被服务端当成错码
            let json = null;
            try {
                const res = await fetch(location.origin + '/api/share/get?' + qs.toString(),
                    { credentials: 'include' });
                json = await res.json();
            } catch (e) {
                if (page === 1) throw new Error('123云盘列表请求失败：' + (e && e.message ? e.message : e));
                break;
            }
            if (!json || Number(json.code) !== 0) {
                if (page === 1) {
                    throw new Error('123云盘 /api/share/get 返回 code=' + (json && json.code) +
                        ' ' + ((json && json.message) || '') +
                        (pan123Pwd(shareKey) ? '' : '（该分享若设了提取码，请用带 ?pwd= 的完整链接打开）'));
                }
                break;
            }
            const d = json.data || {};
            const list = d.InfoList || d.FileList || d.infoList || d.fileList || [];
            total = Number(d.Total || d.total || 0) || total;
            if (!list.length) break;
            out.push(...list);
            page++;
            await delay(150);
        }
        return out.map(pan123Normalize);
    }

    function pan123Normalize(item) {
        return {
            isDir: Number(item.Type) === 1,
            name: item.FileName || item.fileName || '未知文件',
            size: Number(item.Size) || 0,
            handle: item.FileId == null ? '' : String(item.FileId)
        };
    }

    const PAN123 = {
        id: 'pan123',
        name: '123云盘',
        filePrefix: '123Pan',
        // 分享链接会跳到 <uid>.share.123pan.cn 这类镜像域（2026-10-10 实测），
        // 域名表与本机 123pan 脚本的 @match 保持一致
        detect: () => /(^|\.)(123pan\.com|123pan\.cn|123684\.com|123865\.com|123952\.com|123912\.com)$/.test(location.hostname) &&
            /^\/(s|123pan|mshare|share)\//.test(location.pathname),
        list: async (handle) => await pan123List(handle == null ? 0 : handle)
    };

    // ---------- 迅雷云盘 ----------
    const XUNLEI_ORIGIN = 'https://api-pan.xunlei.com/drive/v1';

    // 子目录列表必须带根目录响应给的 pass_code_token（站点自己也把它落成
    // localStorage.xlpan_pass_token）。以本次会话取到的为准，localStorage 只兜底。
    let xunleiPassToken = '';
    function xunleiToken() {
        if (xunleiPassToken) return xunleiPassToken;
        try { return localStorage.getItem('xlpan_pass_token') || ''; } catch (e) { return ''; }
    }

    function xunleiShareId() {
        const m = location.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : '';
    }

    function xunleiPassCode() {
        try {
            const p = new URLSearchParams(location.search).get('pwd');
            if (p) return p;
        } catch (e) { }
        try { return localStorage.getItem('xlpan_pass_code') || ''; } catch (e) { return ''; }
    }

    /**
     * 三个请求头缺一不可（2026-10-10 实测：少任一个都 400）。
     * 三者站点自己都写在 localStorage 里，不必去拦请求：
     *   x-device-id     <- localStorage.deviceid（cookie 同值）
     *   x-client-id     <- captcha_<clientId> / oauth_sign_in_<clientId> 键名的后缀
     *   x-captcha-token <- localStorage['captcha_<clientId>'] JSON 里的 token
     */
    function xunleiHeaders() {
        let deviceId = '';
        try { deviceId = localStorage.getItem('deviceid') || ''; } catch (e) { }
        if (!deviceId) {
            const m = document.cookie.match(/(?:^|;\s*)deviceid=([^;]*)/);
            deviceId = m ? decodeURIComponent(m[1]) : '';
        }
        let clientId = '';
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const m = /^(?:captcha|oauth_sign_in)_(.+)$/.exec(localStorage.key(i) || '');
                if (m && m[1]) { clientId = m[1]; break; }
            }
        } catch (e) { }
        let captcha = '';
        try {
            const raw = localStorage.getItem('captcha_' + clientId);
            if (raw) { const j = JSON.parse(raw); captcha = (j && j.token) || ''; }
        } catch (e) { }
        return { 'x-device-id': deviceId, 'x-client-id': clientId, 'x-captcha-token': captcha };
    }

    async function xunleiGet(path, params) {
        const url = new URL(XUNLEI_ORIGIN + path);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null) url.searchParams.append(k, v);
        });
        const res = await fetch(url.toString(), { headers: xunleiHeaders() });
        const json = await res.json().catch(() => null);
        if (!json) throw new Error('迅雷云盘返回非 JSON（HTTP ' + res.status + '）');
        return json;
    }

    // 根目录走 /share，子目录走 /share/detail?parent_id=（2026-10-10 抓包定格）
    async function xunleiList(parentId) {
        const isRoot = (parentId == null || parentId === '' || String(parentId) === '0');
        const out = [];
        let pageToken = '';
        let passCodeToken = isRoot ? '' : xunleiToken();
        for (let round = 0; round < 50; round++) {
            const params = {
                share_id: xunleiShareId(),
                limit: 100,
                keyword: '',
                page_token: pageToken,
                pass_code_token: passCodeToken,
                scene: 'NORMAL',
                order: 'DEFAULT_ORDER',
                thumbnail_size: 'SIZE_MEDIUM'
            };
            if (isRoot) params.pass_code = xunleiPassCode();
            else params.parent_id = String(parentId);
            const json = await xunleiGet(isRoot ? '/share' : '/share/detail', params);
            if (json.error) {
                throw new Error('迅雷云盘 ' + json.error + '：' + (json.error_description || ''));
            }
            if (json.pass_code_token) {
                passCodeToken = json.pass_code_token;
                if (isRoot) xunleiPassToken = passCodeToken;
            }
            const files = json.files || [];
            out.push(...files);
            pageToken = json.next_page_token || '';
            if (!pageToken) break;
            await delay(150);
        }
        return out.map(xunleiNormalize);
    }

    function xunleiNormalize(item) {
        return {
            isDir: String(item.kind || '').indexOf('folder') !== -1,
            name: item.name || '未知文件',
            size: Number(item.size) || 0,
            handle: item.id == null ? '' : String(item.id)
        };
    }

    const XUNLEI = {
        id: 'xunlei',
        name: '迅雷云盘',
        filePrefix: 'XunleiPan',
        detect: () => location.hostname === 'pan.xunlei.com' && /\/s\//.test(location.pathname),
        list: async (handle) => await xunleiList(handle)
    };

    const PROVIDERS = [BAIDU, QUARK, PAN123, XUNLEI];
    const PROVIDER = PROVIDERS.find((p) => p.detect()) || null;

    // ==================== 统一获取文件列表 ===================="""

COUNTTOTAL = r"""    // 预扫描统计总节点数
    async function countTotalNodes(handle = null, currentDepth = 1, maxDepth = Infinity) {
        if (currentDepth > maxDepth) return 0;

        const list = await PROVIDER.list(handle);
        let count = list.length;

        for (const fields of list) {
            if (fields.isDir && fields.handle) {
                count += await countTotalNodes(fields.handle, currentDepth + 1, maxDepth);
            }
        }

        return count;
    }"""

BUILDTREE = r"""    // 递归构建目录树
    async function buildTree(handle = null, currentDepth = 1, maxDepth = Infinity, onProgress = null) {
        const node = { children: [] };
        if (currentDepth > maxDepth) return node;

        const list = await PROVIDER.list(handle);

        for (const fields of list) {

            if (fields.isDir) {
                // 有的平台不返回目录句柄（例如百度没给 path/fsId），那就只留个空壳，别把整棵树搞崩
                const nextHandle = fields.handle;
                if (!nextHandle) {
                    console.warn(`[buildTree] 文件夹 "${fields.name}" 缺少目录句柄，无法进入子目录`);
                    node.children.push({ name: fields.name, size: 0, isDir: true, children: [] });
                    if (onProgress) onProgress();
                    continue;
                }

                const childNode = await buildTree(nextHandle, currentDepth + 1, maxDepth, onProgress);"""

PATCHES = [
    ("P1 头部", None, "HEADER"),

    ("P2 插入平台适配层",
     "    // ==================== 统一获取文件列表 ====================",
     "PROVIDERS"),

    ("P3 百度取列表改名",
     "    async function getList(path = '/') {",
     "    async function baiduList(path = '/') {"),

    ("P4 百度条目归一出 handle",
     """    function extractItemFields(item) {
        return {
            isDir: (getDataProp(item, 'isdir') === 1 || getDataProp(item, 'isdir') === '1'),
            name: getDataProp(item, 'server_filename', 'filename', 'name') || '未知文件',
            size: Number(getDataProp(item, 'size')) || 0,
            path: getDataProp(item, 'path') || '',
            fsId: getDataProp(item, 'fs_id', 'fsid') || ''
        };
    }""",
     """    function extractItemFields(item) {
        const path = getDataProp(item, 'path') || '';
        const fsId = getDataProp(item, 'fs_id', 'fsid') || '';
        return {
            isDir: (getDataProp(item, 'isdir') === 1 || getDataProp(item, 'isdir') === '1'),
            name: getDataProp(item, 'server_filename', 'filename', 'name') || '未知文件',
            size: Number(getDataProp(item, 'size')) || 0,
            path: path,
            fsId: fsId,
            handle: path || fsId
        };
    }"""),

    ("P5 预扫描改走平台层",
     """    // 预扫描统计总节点数
    async function countTotalNodes(path = '/', currentDepth = 1, maxDepth = Infinity) {
        if (currentDepth > maxDepth) return 0;

        const list = await getList(path);
        let count = list.length;

        for (const item of list) {
            const fields = extractItemFields(item);
            if (fields.isDir && fields.path) {
                count += await countTotalNodes(fields.path, currentDepth + 1, maxDepth);
            }
        }

        return count;
    }""",
     "COUNTTOTAL"),

    ("P6 建树改走平台层",
     """    // 递归构建目录树
    async function buildTree(path = '/', currentDepth = 1, maxDepth = Infinity, onProgress = null) {
        const node = { children: [] };
        if (currentDepth > maxDepth) return node;

        const list = await getList(path);

        for (const item of list) {
            const fields = extractItemFields(item);

            if (fields.isDir) {
                // 如果有 path，用 path 递归；否则尝试用 fsId
                const nextPath = fields.path || fields.fsId;
                if (!nextPath) {
                    // 没有 path 和 fsId，无法递归进入子目录
                    console.warn(`[buildTree] 文件夹 "${fields.name}" 缺少 path/fsId，无法进入子目录`);
                    node.children.push({ name: fields.name, size: 0, isDir: true, children: [] });
                    if (onProgress) onProgress();
                    continue;
                }

                const childNode = await buildTree(nextPath, currentDepth + 1, maxDepth, onProgress);""",
     "BUILDTREE"),

    ("P7 预扫描入口",
     "            const totalNodes = await countTotalNodes('/', 1, maxDepth);",
     "            const totalNodes = await countTotalNodes(null, 1, maxDepth);"),

    ("P8 建树入口",
     "            const treeData = await buildTree('/', 1, maxDepth, updateProgress);",
     "            const treeData = await buildTree(null, 1, maxDepth, updateProgress);"),

    ("P9 头部信息带平台名",
     """                lines.push(`百度网盘目录导出`);
                lines.push(`导出时间: ${new Date().toLocaleString()}`);
                lines.push(`导出层级: ${maxDepth === Infinity ? '全部' : maxDepth}`);
                if (wxlistMetadata) {
                    lines.push(`分享ID: ${wxlistMetadata.shareid || '-'}`);
                }""",
     """                lines.push(`${PROVIDER.name}目录导出`);
                lines.push(`导出时间: ${new Date().toLocaleString()}`);
                lines.push(`导出层级: ${maxDepth === Infinity ? '全部' : maxDepth}`);
                if (PROVIDER.id === 'baidu' && wxlistMetadata) {
                    lines.push(`分享ID: ${wxlistMetadata.shareid || '-'}`);
                }"""),

    ("P10 落盘文件名带平台前缀",
     "            a.download = `BaiduPan_Tree_${new Date().getTime()}.txt`;",
     "            a.download = `${PROVIDER.filePrefix}_Tree_${new Date().getTime()}.txt`;"),

    ("P11 对话框标题与平台行",
     """            <h3 style="margin-top:0">百度网盘目录导出 v2.1</h3>
            <div style="font-size:12px; color:#666; line-height:1.6; margin-bottom:8px;">""",
     """            <h3 style="margin-top:0">${PROVIDER.name}目录导出 v3.0</h3>
            <div style="font-size:12px; color:#1677ff; margin-bottom:6px;">当前平台：${PROVIDER.name}</div>
            <div style="font-size:12px; color:#666; line-height:1.6; margin-bottom:8px;">"""),

    ("P12 悬浮球标题",
     '        btn.title = "导出百度网盘目录树 v2.1";',
     '        btn.title = `导出${PROVIDER.name}目录树 v3.0`;'),

    ("P13 菜单命令文案",
     '            GM_registerMenuCommand("导出百度网盘目录树 v2.1", createDialog);',
     '            GM_registerMenuCommand(`导出${PROVIDER.name}目录树 v3.0`, createDialog);'),

    ("P14 加载日志",
     '    console.log("[百度导出] 脚本已加载 v2.1（修复版）");',
     '    console.log(`[网盘导出] 脚本已加载 v3.0（${PROVIDER ? PROVIDER.name : "本页无匹配平台"}）`);'),

    ("P15 无匹配平台不进 UI",
     """    function addButton() {
        // 检查是否已存在
        if (document.getElementById('baiduExportBtn')) return;""",
     """    function addButton() {
        // 检查是否已存在
        if (document.getElementById('baiduExportBtn')) return;
        if (!PROVIDER) return;"""),

    ("P17 面板样式隔离与统一",
     """            <h3 style="margin-top:0">${PROVIDER.name}目录导出 v3.0</h3>""",
     """            <style>
                /* 样式隔离：宿主页 CSS 会泄漏进注入的 DOM —— 迅雷把 input[type=checkbox] 的 appearance 抹成 none
                   （原生勾选框不再绘制，看起来"不可选"），还把继承字号顶到 24px 把整块面板放大。
                   这里用 #id 作用域 + !important 把面板钉回统一外观；刻意不写 background/border，
                   免得压掉原生勾选框自己的绘制。 */
                #baiduExportDialog, #baiduExportDialog * { box-sizing: border-box; }
                #baiduExportDialog {
                    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif !important;
                    font-size: 14px !important; line-height: 1.5 !important; color: #1f2328 !important;
                    background: #fff !important; width: 360px; max-width: calc(100vw - 24px);
                    letter-spacing: normal !important; text-transform: none !important;
                    text-align: left !important; font-weight: normal !important;
                }
                #baiduExportDialog h3 {
                    margin: 0 0 6px !important; font-size: 16px !important;
                    font-weight: 600 !important; color: #1f2328 !important;
                }
                #baiduExportDialog label {
                    display: flex !important; align-items: center !important; font-size: 14px !important;
                    font-weight: normal !important; color: #1f2328 !important; line-height: 20px !important;
                    margin-bottom: 6px !important; cursor: pointer !important;
                }
                #baiduExportDialog input[type="checkbox"] {
                    -webkit-appearance: checkbox !important; appearance: auto !important;
                    display: inline-block !important; position: static !important;
                    width: 16px !important; height: 16px !important; min-width: 16px !important;
                    margin: 0 8px 0 0 !important; padding: 0 !important; opacity: 1 !important;
                    visibility: visible !important; transform: none !important; accent-color: #1677ff;
                    font-size: inherit !important;
                }
                #baiduExportDialog #depthInput {
                    width: 100% !important; height: 34px !important; padding: 6px 10px !important;
                    -webkit-appearance: auto !important; appearance: auto !important;
                    font-size: 14px !important; line-height: 20px !important; color: #1f2328 !important;
                    background: #fff !important; border: 1px solid #d0d7de !important; border-radius: 6px !important;
                }
                #baiduExportDialog button {
                    -webkit-appearance: none !important; appearance: none !important;
                    height: 34px !important; padding: 0 16px !important; font-size: 14px !important;
                    line-height: 32px !important; font-weight: 500 !important; border-radius: 6px !important;
                    cursor: pointer !important; margin: 0 !important; text-align: center !important;
                }
                #baiduExportDialog #cancelBtn {
                    margin-right: 8px !important; background: #f2f3f5 !important;
                    color: #1f2328 !important; border: 1px solid #d0d7de !important;
                }
                #baiduExportDialog #confirmBtn {
                    background: #1677ff !important; color: #fff !important; border: 1px solid #1677ff !important;
                }
                #baiduExportDialog a { color: #1677ff !important; text-decoration: none !important; }
                #baiduExportDialog a:hover { text-decoration: underline !important; }
            </style>
            <h3 style="margin-top:0">${PROVIDER.name}目录导出 v3.0</h3>"""),

    ("P16 面板页脚加 GitHub 与论坛引流",
     """                <button id="confirmBtn" style="padding:8px 15px; background:#1677ff; color:white; border:none; border-radius:4px; cursor:pointer">导出</button>
            </div>""",
     """                <button id="confirmBtn" style="padding:8px 15px; background:#1677ff; color:white; border:none; border-radius:4px; cursor:pointer">导出</button>
            </div>
            <div style="margin-top:12px; padding-top:10px; border-top:1px solid #eee; text-align:center; font-size:12px; color:#666;">
                开源仓库 <a href="https://github.com/hawchou1995/pan-tree-export" target="_blank" rel="noopener" style="color:#1677ff; text-decoration:none;">GitHub</a>
                &nbsp;·&nbsp;
                交流反馈 <a href="https://qingju.me" target="_blank" rel="noopener" style="color:#1677ff; text-decoration:none;">qingju.me</a>
            </div>"""),
]


def apply(text: str) -> str:
    for name, old, new in PATCHES:
        if old is None:
            start = text.index("// ==UserScript==")
            end = text.index("// ==/UserScript==") + len("// ==/UserScript==")
            text = text[:start] + HEADER + text[end:]
            print("  ok  %-24s (header %d -> %d B)" % (name, end - start, len(HEADER)))
            continue
        body = {"PROVIDERS": PROVIDERS, "COUNTTOTAL": COUNTTOTAL, "BUILDTREE": BUILDTREE}.get(new, new)
        hits = text.count(old)
        if hits != 1:
            raise SystemExit("锚点 %s 命中 %d 次（应为 1），中止不落盘" % (name, hits))
        text = text.replace(old, body, 1)
        print("  ok  %-24s (%d -> %d B)" % (name, len(old), len(body)))
    return text


def main() -> int:
    src = SRC.read_text(encoding="utf-8")
    print("baseline %s  %d B  sha256=%s" % (
        SRC.name, len(src.encode("utf-8")),
        hashlib.sha256(src.encode("utf-8")).hexdigest()[:16]))
    out = apply(src)
    DST.write_text(out, encoding="utf-8", newline="\n")
    data = DST.read_bytes()
    print("built    %s  %d B  sha256=%s" % (DST.name, len(data),
                                            hashlib.sha256(data).hexdigest()[:16]))
    if data.startswith(b"\xef\xbb\xbf"):
        raise SystemExit("产物带 BOM，不合规")
    if b"\r\n" in data:
        raise SystemExit("产物含 CRLF，不合规")
    return 0


if __name__ == "__main__":
    sys.exit(main())
