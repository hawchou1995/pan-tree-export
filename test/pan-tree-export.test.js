/**
 * pan-tree-export v3.0.3 自检 —— 测的是**产物字节**本身。
 *
 *   node test/pan-tree-export.test.js
 *
 * 做法：读 pan-tree-export.user.js 原文，只在末尾把 IIFE 的收尾 `})();`
 * 换成一个导出钩子（把内部函数暴露给测试），其余字节不动；然后在 vm 里跑。
 * 所以测的是真脚本，不是复制品。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'pan-tree-export.user.js');
const BASELINE = path.join(ROOT, 'baseline', '562519-v2.1.0-online.user.js');

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want),
        'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// ---------------------------------------------------------------- 沙箱

const EXPORTS = [
    'PROVIDER', 'PROVIDERS', 'extractItemFields', 'quarkNormalize', 'pan123Normalize',
    'xunleiNormalize', 'quarkShareId', 'pan123ShareKey', 'pan123Pwd', 'xunleiShareId',
    'xunleiHeaders', 'formatSize', 'getFileIcon', 'buildTree', 'countTotalNodes',
    'calcTotalSize', 'exportText', 'createDialog'
];

// 初始页设成迅雷分享页：脚本在加载时就算 PROVIDER，必须命中一个，
// 否则 PROVIDER === null，后面的建树/导出都无从测起。各平台 detect 另用动态改页来测。
const START = { hostname: 'pan.xunlei.com', pathname: '/s/VPxxxx', search: '?pwd=nxhq' };

function mkStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
        setItem: (k, v) => m.set(String(k), String(v)),
        removeItem: (k) => m.delete(String(k)),
        key: (i) => Array.from(m.keys())[i] ?? null,
        get length() { return m.size; }
    };
}

function makeSandbox() {
    const box = {};
    box.console = { log() { }, warn() { }, error() { } };
    box.location = {
        hostname: START.hostname, pathname: START.pathname, search: START.search,
        origin: 'https://' + START.hostname, href: 'https://' + START.hostname + START.pathname
    };
    box.localStorage = mkStorage();
    box.sessionStorage = mkStorage();
    box.navigator = { userAgent: 'node-test' };
    box.document = {
        cookie: '',
        readyState: 'loading',
        body: { appendChild(el) { box.__appended.push(el); }, removeChild() { } },
        addEventListener() { },
        // 只认「真被 append 过」的元素，外加对话框里那两个按钮的替身：
        // 对话框守卫生效（没建过 = null），而 innerHTML 里的按钮解析不出来，就给个能挂 onclick 的替身
        getElementById(id) {
            const found = box.__appended.find((e) => e.id === id);
            if (found) return found;
            if (id === 'cancelBtn' || id === 'confirmBtn') return { onclick: null, style: {}, innerText: '', disabled: false };
            return null;
        },
        querySelectorAll() { return []; },
        createElement(tag) {
            return {
                tagName: String(tag).toUpperCase(),
                style: {},
                appendChild() { }, removeChild() { }, addEventListener() { },
                click() { box.__clickedDownload = this.download; }
            };
        }
    };
    box.window = { addEventListener() { }, location: box.location };
    box.unsafeWindow = {};
    box.__appended = [];
    box.__alerts = [];
    box.alert = (m) => { box.__alerts.push(String(m)); };
    box.GM_registerMenuCommand = () => { };
    box.GM_xmlhttpRequest = () => { throw new Error('测试里不应走 GM 请求'); };
    box.Blob = function (parts) { box.__blob = parts.join(''); };
    box.URL = URL;
    box.URLSearchParams = URLSearchParams;
    box.URL.createObjectURL = () => 'blob:test';
    box.URL.revokeObjectURL = () => { };
    box.setTimeout = setTimeout;
    box.clearTimeout = clearTimeout;
    box.fetch = async (input, init) => {
        const handler = box.__fetchHandler;
        if (!handler) throw new Error('未设置的 fetch：' + String(input));
        return handler(String(input), init || {});
    };
    return box;
}

function loadProduct() {
    const src = fs.readFileSync(SRC, 'utf8');
    const tail = '})();';
    if (!src.trimEnd().endsWith(tail)) throw new Error('产物结尾不是 })(); —— 结构变了，测试拒绝继续');
    const hook = '\n    globalThis.__T = { ' + EXPORTS.join(', ') + ' };\n})();';
    const patched = src.trimEnd().slice(0, -tail.length) + hook;
    const box = makeSandbox();
    vm.createContext(box);
    vm.runInContext(patched, box, { filename: 'pan-tree-export.user.js' });
    if (!box.__T) throw new Error('导出钩子没生效');
    return { T: box.__T, box };
}

const { T, box } = loadProduct();

// provider 的 list 是对象属性，测试里会临时替换成假数据；先存真身，用完还原
const REAL_LISTS = new Map(T.PROVIDERS.map((p) => [p.id, p.list]));

function setPage(hostname, pathname, search) {
    box.location.hostname = hostname;
    box.location.pathname = pathname;
    box.location.search = search || '';
    box.location.origin = 'https://' + hostname;
}
function detectOf(hostname, pathname, search) {
    setPage(hostname, pathname, search);
    const hit = T.PROVIDERS.find((x) => x.detect());
    return hit ? hit.id : null;
}
function jsonResponse(obj, status = 200) {
    return { status, ok: status >= 200 && status < 300, json: async () => obj, text: async () => JSON.stringify(obj) };
}

async function main() {
// ---------------------------------------------------------------- 用例

console.log('\n[1] 平台识别 detect()');
{
    eq('pan.baidu.com/s/1abc', detectOf('pan.baidu.com', '/s/1abc', ''), 'baidu');
    eq('yun.baidu.com/s/1abc', detectOf('yun.baidu.com', '/s/1abc', ''), 'baidu');
    eq('pan.baidu.com/disk/home', detectOf('pan.baidu.com', '/disk/home', ''), 'baidu');
    eq('pan.quark.cn/s/abc123', detectOf('pan.quark.cn', '/s/abc123', ''), 'quark');
    eq('pan.quark.cn 首页（非分享）', detectOf('pan.quark.cn', '/', ''), null);
    eq('123pan /s/xxx.html?pwd=', detectOf('www.123pan.com', '/s/yS8UVv-tqged.html', '?pwd=6666'), 'pan123');
    eq('123pan /123pan/GRNiVv', detectOf('www.123pan.com', '/123pan/GRNiVv-C77m3', ''), 'pan123');
    eq('123pan /mshare/ab12', detectOf('www.123pan.com', '/mshare/ab12', ''), 'pan123');
    eq('123pan 镜像域 <uid>.share.123pan.cn/123pan/xxx', detectOf('1813356033.share.123pan.cn', '/123pan/yS8UVv-tqged', ''), 'pan123');
    eq('123pan 首页（非分享）', detectOf('www.123pan.com', '/', ''), null);
    eq('pan.xunlei.com/s/VP3...', detectOf('pan.xunlei.com', '/s/VP3WCxbjc8FHUBXPwm2EbrYWA1', '?pwd=nxhq'), 'xunlei');
    eq('pan.xunlei.com 首页（非分享）', detectOf('pan.xunlei.com', '/', ''), null);
    eq('无关站点', detectOf('example.com', '/s/x', ''), null);
}

console.log('\n[2] 各平台条目归一（字段名取自真实响应）');
{
    eq('baidu 目录（handle=path）',
        T.extractItemFields({ isdir: 1, server_filename: '电影', path: '/电影', size: 0 }),
        { isDir: true, name: '电影', size: 0, path: '/电影', fsId: '', handle: '/电影' });
    eq('baidu 无 path 时 handle 退到 fsId',
        T.extractItemFields({ isdir: 0, server_filename: 'a.mp4', size: 1024, fsid: 123 }),
        { isDir: false, name: 'a.mp4', size: 1024, path: '', fsId: 123, handle: 123 });
    eq('quark 目录',
        T.quarkNormalize({ file_name: '第一单元', dir: true, fid: 'f1', size: 0 }),
        { isDir: true, name: '第一单元', size: 0, handle: 'f1' });
    eq('123 目录（Type==1）', T.pan123Normalize({ FileName: '软件', Type: 1, Size: 0, FileId: 99 }),
        { isDir: true, name: '软件', size: 0, handle: '99' });
    eq('123 文件（Type==0）', T.pan123Normalize({ FileName: 'a.iso', Type: 0, Size: 1234, FileId: 100 }),
        { isDir: false, name: 'a.iso', size: 1234, handle: '100' });
    eq('xunlei 目录（kind=drive#folder）',
        T.xunleiNormalize({ kind: 'drive#folder', id: 'VOMNKEYy', name: '合集', size: '0' }),
        { isDir: true, name: '合集', size: 0, handle: 'VOMNKEYy' });
    eq('xunlei 文件（kind=drive#file）',
        T.xunleiNormalize({ kind: 'drive#file', id: 'VP3W3Rd8', name: 'A3328.jpg', size: '258366848' }),
        { isDir: false, name: 'A3328.jpg', size: 258366848, handle: 'VP3W3Rd8' });
}

console.log('\n[3] 工具函数边界');
{
    eq('formatSize(0)', T.formatSize(0), '0 B');
    eq('formatSize(null)', T.formatSize(null), '-');
    eq('formatSize(1536)', T.formatSize(1536), '1.50 KB');
    eq('formatSize(1099511627776)', T.formatSize(1099511627776), '1.00 TB');
    eq('getFileIcon(mp4 大写)', T.getFileIcon('a.MP4'), '📽️');
    eq('getFileIcon(rar)', T.getFileIcon('a.rar'), '📦');
    eq('getFileIcon(未知后缀)', T.getFileIcon('a.xyz'), '📄');
    eq('getFileIcon(空名)', T.getFileIcon(''), '📄');
}

console.log('\n[4] 分享页 URL → shareKey / shareId / 提取码');
{
    setPage('www.123pan.com', '/s/yS8UVv-tqged.html', '?pwd=6666');
    eq('123 shareKey 去掉 .html', T.pan123ShareKey(), 'yS8UVv-tqged');
    eq('123 提取码取 ?pwd=', T.pan123Pwd('yS8UVv-tqged'), '6666');
    setPage('www.123pan.com', '/123pan/GRNiVv-C77m3', '');
    eq('123 shareKey 走 /123pan/ 路由', T.pan123ShareKey(), 'GRNiVv-C77m3');
    box.localStorage.setItem('sharePwdd_GRNiVv-C77m3', 'SD9v');
    eq('123 提取码兜底 localStorage.sharePwdd_', T.pan123Pwd('GRNiVv-C77m3'), 'SD9v');
    setPage('pan.quark.cn', '/s/a13350742770', '');
    eq('quark shareId', T.quarkShareId(), 'a13350742770');
    setPage('pan.xunlei.com', '/s/VP3WCxbjc8FHUBXPwm2EbrYWA1', '?pwd=nxhq');
    eq('xunlei shareId', T.xunleiShareId(), 'VP3WCxbjc8FHUBXPwm2EbrYWA1');
}

console.log('\n[5] 迅雷三个必需请求头（少一个服务端就 400）');
{
    eq('三个头都缺时为空串（不编造）',
        T.xunleiHeaders(), { 'x-device-id': '', 'x-client-id': '', 'x-captcha-token': '' });
    box.localStorage.setItem('deviceid', 'wdi10.abc');
    box.localStorage.setItem('captcha_Xqp0kJBXWhwaTpB6', JSON.stringify({ token: 'ck0.TOKEN' }));
    const h = T.xunleiHeaders();
    eq('x-device-id 来自 localStorage.deviceid', h['x-device-id'], 'wdi10.abc');
    eq('x-client-id 来自 captcha_<clientId> 键名后缀', h['x-client-id'], 'Xqp0kJBXWhwaTpB6');
    eq('x-captcha-token 来自该键 JSON.token', h['x-captcha-token'], 'ck0.TOKEN');
    box.localStorage.removeItem('deviceid');
    box.document.cookie = 'XLA_CI=x; deviceid=wdi10.cookie; xl_fp_rt=1';
    eq('deviceid 从 cookie 兜底', T.xunleiHeaders()['x-device-id'], 'wdi10.cookie');
    box.document.cookie = '';
}

console.log('\n[6] 建树 / 预扫描 / 目录总大小（跑真 buildTree）');
{
    const tree = {
        '': [{ isDir: true, name: 'B 目录', size: 0, handle: 'B' }, { isDir: false, name: 'a.txt', size: 10, handle: '' }],
        'B': [{ isDir: true, name: 'C', size: 0, handle: 'C' }, { isDir: false, name: 'b.bin', size: 20, handle: '' }],
        'C': [{ isDir: false, name: 'c.dat', size: 30, handle: '' }]
    };
    T.PROVIDER.list = async (h) => tree[h === null ? '' : String(h)] || [];
    eq('预扫描节点数 = 5', await T.countTotalNodes(null), 5);
    const built = await T.buildTree(null);
    eq('根层排序：目录在前', built.children.map((n) => n.name), ['B 目录', 'a.txt']);
    eq('目录总大小递归求和 20+30', built.children[0].totalSize, 50);
    eq('三层都下去了', built.children[0].children[0].children[0].name, 'c.dat');
    eq('calcTotalSize 空目录退回自身大小', T.calcTotalSize({ children: [], size: 7 }), 7);

    // 目录缺句柄时只留空壳，不炸整棵树
    T.PROVIDER.list = async (h) => (h === null
        ? [{ isDir: true, name: '没有句柄的目录', size: 0, handle: '' }, { isDir: false, name: 'x.txt', size: 1, handle: '' }]
        : []);
    const built2 = await T.buildTree(null);
    eq('缺句柄目录留空壳', built2.children.length, 2);
    eq('缺句柄目录 children 为空', built2.children[0].children, []);
    T.PROVIDERS.forEach((p) => { p.list = REAL_LISTS.get(p.id); });
}

console.log('\n[7] 导出全文（跑真 exportText，抓 Blob 与落盘文件名）');
{
    const tree = {
        '': [{ isDir: true, name: 'B 目录', size: 0, handle: 'B' }, { isDir: false, name: 'a.txt', size: 1048576, handle: '' }],
        'B': [{ isDir: false, name: 'b.rar', size: 2097152, handle: '' }]
    };
    T.PROVIDER.list = async (h) => tree[h === null ? '' : String(h)] || [];
    const dialog = { appendChild() { }, parentNode: { removeChild() { } } };
    setPage('pan.xunlei.com', '/s/VPxxxx', '?pwd=nxhq');
    box.__blob = '';
    await T.exportText(Infinity, dialog, {
        includeTree: true, includeIcons: true, includeSize: true, includeHeader: true, includeStats: true
    });
    const lines = box.__blob.split('\n');
    ok('头部第一行带平台名', lines[0] === '迅雷云盘目录导出', lines[0]);
    ok('目录行（含聚合大小）', lines.includes('📂 B 目录/ (2.00 MB)'), JSON.stringify(lines));
    ok('文件行（含大小）', lines.includes('📝 a.txt (1.00 MB)'), JSON.stringify(lines));
    ok('子文件缩进 1 层', lines.includes('    📦 b.rar (2.00 MB)'), JSON.stringify(lines));
    ok('统计行', lines[lines.length - 1] === '统计: 1 个文件夹, 2 个文件, 总大小 3.00 MB', lines[lines.length - 1]);
    ok('目录行在文件行之前', lines.indexOf('📂 B 目录/ (2.00 MB)') < lines.indexOf('📝 a.txt (1.00 MB)'));
    ok('落盘文件名带平台前缀', /^XunleiPan_Tree_\d+\.txt$/.test(String(box.__clickedDownload)), String(box.__clickedDownload));

    // 关掉全部可选块 → 只剩目录树
    box.__blob = '';
    dialog.removeChild = () => { };
    await T.exportText(Infinity, dialog, { includeTree: true, includeIcons: false, includeSize: false, includeHeader: false, includeStats: false });
    const bare = box.__blob.split('\n');
    ok('关掉头部/统计后首行就是目录树', bare[0] === 'B 目录/', bare[0]);
    ok('关掉图标后不带 emoji', !/[📂📝📦]/.test(box.__blob), box.__blob);
    T.PROVIDERS.forEach((p) => { p.list = REAL_LISTS.get(p.id); });
}

console.log('\n[8] 123 云盘 /api/share/get 载荷与翻页');
{
    const calls = [];
    box.__fetchHandler = async (url) => {
        calls.push(url);
        return jsonResponse({ code: 0, data: { InfoList: [{ FileName: 'x', Type: 0, Size: 1, FileId: 1 }], Total: 1 } });
    };
    setPage('www.123pan.com', '/s/AAA-bbb.html', '');
    const list = await T.PROVIDERS.find((p) => p.id === 'pan123').list(null);
    eq('123 根目录 ParentFileId=0', /ParentFileId=0/.test(calls[0]), true);
    const q = new URL(calls[0]).searchParams;
    eq('123 必填七参数齐全',
        ['ShareKey', 'ParentFileId', 'Limit', 'OrderBy', 'OrderDirection', 'Next', 'Page'].every((k) => q.has(k)), true);
    eq('123 无提取码时不带 SharePwd', q.has('SharePwd'), false);
    eq('123 归一化输出', list, [{ isDir: false, name: 'x', size: 1, handle: '1' }]);

    calls.length = 0;
    setPage('www.123pan.com', '/s/AAA-bbb.html', '?pwd=1a2b');
    await T.PROVIDERS.find((p) => p.id === 'pan123').list(null);
    eq('123 有提取码时带 SharePwd', new URL(calls[0]).searchParams.get('SharePwd'), '1a2b');

    // Total=150 → 必须翻第二页
    calls.length = 0;
    box.__fetchHandler = async (url) => {
        calls.push(url);
        const page = Number(new URL(url).searchParams.get('Page'));
        return jsonResponse({
            code: 0,
            data: { InfoList: page === 1 ? new Array(100).fill({ FileName: 'f', Type: 0, Size: 1, FileId: 1 }) : [{ FileName: 'g', Type: 0, Size: 1, FileId: 2 }], Total: 101 }
        });
    };
    const two = await T.PROVIDERS.find((p) => p.id === 'pan123').list(null);
    eq('123 按 Total 翻到第二页', calls.length, 2);
    eq('123 两页合并 101 项', two.length, 101);

    // 首屏就出错 → 必须抛错，不许静默返回空
    box.__fetchHandler = async () => jsonResponse({ code: 5103, message: '提取码错误' });
    let threw = null;
    try { await T.PROVIDERS.find((p) => p.id === 'pan123').list(null); } catch (e) { threw = e; }
    ok('123 首屏出错必须抛错', !!threw && /5103/.test(String(threw && threw.message)), String(threw));
}

console.log('\n[9] 迅雷根/子目录端点、请求头与翻页');
{
    const calls = [];
    box.__fetchHandler = async (url, init) => {
        calls.push({ url, headers: init.headers });
        if (/\/share\/detail/.test(url)) {
            return jsonResponse({ share_status: 'OK', files: [{ kind: 'drive#file', id: 'F2', name: '子文件.mp4', size: '10' }] });
        }
        return jsonResponse({
            share_status: 'OK', pass_code_token: 'espTOKEN',
            files: [{ kind: 'drive#folder', id: 'D1', name: '合集', size: '0' }],
            next_page_token: ''
        });
    };
    setPage('pan.xunlei.com', '/s/VP3WCxbjc8FHUBXPwm2EbrYWA1', '?pwd=nxhq');
    box.localStorage.setItem('deviceid', 'wdi10.abc');
    const x = T.PROVIDERS.find((p) => p.id === 'xunlei');
    const root = await x.list(null);
    ok('迅雷根目录走 /drive/v1/share（不是 detail）', /\/drive\/v1\/share\?/.test(calls[0].url), calls[0].url);
    eq('迅雷根目录带 pass_code', new URL(calls[0].url).searchParams.get('pass_code'), 'nxhq');
    eq('迅雷请求带三个头',
        ['x-device-id', 'x-client-id', 'x-captcha-token'].every((k) => k in calls[0].headers), true);
    eq('迅雷根目录输出', root, [{ isDir: true, name: '合集', size: 0, handle: 'D1' }]);

    const sub = await x.list('D1');
    ok('迅雷子目录走 /drive/v1/share/detail', /\/drive\/v1\/share\/detail\?/.test(calls[1].url), calls[1].url);
    const sq = new URL(calls[1].url).searchParams;
    eq('迅雷子目录 parent_id', sq.get('parent_id'), 'D1');
    eq('迅雷子目录带根响应给的 pass_code_token', sq.get('pass_code_token'), 'espTOKEN');
    eq('迅雷子目录不带 pass_code', sq.has('pass_code'), false);
    eq('迅雷子目录输出', sub, [{ isDir: false, name: '子文件.mp4', size: 10, handle: 'F2' }]);

    // 翻页：第一页给 next_page_token
    calls.length = 0;
    let round = 0;
    box.__fetchHandler = async (url) => {
        calls.push(url);
        round++;
        return jsonResponse({
            share_status: 'OK', pass_code_token: 'espTOKEN',
            files: [{ kind: 'drive#file', id: 'F' + round, name: 'f' + round, size: '1' }],
            next_page_token: round === 1 ? 'PT2' : ''
        });
    };
    const paged = await T.PROVIDERS.find((p) => p.id === 'xunlei').list(null);
    eq('迅雷按 page_token 翻页', calls.length, 2);
    eq('迅雷第二页带 page_token', new URL(calls[1]).searchParams.get('page_token'), 'PT2');
    eq('迅雷两页合并', paged.length, 2);

    // 接口报错 → 必须把服务端原文带出来
    box.__fetchHandler = async () => jsonResponse({ error: 'share_not_found', error_description: '分享不存在或已删除' });
    let threw = null;
    try { await T.PROVIDERS.find((p) => p.id === 'xunlei').list(null); } catch (e) { threw = e; }
    ok('迅雷接口错误必须抛出且带原文', !!threw && /分享不存在/.test(String(threw && threw.message)), String(threw));
}

console.log('\n[10] 反向用例：字段名不许跨平台误吃');
{
    const baiduItem = { isdir: 1, server_filename: '百度目录', path: '/百度目录', size: 0 };
    const q = T.quarkNormalize(baiduItem);
    ok('夸克归一化不把百度目录当目录', q.isDir === false, JSON.stringify(q));
    const x = T.xunleiNormalize(baiduItem);
    ok('迅雷归一化拿不到句柄', x.handle === '', JSON.stringify(x));
    const p = T.pan123Normalize({ isdir: 1, server_filename: '百度目录', size: 0 });
    ok('123 归一化不把百度目录当目录', p.isDir === false, JSON.stringify(p));

    const xunleiFolder = { kind: 'drive#folder', id: 'D1', name: '合集', size: '0' };
    const b = T.extractItemFields(xunleiFolder);
    ok('百度归一化不把迅雷文件夹当目录', b.isDir === false, JSON.stringify(b));
    ok('百度归一化拿不到句柄', b.handle === '', JSON.stringify(b));
}

console.log('\n[11] 产物纪律');
{
    const raw = fs.readFileSync(SRC);
    const text = raw.toString('utf8');
    const base = fs.readFileSync(BASELINE, 'utf8');
    ok('无 BOM', !raw.slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])));
    ok('纯 LF（无 CRLF）', !raw.includes(Buffer.from('\r\n')));
    ok('@version 3.0.3', /^\/\/ @version\s+3\.0\.3$/m.test(text));
    ok('四个平台的 @match 都在',
        ['https://pan\\.baidu\\.com/s/\\*', 'https://pan\\.quark\\.cn/s/\\*', '\\*://\\*\\.123pan\\.com/\\*', '\\*://\\*\\.123pan\\.cn/\\*', 'https://pan\\.xunlei\\.com/s/\\*']
            .every((m) => new RegExp('// @match\\s+' + m).test(text)));
    ok('引流：GitHub + qingju.me',
        text.includes('github.com/hawchou1995/pan-tree-export') && text.includes('qingju.me'));
    const count = (s) => (s.match(/getListByWxList\(|getListByShareList\(|initApi\(\)|yunData/g) || []).length;
    ok('百度 API 调用点一处没少', count(text) === count(base), count(base) + ' -> ' + count(text));
    ok('百度方案A/B 与降级分支仍在',
        text.includes('方案A：/share/wxlist') && text.includes('方案B：/share/list') && text.includes("apiMode = 'wxlist'"));
}

console.log('\n[12] 面板页脚：引流链接真在对话框里');
{
    box.__appended = [];
    T.createDialog();
    const dlg = box.__appended.find((e) => e.id === 'baiduExportDialog');
    ok('对话框被创建并挂到 body', !!dlg, JSON.stringify(box.__appended.map((e) => e.id)));
    const html = dlg ? String(dlg.innerHTML || '') : '';
    ok('页脚里有 GitHub 仓库链接',
        /href="https:\/\/github\.com\/hawchou1995\/pan-tree-export"/.test(html), html.slice(-300));
    ok('页脚里有 qingju.me 链接', /href="https:\/\/qingju\.me"/.test(html), html.slice(-300));
    ok('两个链接都是新窗口打开的 <a>',
        (html.match(/<a [^>]*target="_blank"[^>]*rel="noopener"/g) || []).length >= 2);
    ok('页脚在按钮之后（面板最底部）', html.indexOf('pan-tree-export') > html.indexOf('confirmBtn'));
}

}

main().then(() => {
    console.log('\n' + (failures.length ? 'FAILED ' + failures.length + ' 项' : 'PASS') + ' —— ' + pass + ' 项通过');
    if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
}, (err) => {
    console.error('测试自身崩了：', err);
    process.exit(2);
});
