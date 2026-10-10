// ==UserScript==
// @name          百度网盘目录导出（多图标版+进度）v2.1
// @namespace    https://greasyfork.org/zh-CN/users/1465036
// @version      2.1.0
// @description  导出百度网盘分享页完整树状目录（修复递归子目录+文件大小），适配文件夹📂、视频📽️、图片🖼️、文档📝、压缩包📦等图标，显示导出进度
// @author       intumu.com + AI Fix
// @match        https://pan.baidu.com/s/*
// @match        https://pan.baidu.com/disk/*
// @match        https://yun.baidu.com/s/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      pan.baidu.com
// @connect      yun.baidu.com
// @run-at       document-end
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/562519/%E7%99%BE%E5%BA%A6%E7%BD%91%E7%9B%98%E7%9B%AE%E5%BD%95%E5%AF%BC%E5%87%BA%EF%BC%88%E5%A4%9A%E5%9B%BE%E6%A0%87%E7%89%88%2B%E8%BF%9B%E5%BA%A6%EF%BC%89v21.user.js
// @updateURL https://update.greasyfork.org/scripts/562519/%E7%99%BE%E5%BA%A6%E7%BD%91%E7%9B%98%E7%9B%AE%E5%BD%95%E5%AF%BC%E5%87%BA%EF%BC%88%E5%A4%9A%E5%9B%BE%E6%A0%87%E7%89%88%2B%E8%BF%9B%E5%BA%A6%EF%BC%89v21.meta.js
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

    // ==================== 统一获取文件列表 ====================

    async function getList(path = '/') {
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
        return {
            isDir: (getDataProp(item, 'isdir') === 1 || getDataProp(item, 'isdir') === '1'),
            name: getDataProp(item, 'server_filename', 'filename', 'name') || '未知文件',
            size: Number(getDataProp(item, 'size')) || 0,
            path: getDataProp(item, 'path') || '',
            fsId: getDataProp(item, 'fs_id', 'fsid') || ''
        };
    }

    // ==================== 目录树构建 ====================

    // 预扫描统计总节点数
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
    }

    // 递归构建目录树
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

                const childNode = await buildTree(nextPath, currentDepth + 1, maxDepth, onProgress);
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
            const totalNodes = await countTotalNodes('/', 1, maxDepth);
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

            const treeData = await buildTree('/', 1, maxDepth, updateProgress);
            const lines = [];

            // 头部信息（根据配置决定是否包含）
            if (opt.includeHeader) {
                lines.push(`百度网盘目录导出`);
                lines.push(`导出时间: ${new Date().toLocaleString()}`);
                lines.push(`导出层级: ${maxDepth === Infinity ? '全部' : maxDepth}`);
                if (wxlistMetadata) {
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
            a.download = `BaiduPan_Tree_${new Date().getTime()}.txt`;
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
            <h3 style="margin-top:0">百度网盘目录导出 v2.1</h3>
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

        const btn = document.createElement('div');
        btn.id = 'baiduExportBtn';
        btn.innerHTML = '📂';
        btn.style.cssText = 'position:fixed; top:20px; right:20px; width:50px; height:50px; background:#1677ff; color:white; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:24px; cursor:pointer; z-index:99999; box-shadow:0 2px 10px rgba(0,0,0,0.2); transition:transform 0.2s;';
        btn.title = "导出百度网盘目录树 v2.1";
        btn.onmouseenter = () => btn.style.transform = 'scale(1.1)';
        btn.onmouseleave = () => btn.style.transform = 'scale(1)';
        btn.onclick = createDialog;
        document.body.appendChild(btn);

        // 注册菜单命令（备用）
        if (typeof GM_registerMenuCommand !== 'undefined') {
            GM_registerMenuCommand("导出百度网盘目录树 v2.1", createDialog);
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

    console.log("[百度导出] 脚本已加载 v2.1（修复版）");

})();
