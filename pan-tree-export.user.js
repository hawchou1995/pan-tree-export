// ==UserScript==
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
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 文件类型图标 ====================

    const FILE_TYPES = {
        video: {
            icon: '📽️',
            exts: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.m4v', '.rmvb']
        },
        image: {
            icon: '🖼️',
            exts: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.heic', '.tiff', '.ico']
        },
        archive: {
            icon: '📦',
            exts: ['.zip', '.rar', '.7z', '.tar', '.gz', '.iso', '.dmg', '.pkg', '.jar']
        },
        doc: {
            icon: '📝',
            exts: ['.doc', '.docx', '.pdf', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.md', '.epub', '.csv', '.json']
        },
        audio: {
            icon: '🎵',
            exts: ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg']
        }
    };

    function getFileIcon(fileName) {
        if (!fileName) return '📄';
        const lowerName = fileName.toLowerCase();
        for (const type in FILE_TYPES) {
            if (FILE_TYPES[type].exts.some(ext => lowerName.endsWith(ext))) {
                return FILE_TYPES[type].icon;
            }
        }
        return '📄';
    }

    // ==================== 工具函数 ====================

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    function formatSize(size) {
        if (size === null || size === undefined || size === '') return '-';
        if (size === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(size) / Math.log(k));
        return (size / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }

    // 安全提取属性（兼容多种命名风格）
    function getDataProp(obj, ...keys) {
        if (!obj) return '';
        for (const key of keys) {
            if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
                return obj[key];
            }
        }
        return '';
    }

    // 从 URL 提取短链接 ID
    function getShortUrl() {
        // 支持 /s/1xxxxxx 格式
        const match = location.pathname.match(/\/s\/([a-zA-Z0-9_-]+)/);
        if (match) return match[1];
        // 支持 /disk/main 等格式下可能没有短链接
        return '';
    }

    // 从 URL 提取提取码
    function getPwd() {
        const params = new URLSearchParams(location.search);
        return params.get('pwd') || '';
    }

    // 从 Cookie 读取指定字段
    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : '';
    }

    // ==================== HTTP 请求封装 ====================

    function gmRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const timeout = options.timeout || 30000;
            GM_xmlhttpRequest({
                method: options.method || "GET",
                url: url,
                headers: options.headers || {},
                data: options.data || null,
                timeout: timeout,
                onload: function(response) {
                    if (response.status === 200) {
                        try {
                            resolve(JSON.parse(response.responseText));
                        } catch(e) {
                            reject("JSON Parse Error: " + e.message);
                        }
                    } else {
                        reject("HTTP " + response.status);
                    }
                },
                onerror: function(err) {
                    reject("Network Error: " + (err.message || err));
                },
                ontimeout: function() {
                    reject("Request Timeout");
                }
            });
        });
    }

    // ==================== 认证参数获取 ====================

    // 策略1：尝试从 unsafeWindow 获取 yunData
    function getYunDataFromWindow() {
        try {
            let data = unsafeWindow.yunData || window.yunData;
            if (data && typeof data === 'object') {
                console.log("[百度导出] 从 window 获取到 yunData");
                return data;
            }
        } catch(e) {
            console.warn("[百度导出] unsafeWindow.yunData 访问失败:", e.message);
        }
        return null;
    }

    // 策略2：从页面 script 标签正则提取
    function getYunDataFromDOM() {
        const scripts = document.querySelectorAll('script');
        for (let script of scripts) {
            const content = script.textContent || "";
            if (!content.includes('yunData')) continue;

            const patterns = [
                /yunData\s*=\s*(\{[\s\S]*?\})\s*;/,
                /window\.yunData\s*=\s*(\{[\s\S]*?\})\s*;/,
                /var\s+yunData\s*=\s*(\{[\s\S]*?\})\s*;/,
                /"yunData"\s*:\s*(\{[\s\S]*?\})\s*,/
            ];
            for (const pattern of patterns) {
                try {
                    const match = content.match(pattern);
                    if (match && match[1]) {
                        const data = JSON.parse(match[1]);
                        console.log("[百度导出] 从 DOM 提取到 yunData");
                        return data;
                    }
                } catch(e) { /* 继续尝试下一个 */ }
            }
        }
        return null;
    }

    // 策略3：从 window.context / locals / shareData 等新变量获取
    function getYunDataFromContext() {
        const candidates = ['context', 'locals', 'shareData', 'pageData'];
        for (const key of candidates) {
            try {
                const obj = unsafeWindow[key] || window[key];
                if (obj && typeof obj === 'object') {
                    // 尝试从 context 中提取分享信息
                    const uk = getDataProp(obj, 'uk', 'SHARE_UK', 'share_uk');
                    const shareid = getDataProp(obj, 'shareid', 'SHARE_ID', 'share_id');
                    if (uk && shareid) {
                        console.log(`[百度导出] 从 ${key} 提取到分享信息`);
                        return obj;
                    }
                }
            } catch(e) {}
        }
        return null;
    }

    // 综合获取 yunData
    function getYunData() {
        return getYunDataFromWindow() || getYunDataFromDOM() || getYunDataFromContext();
    }

    // 从 /share/tplconfig API 获取 sign 和 timestamp
    async function getSignAndTimestamp(shareid, uk) {
        try {
            const surl = getShortUrl();
            const url = `https://pan.baidu.com/share/tplconfig?fields=sign,timestamp&channel=chunlei&web=1&clienttype=0` +
                `&share_id=${shareid}&uk=${uk}&surl=${surl}&app_id=250528`;
            const data = await gmRequest(url, {
                headers: {
                    'Referer': window.location.href,
                    'User-Agent': navigator.userAgent
                }
            });
            if (data && data.errno === 0 && data.data) {
                const sign = getDataProp(data.data, 'sign');
                const timestamp = getDataProp(data.data, 'timestamp');
                console.log(`[百度导出] 获取到 sign=${sign}, timestamp=${timestamp}`);
                return { sign, timestamp };
            }
            console.warn("[百度导出] tplconfig 返回异常:", data);
        } catch(e) {
            console.warn("[百度导出] 获取 sign/timestamp 失败:", e);
        }
        return { sign: '', timestamp: '' };
    }

    // ==================== API 请求逻辑 ====================

    let apiMode = null;          // 'wxlist' | 'sharelist'
    let yunDataCache = null;
    let signTimestampCache = null; // { sign, timestamp }
    let wxlistMetadata = null;    // { uk, shareid, sekey/randsk } 从 wxlist 根目录响应中保存

    async function initApi() {
        if (apiMode) return; // 已初始化

        // 尝试获取 yunData（重试5次）
        for (let i = 0; i < 5; i++) {
            yunDataCache = getYunData();
            if (yunDataCache) break;
            await delay(1000);
        }

        // 优先使用 wxlist（更可靠，不依赖 yunData）
        if (getShortUrl()) {
            apiMode = 'wxlist';
            console.log("[百度导出] 模式：wxlist（优先使用，最可靠）");
            return;
        }

        // 如果没有短链接但 yunData 可用，尝试 share/list
        if (yunDataCache) {
            const uk = getDataProp(yunDataCache, 'uk', 'SHARE_UK');
            const shareid = getDataProp(yunDataCache, 'shareid', 'SHARE_ID');
            if (uk && shareid) {
                // 尝试获取 sign/timestamp
                signTimestampCache = await getSignAndTimestamp(shareid, uk);
                apiMode = 'sharelist';
                console.log("[百度导出] 模式：share/list（yunData 已获取）");
                return;
            }
        }

        console.error("[百度导出] 初始化失败：短链接和 yunData 均不可用");
    }

    // ==================== 方案A：/share/wxlist（POST）— 最可靠 ====================

    const WECHAT_UA = 'Mozilla/5.0 (Linux; Android 7.1.1; MI 6 Build/NMF26X; wv) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 ' +
        'MQQBrowser/6.2 TBS/043807 Mobile Safari/537.36 ' +
        'MicroMessenger/6.6.1.1220(0x26060135) NetType/4G Language/zh_CN';

    async function getListByWxList(path, isRoot) {
        const pageSize = 200; // 使用较小分页避免被风控
        let page = 1;
        let allItems = [];

        const shorturl = getShortUrl();
        const pwd = getPwd();

        while (true) {
            const url = `https://pan.baidu.com/share/wxlist?channel=weixin&version=2.2.2&clienttype=25&web=1&page=${page}&num=${pageSize}&order=time`;

            const formData = new URLSearchParams();
            formData.append('shorturl', shorturl);
            formData.append('root', isRoot ? '1' : '0');
            if (pwd) formData.append('pwd', pwd);
            if (!isRoot && path && path !== '/') {
                formData.append('dir', path);
            }

            try {
                const data = await gmRequest(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': WECHAT_UA,
                        'Referer': 'https://pan.baidu.com/disk/home'
                    },
                    data: formData.toString()
                });

                console.log(`[wxlist] path=${path}, isRoot=${isRoot}, page=${page}, errno=${data.errno}`);

                if (data.errno !== 0) {
                    console.error(`[wxlist] API 错误: errno=${data.errno}, path=${path}`);

                    // errno=-130: 链接失效; errno=9019: 需要验证码; errno=5: 需要提取码但未提供
                    if (data.errno === 5 || data.errno === -130) {
                        console.error(`[wxlist] 提取码或链接问题: errno=${data.errno}`);
                    }
                    break;
                }

                // wxlist 响应格式：根目录有 data.list, 子目录也是 data.list
                // 兼容多种响应格式
                let list = [];
                if (data.data && data.data.list) {
                    list = data.data.list;
                } else if (data.list) {
                    list = data.list;
                } else if (data.data && Array.isArray(data.data)) {
                    list = data.data;
                }

                // 保存根目录的 uk/shareid/seckey（后续可能需要）
                if (isRoot && data.data) {
                    wxlistMetadata = {
                        uk: getDataProp(data.data, 'uk'),
                        shareid: getDataProp(data.data, 'shareid'),
                        seckey: getDataProp(data.data, 'seckey', 'randsk')
                    };
                    console.log(`[wxlist] 保存元数据: uk=${wxlistMetadata.uk}, shareid=${wxlistMetadata.shareid}`);
                }

                console.log(`[wxlist] 获取 ${list.length} 个项目`);
                allItems.push(...list);

                if (list.length < pageSize) break;
                page++;
                await delay(500); // 防风控限速

            } catch (error) {
                console.error("[wxlist] 请求失败:", error);
                break;
            }
        }
        return allItems;
    }

    // ==================== 方案B：/share/list（GET）— 依赖 yunData ====================

    async function getListByShareList(path) {
        const pageSize = 200;
        let page = 1;
        let allItems = [];

        const uk = getDataProp(yunDataCache, 'uk', 'SHARE_UK');
        const shareid = getDataProp(yunDataCache, 'shareid', 'SHARE_ID');
        const bdstoken = getDataProp(yunDataCache, 'bdstoken', 'BDSTOKEN') || getCookie('BDSTOKEN') || '';

        // 如果 yunData 中没有 sign/timestamp，尝试从 tplconfig 获取
        let sign = getDataProp(yunDataCache, 'SIGN', 'sign');
        let timestamp = getDataProp(yunDataCache, 'TIMESTAMP', 'timestamp');

        if (!sign || !timestamp) {
            if (!signTimestampCache) {
                signTimestampCache = await getSignAndTimestamp(shareid, uk);
            }
            sign = signTimestampCache.sign || sign;
            timestamp = signTimestampCache.timestamp || timestamp;
        }

        while (true) {
            const url = new URL('https://pan.baidu.com/share/list');
            const params = {
                uk, shareid,
                order: 'other', desc: '1', showempty: '0', web: '1',
                page, num: pageSize, dir: path,
                t: Math.random(), bdstoken,
                channel: 'chunlei', clienttype: '0', app_id: '250528'
            };
            // 新版 API 需要 sign + timestamp
            if (sign && timestamp) {
                params.sign = sign;
                params.timestamp = timestamp;
            }

            Object.entries(params).forEach(([k, v]) => {
                if (v !== undefined && v !== null && v !== '') url.searchParams.append(k, v);
            });

            try {
                const data = await gmRequest(url.toString(), {
                    headers: {
                        'Referer': window.location.href,
                        'User-Agent': navigator.userAgent
                    }
                });

                console.log(`[share/list] path=${path}, page=${page}, errno=${data.errno}`);

                if (data.errno !== 0) {
                    console.error(`[share/list] errno=${data.errno}, path=${path}`);

                    // 如果 share/list 失败，自动降级到 wxlist
                    if (data.errno === -2 && allItems.length === 0) {
                        console.warn("[百度导出] share/list 失败，尝试降级到 wxlist...");
                        apiMode = 'wxlist';
                        return await getListByWxList(path, (path === '/' || path === ''));
                    }
                    break;
                }

                const list = data.list || [];
                allItems.push(...list);

                console.log(`[share/list] 获取 ${list.length} 个项目`);
                if (list.length < pageSize) break;
                page++;
                await delay(500);

            } catch (error) {
                console.error("[share/list] 请求失败:", error);
                break;
            }
        }
        return allItems;
    }

    // ==================== 平台适配层 ====================
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

    // ==================== 统一获取文件列表 ====================

    async function baiduList(path = '/') {
        await initApi();

        if (apiMode === 'wxlist') {
            const isRoot = (path === '/' || path === '' || !path);
            const items = await getListByWxList(path || '/', isRoot);
            // 如果 wxlist 也返回空，尝试降级到 share/list
            if (items.length === 0 && yunDataCache && apiMode === 'wxlist') {
                console.warn("[百度导出] wxlist 返回空，尝试降级到 share/list...");
                const shareItems = await getListByShareList(path);
                if (shareItems.length > 0) {
                    apiMode = 'sharelist';
                    return shareItems;
                }
            }
            return items;
        }

        if (apiMode === 'sharelist') {
            return await getListByShareList(path);
        }

        console.error("[百度导出] API 未初始化");
        return [];
    }

    // ==================== 文件项字段兼容提取 ====================

    // 百度网盘 API 响应中文件项可能有不同的字段名：
    // - share/list: isdir, server_filename, size, path, fs_id
    // - wxlist:    isdir, server_filename, size, path, fsid (可能用不同名)
    // 兼容提取所有可能的字段名

    function extractItemFields(item) {
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
    }

    // ==================== 目录树构建 ====================

    // 预扫描统计总节点数
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
    }

    // 递归构建目录树
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

                const childNode = await buildTree(nextHandle, currentDepth + 1, maxDepth, onProgress);
                childNode.name = fields.name;
                childNode.isDir = true;
                childNode.size = fields.size;
                // 计算文件夹总大小（递归求和子节点）
                childNode.totalSize = calcTotalSize(childNode);
                node.children.push(childNode);

                if (onProgress) onProgress();
            } else {
                node.children.push({ name: fields.name, size: fields.size, isDir: false });

                if (onProgress) onProgress();
            }
        }

        // 排序：文件夹在前，文件在后，按名称排序
        node.children.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            const nameA = a.name || "";
            const nameB = b.name || "";
            return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        });

        return node;
    }

    // 计算文件夹总大小（递归求和所有子文件的大小）
    function calcTotalSize(node) {
        if (!node.children || node.children.length === 0) return node.size || 0;
        let total = 0;
        for (const child of node.children) {
            if (child.isDir) {
                total += calcTotalSize(child);
            } else {
                total += (child.size || 0);
            }
        }
        return total;
    }

    // ==================== 导出文本 ====================

    async function exportText(maxDepth, dialogElement, options = {}) {
        // 默认配置：只导出目录树，不含头部和统计
        const opt = Object.assign({
            includeTree: true,
            includeIcons: true,
            includeSize: true,
            includeHeader: false,
            includeStats: false
        }, options);

        try {
            const confirmBtn = document.getElementById('confirmBtn');
            if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.innerText = "导出中...";
            }

            let pTip = document.getElementById('exportProgressTip');
            if (!pTip) {
                pTip = document.createElement('p');
                pTip.id = 'exportProgressTip';
                pTip.style.cssText = "font-size:12px; color:#1677ff; margin-top:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
                dialogElement.appendChild(pTip);
            }

            // 第一步：预扫描统计总节点数
            pTip.innerText = "正在统计文件总数...";
            const totalNodes = await countTotalNodes(null, 1, maxDepth);
            console.log("[百度导出] 总节点数:", totalNodes);

            if (totalNodes === 0) {
                pTip.innerText = "未获取到任何文件。可能原因：1)未输入提取码 2)链接已失效 3)页面未完全加载。请按F12查看控制台日志。";
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.innerText = "导出";
                }
                return;
            }

            // 第二步：实际构建目录树
            let processedNodes = 0;
            const updateProgress = () => {
                processedNodes++;
                if (totalNodes > 0) {
                    const percent = Math.min(100, Math.floor((processedNodes / totalNodes) * 100));
                    pTip.innerText = `正在导出... ${percent}% (${processedNodes}/${totalNodes})`;
                }
            };

            const treeData = await buildTree(null, 1, maxDepth, updateProgress);
            const lines = [];

            // 头部信息（根据配置决定是否包含）
            if (opt.includeHeader) {
                lines.push(`${PROVIDER.name}目录导出`);
                lines.push(`导出时间: ${new Date().toLocaleString()}`);
                lines.push(`导出层级: ${maxDepth === Infinity ? '全部' : maxDepth}`);
                if (PROVIDER.id === 'baidu' && wxlistMetadata) {
                    lines.push(`分享ID: ${wxlistMetadata.shareid || '-'}`);
                }
                lines.push('----------------------------------------');
            }

            // 目录树结构（根据配置决定是否包含）
            if (opt.includeTree) {
                const traverse = (nodes, level = 0) => {
                    const indent = '    '.repeat(level);
                    nodes.forEach((node) => {
                        const name = node.name;
                        if (node.isDir) {
                            // 文件夹：图标根据配置，大小根据配置
                            const folderIcon = opt.includeIcons ? '📂 ' : '';
                            const totalSize = node.totalSize || calcTotalSize(node);
                            const sizeStr = (opt.includeSize && totalSize > 0) ? ` (${formatSize(totalSize)})` : '';
                            lines.push(`${indent}${folderIcon}${name}/${sizeStr}`);
                            if (node.children) traverse(node.children, level + 1);
                        } else {
                            // 文件：图标根据配置，大小根据配置
                            const icon = opt.includeIcons ? getFileIcon(name) + ' ' : '';
                            const sizeStr = (opt.includeSize && node.size > 0) ? ` (${formatSize(node.size)})` : '';
                            lines.push(`${indent}${icon}${name}${sizeStr}`);
                        }
                    });
                };

                if (treeData.children) {
                    traverse(treeData.children, 0);
                }
            }

            // 统计信息（根据配置决定是否包含）
            if (opt.includeStats) {
                let fileCount = 0, dirCount = 0, totalSize = 0;
                const countNodes = (nodes) => {
                    nodes.forEach(n => {
                        if (n.isDir) { dirCount++; if (n.children) countNodes(n.children); }
                        else { fileCount++; totalSize += (n.size || 0); }
                    });
                };
                countNodes(treeData.children || []);

                lines.push('----------------------------------------');
                lines.push(`统计: ${dirCount} 个文件夹, ${fileCount} 个文件, 总大小 ${formatSize(totalSize)}`);
            }

            const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${PROVIDER.filePrefix}_Tree_${new Date().getTime()}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

        } catch (error) {
            console.error("[百度导出] 导出失败:", error);
            alert('导出失败，请按F12查看控制台日志获取详细错误信息。');
        } finally {
            if (dialogElement && dialogElement.parentNode) {
                dialogElement.parentNode.removeChild(dialogElement);
            }
        }
    }

    // ==================== UI 对话框 ====================

    function createDialog() {
        if (document.getElementById('baiduExportDialog')) return;

        const dialog = document.createElement('div');
        dialog.id = 'baiduExportDialog';
        dialog.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); z-index: 9999; min-width: 360px; font-family: sans-serif;`;
        dialog.innerHTML = `
            <style>
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
            <h3 style="margin-top:0">${PROVIDER.name}目录导出 v3.0</h3>
            <div style="font-size:12px; color:#1677ff; margin-bottom:6px;">当前平台：${PROVIDER.name}</div>
            <div style="font-size:12px; color:#666; line-height:1.6; margin-bottom:8px;">
                📂 文件夹 &nbsp; 📽️ 视频 &nbsp; 🖼️ 图片<br>
                📝 文档 &nbsp;&nbsp; 📦 压缩包 &nbsp; 🎵 音频
            </div>

            <div style="border-top:1px solid #eee; margin:10px 0; padding-top:10px;">
                <div style="font-size:13px; font-weight:bold; margin-bottom:8px;">📋 导出内容配置</div>
                <label style="font-size:13px; display:flex; align-items:center; margin-bottom:6px; cursor:pointer;">
                    <input type="checkbox" id="optTree" checked style="margin-right:8px; width:16px; height:16px;">
                    目录树结构
                </label>
                <label style="font-size:13px; display:flex; align-items:center; margin-bottom:6px; cursor:pointer;">
                    <input type="checkbox" id="optIcons" checked style="margin-right:8px; width:16px; height:16px;">
                    文件类型图标
                </label>
                <label style="font-size:13px; display:flex; align-items:center; margin-bottom:6px; cursor:pointer;">
                    <input type="checkbox" id="optSize" checked style="margin-right:8px; width:16px; height:16px;">
                    文件大小
                </label>
                <label style="font-size:13px; display:flex; align-items:center; margin-bottom:6px; cursor:pointer;">
                    <input type="checkbox" id="optHeader" style="margin-right:8px; width:16px; height:16px;">
                    头部信息（导出时间、层级等）
                </label>
                <label style="font-size:13px; display:flex; align-items:center; margin-bottom:6px; cursor:pointer;">
                    <input type="checkbox" id="optStats" style="margin-right:8px; width:16px; height:16px;">
                    统计信息（文件夹/文件数量、总大小）
                </label>
            </div>

            <label style="font-size:13px; display:block; margin-bottom:5px;">
                目录层级深度（留空=全部层级）:
            </label>
            <input id="depthInput" type="number" placeholder="全部层级请留空" style="width:100%; padding:8px; box-sizing:border-box; border:1px solid #ddd; border-radius:4px">
            <div style="margin-top:15px; text-align:right">
                <button id="cancelBtn" style="padding:8px 15px; border:none; background:#f5f5f5; border-radius:4px; margin-right:10px; cursor:pointer">取消</button>
                <button id="confirmBtn" style="padding:8px 15px; background:#1677ff; color:white; border:none; border-radius:4px; cursor:pointer">导出</button>
            </div>
            <div style="margin-top:12px; padding-top:10px; border-top:1px solid #eee; text-align:center; font-size:12px; color:#666;">
                开源仓库 <a href="https://github.com/hawchou1995/pan-tree-export" target="_blank" rel="noopener" style="color:#1677ff; text-decoration:none;">GitHub</a>
                &nbsp;·&nbsp;
                交流反馈 <a href="https://qingju.me" target="_blank" rel="noopener" style="color:#1677ff; text-decoration:none;">qingju.me</a>
            </div>
        `;
        document.body.appendChild(dialog);

        document.getElementById('cancelBtn').onclick = () => document.body.removeChild(dialog);
        document.getElementById('confirmBtn').onclick = () => {
            const val = document.getElementById('depthInput').value;
            const maxDepth = val ? parseInt(val) : Infinity;
            const options = {
                includeTree: document.getElementById('optTree').checked,
                includeIcons: document.getElementById('optIcons').checked,
                includeSize: document.getElementById('optSize').checked,
                includeHeader: document.getElementById('optHeader').checked,
                includeStats: document.getElementById('optStats').checked
            };
            exportText(maxDepth, dialog, options);
        };
    }

    // ==================== 浮动按钮 ====================

    // 等待页面加载后创建按钮
    function addButton() {
        // 检查是否已存在
        if (document.getElementById('baiduExportBtn')) return;
        if (!PROVIDER) return;

        const btn = document.createElement('div');
        btn.id = 'baiduExportBtn';
        btn.innerHTML = '📂';
        btn.style.cssText = 'position:fixed; top:20px; right:20px; width:50px; height:50px; background:#1677ff; color:white; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:24px; cursor:pointer; z-index:99999; box-shadow:0 2px 10px rgba(0,0,0,0.2); transition:transform 0.2s;';
        btn.title = `导出${PROVIDER.name}目录树 v3.0`;
        btn.onmouseenter = () => btn.style.transform = 'scale(1.1)';
        btn.onmouseleave = () => btn.style.transform = 'scale(1)';
        btn.onclick = createDialog;
        document.body.appendChild(btn);

        // 注册菜单命令（备用）
        if (typeof GM_registerMenuCommand !== 'undefined') {
            GM_registerMenuCommand(`导出${PROVIDER.name}目录树 v3.0`, createDialog);
        }

        console.log("[百度导出] 浮动按钮已添加，点击即可导出目录");
    }

    // 延迟添加按钮，确保页面完全加载
    if (document.readyState === 'complete') {
        addButton();
    } else {
        window.addEventListener('load', () => {
            setTimeout(addButton, 2000); // 页面加载后2秒添加按钮
        });
    }

    console.log(`[网盘导出] 脚本已加载 v3.0（${PROVIDER ? PROVIDER.name : "本页无匹配平台"}）`);

})();
