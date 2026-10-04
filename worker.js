/**
 * Cloudflare Workers Blog v13.25 (Refactored Edition)
 * 优化内容：代码结构重构、逻辑分离、可读性提升
 * 功能变更：无 (1:1 保持原有功能和 UI)
 */

const CONFIG = {
    name: "博客世界",                    // 站点标题
    desc: "人生如戏",                    // 副标题 / SEO Description
    url: "https://your-domain.com",     // 博客主域名
    pageSize: 6,                        // 分页展示条数
    bannerUrl: "https://.../banner.webp",// 顶部背景图
    favicon: "https://.../favicon.webp", // Favicon 链接
    // Google Search Console 站点验证码（可选，留空则不输出该 meta 标签）
    // 注意：请填自己的验证码。使用别人的验证码，等于把站点的搜索后台权限交给对方。
    googleVerify: "",
    // Cloudflare Turnstile 人机验证配置（可选）
    // 留空 = 关闭人机验证，登录页不会加载 Turnstile，也不会校验 token。
    // 需要开启时，填入 Cloudflare 控制台 Turnstile 里真实的 Site Key / Secret Key。
    // 注意：不要保留 "0x4AAAAAA..." 这类占位符——它会被误判为“已开启”，
    //      导致登录页渲染出无效的验证组件，从而出现“点登录没反应”的问题。
    turnstileSiteKey: "",
    turnstileSecretKey: "",
};

// --- 辅助函数 ---
const response = {
    json: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }),
    html: (content, status = 200) => new Response(content, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    redirect: (url, cookieStr = null) => {
        const headers = { 'Location': url };
        if (cookieStr) headers['Set-Cookie'] = cookieStr;
        return new Response(null, { status: 302, headers });
    },
    error: (msg, status = 500) => new Response(msg, { status }),
    asset: (body, contentType) => new Response(body, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public,max-age=86400' } })
};

async function hash(p) { 
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p))))
        .map(b => b.toString(16).padStart(2, '0')).join(''); 
}

async function verifyTurnstile(token, secret, ip) {
    if (!token || !secret) return false;
    const formData = new FormData();
    formData.append('secret', secret);
    formData.append('response', token);
    formData.append('remoteip', ip);
    try {
        const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { body: formData, method: 'POST' });
        const json = await result.json();
        return json.success;
    } catch (e) { return false; }
}

// 判断 Turnstile 是否「真正」配置完成。
// 只有形如 0x 开头、且长度足够的真实密钥才算开启；占位符 "0x4AAAAAA..." 含点号，
// 会被判定为未配置 → 跳过人机验证。这一层校验同时用于服务端与前端渲染。
function turnstileEnabled() {
    const isRealKey = (k) => typeof k === 'string' && /^0x[A-Za-z0-9_-]{20,}$/.test(k);
    return isRealKey(CONFIG.turnstileSiteKey) && isRealKey(CONFIG.turnstileSecretKey);
}

// --- HTML 转义 ---
// 所有来自用户输入的字段（标题 / 分类 / 标签 / 昵称 / 评论内容）拼接进页面前都必须过一遍，
// 否则标题里写一段 <script> 就会变成存储型 XSS。
function esc(v) {
    return String(v === undefined || v === null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// --- R2 key 安全化 ---
// 去掉路径分隔符与控制字符，避免通过 slug / 文件名写出目录结构或覆盖 sys/ 下的系统文件
function safeKey(v) {
    const s = String(v === undefined || v === null ? '' : v)
        .replace(/[/\\]/g, '-')
        .replace(/[\u0000-\u001f]/g, '')
        .replace(/\.{2,}/g, '.')
        .trim();
    return s || Date.now().toString();
}

function safeFileName(name) {
    const base = String(name || 'image')
        .replace(/[/\\]/g, '_')
        .replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]/g, '_');
    return base.slice(-80) || 'image';
}

// --- 站点设置（存 R2，可在后台修改，覆盖 CONFIG 中的默认值） ---
const SETTING_KEYS = ['name', 'desc', 'url', 'bannerUrl', 'favicon', 'pageSize', 'googleVerify', 'turnstileSiteKey', 'turnstileSecretKey'];

async function loadSettings(env) {
    try {
        const o = await env.BLOG_BUCKET.get('sys/settings.json');
        if (o) return await o.json();
    } catch (e) { }
    return null;
}

function applySettings(settings) {
    if (!settings) return;
    for (const k of SETTING_KEYS) {
        if (settings[k] !== undefined && settings[k] !== null) CONFIG[k] = settings[k];
    }
    CONFIG.pageSize = parseInt(CONFIG.pageSize, 10) || 6;
}

// --- 数据读取 ---
async function loadAllPosts(env) {
    const list = await env.BLOG_BUCKET.list({ prefix: 'posts/', limit: 1000 });
    const posts = await Promise.all(list.objects.map(async o => {
        try { return await (await env.BLOG_BUCKET.get(o.key)).json(); } catch (e) { return null; }
    }));
    return posts.filter(Boolean);
}

// 评论按「文章」分文件存放，这里摊平成一条条，并带上 postId 与定位用的 id/index
async function loadAllComments(env) {
    const list = await env.BLOG_BUCKET.list({ prefix: 'comments/', limit: 1000 });
    const out = [];
    await Promise.all(list.objects.map(async o => {
        try {
            const arr = await (await env.BLOG_BUCKET.get(o.key)).json();
            const postId = o.key.slice('comments/'.length).replace(/\.json$/, '');
            (arr || []).forEach((c, i) => out.push({ ...c, postId, index: i, cid: c.id || (postId + '#' + i) }));
        } catch (e) { }
    }));
    return out;
}

async function loadAllMedia(env) {
    const list = await env.BLOG_BUCKET.list({ prefix: 'images/', limit: 1000 });
    return list.objects.map(o => o.key);
}

// --- 后台共享组件 ---
const ADMIN_NAV = [
    { key: 'dash', href: '/admin/dashboard', label: '概览', icon: 'fa-gauge-high' },
    { key: 'posts', href: '/admin/posts', label: '文章', icon: 'fa-file-lines' },
    { key: 'comments', href: '/admin/comments', label: '评论', icon: 'fa-comments' },
    { key: 'media', href: '/admin/media', label: '媒体', icon: 'fa-images' },
    { key: 'settings', href: '/admin/settings', label: '设置', icon: 'fa-gear' },
];

function adminNav(active, counts = {}) {
    return '<div class="admin-nav">' + ADMIN_NAV.map(n => {
        const c = counts[n.key];
        return '<a href="' + n.href + '" class="admin-nav-item' + (active === n.key ? ' active' : '') + '">'
            + '<i class="fa-solid ' + n.icon + '"></i><span>' + n.label + '</span>'
            + (c ? '<span class="nav-count">' + c + '</span>' : '') + '</a>';
    }).join('') + '</div>';
}

function pageHead(title, sub, actions = '') {
    return '<div class="page-head"><div><h1 class="page-title">' + title + '</h1>'
        + (sub ? '<p class="page-sub">' + sub + '</p>' : '') + '</div>'
        + (actions ? '<div class="page-actions">' + actions + '</div>' : '') + '</div>';
}

function emptyState(icon, text, action = '') {
    return '<div class="empty-state"><i class="fa-solid ' + icon + '"></i><p>' + text + '</p>' + action + '</div>';
}

// --- 静态资源管理 (CSS/JS) ---
// 将原本混在 HTML 函数中的 CSS 提取出来，保持原样
const STYLES = `
    :root { --primary: #2563eb; --primary-light: #eff6ff; --bg: #f1f5f9; --card: #ffffff; --text: #1e293b; --text-light: #64748b; --border: #e2e8f0; --toolbar-bg: #f8fafc; --tab-bg: #e2e8f0; --tab-active-bg: #f1f5f9; --danger: #ef4444; --success: #22c55e; --pinned: #e11d48; --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); --code-bg: #282c34; --rank-1: #fef3c7; --rank-1-text: #d97706; --rank-2: #f1f5f9; --rank-2-text: #64748b; --rank-3: #ffedd5; --rank-3-text: #c2410c; --pin-bg: #fff1f2; --pin-text: #e11d48; --pin-border: #fecdd3; }
    [data-theme="dark"] { --primary: #3b82f6; --primary-light: #1e293b; --bg: #0f172a; --card: #1e293b; --text: #f1f5f9; --text-light: #94a3b8; --border: #334155; --toolbar-bg: #1e293b; --tab-bg: #334155; --tab-active-bg: #475569; --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.5); --rank-1: #451a03; --rank-1-text: #fcd34d; --rank-2: #1e293b; --rank-2-text: #cbd5e1; --rank-3: #431407; --rank-3-text: #fdba74; --pin-bg: rgba(225, 29, 72, 0.15); --pin-text: #fb7185; --pin-border: rgba(225, 29, 72, 0.3); }
    * { box-sizing: border-box; } body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); margin: 0; line-height: 1.6; transition: background-color 0.3s ease, color 0.3s ease; } a { color: inherit; text-decoration: none; transition: color 0.2s; }
    .markdown-body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 15px; background: transparent !important; color: var(--text) !important; font-family: inherit !important; }
    [data-theme="dark"] .markdown-body { color-scheme: dark; } [data-theme="dark"] .markdown-body a { color: #58a6ff; } [data-theme="dark"] .markdown-body blockquote { color: #8b949e; border-left-color: #30363d; } [data-theme="dark"] .markdown-body h1, [data-theme="dark"] .markdown-body h2, [data-theme="dark"] .markdown-body h3 { border-bottom-color: #21262d; color: var(--text); } [data-theme="dark"] .markdown-body table tr { background-color: var(--card); border-top-color: var(--border); } [data-theme="dark"] .markdown-body table tr:nth-child(2n) { background-color: var(--bg); } [data-theme="dark"] .markdown-body table th, [data-theme="dark"] .markdown-body table td { border-color: var(--border); } [data-theme="dark"] .markdown-body hr { background-color: var(--border); }
    .markdown-body pre { background-color: var(--code-bg) !important; border-radius: 8px; padding: 15px; border: 1px solid var(--border); overflow-x: auto; white-space: pre; word-wrap: normal; max-width: 100%; max-height: 800px; text-rendering: optimizeSpeed; } .markdown-body pre code { color: #abb2bf; background: transparent !important; font-family: 'Menlo', 'Monaco', 'Consolas', monospace; white-space: pre; word-break: normal; overflow-wrap: normal; font-size: 14px; line-height: 1.5; }
    .navbar { position: fixed; top: 0; left: 0; right: 0; height: 60px; background: rgba(255,255,255,0.8); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); z-index: 1000; display: flex; align-items: center; padding: 0 20px; box-shadow: var(--shadow); transition: background-color 0.3s ease, border-color 0.3s ease; } [data-theme="dark"] .navbar { background: rgba(15, 23, 42, 0.8); } .nav-icon { font-size: 1.2rem; margin-right: 20px; color: var(--text); } .nav-links a { margin-right: 20px; font-size: 0.95rem; font-weight: 500; color: var(--text-light); } .nav-links a:hover, .nav-links a.active { color: var(--primary); } .nav-right { margin-left: auto; display: flex; align-items: center; gap: 10px; } .container { max-width: 1100px; margin: 40px auto; padding: 0 20px; }
    .btn { padding: 8px 16px; border-radius: 8px; border: none; background: var(--primary); color: white; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 0.9rem; text-decoration: none; transition: all 0.2s; box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2); } .btn:hover { opacity: 0.95; transform: translateY(-1px); box-shadow: 0 4px 6px rgba(37, 99, 235, 0.3); } .btn:disabled { opacity: 0.7; cursor: not-allowed; transform: none; } .btn-ghost { background: white; color: var(--text); border: 1px solid var(--border); box-shadow: none; } [data-theme="dark"] .btn-ghost { background: transparent; } .btn-ghost:hover { background: var(--bg); border-color: var(--text-light); } .btn-sm { padding: 4px 10px; font-size: 0.8rem; border-radius: 6px; } .btn-icon { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; color: var(--text-light); cursor: pointer; transition: all 0.2s; } .btn-icon:hover { background: var(--bg); color: var(--primary); } .btn-icon.delete:hover { color: var(--danger); background: #fef2f2; }
    .badge { display: inline-flex; align-items: center; background: var(--bg); color: var(--text-light); padding: 2px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 500; margin-right: 5px; border: 1px solid var(--border); } .badge-pin { background: var(--pin-bg); color: var(--pin-text); border-color: var(--pin-border); } .badge-cat { background: var(--primary-light); color: var(--primary); border-color: transparent; }
    .card { background: var(--card); border-radius: 16px; overflow: hidden; box-shadow: var(--shadow); border: 1px solid var(--border); transition: transform 0.2s, background-color 0.3s ease; } .card-hover:hover { transform: translateY(-3px); }
    .hero-banner { position: relative; width: 100%; height: 400px; background: url('${CONFIG.bannerUrl}') no-repeat center center/cover; display: flex; flex-direction: column; justify-content: center; align-items: center; color: white; text-align: center; margin-top: 60px; } .hero-banner::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.3); } .hero-content { position: relative; z-index: 1; } .hero-title { font-size: 3rem; font-weight: 800; margin: 0 0 10px 0; text-shadow: 0 2px 4px rgba(0,0,0,0.5); }
    .category-tabs { display: flex; justify-content: center; flex-wrap: wrap; padding: 25px 0 5px 0; gap: 12px; transition: background-color 0.3s ease; margin-bottom: 0; } .tab-item { padding: 8px 18px; border-radius: 50px; background: var(--card); color: var(--text-light); cursor: pointer; font-size: 0.9rem; transition: all 0.2s; font-weight: 500; box-shadow: 0 2px 8px rgba(0,0,0,0.04); border: 1px solid transparent; } [data-theme="dark"] .tab-item { border-color: var(--border); } .tab-item:hover { transform: translateY(-2px); color: var(--primary); box-shadow: 0 4px 12px rgba(0,0,0,0.08); } .tab-item.active { background: var(--primary); color: white; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3); }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; } .card-cover { width: 100%; height: 240px; object-fit: cover; display: block; }
    .dash-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 30px; } .welcome-text h1 { font-size: 1.8rem; margin: 0 0 5px 0; } .welcome-text p { color: var(--text-light); margin: 0; font-size: 0.95rem; }
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; } .stat-card { padding: 24px; display: flex; align-items: flex-start; justify-content: space-between; position: relative; overflow: hidden; } .stat-info { z-index: 1; } .stat-label { font-size: 0.9rem; color: var(--text-light); font-weight: 500; margin-bottom: 5px; } .stat-val { font-size: 2rem; font-weight: 700; color: var(--text); letter-spacing: -0.5px; } .stat-icon { width: 50px; height: 50px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; opacity: 0.9; } .stat-bg-icon { position: absolute; right: -20px; bottom: -20px; font-size: 8rem; opacity: 0.05; transform: rotate(-15deg); pointer-events: none; }
    .icon-blue { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; } .icon-orange { background: linear-gradient(135deg, #f59e0b, #d97706); color: white; } .icon-green { background: linear-gradient(135deg, #10b981, #059669); color: white; } .icon-purple { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; }
    .dash-section-title { font-size: 1.1rem; font-weight: 700; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; }
    .table-card { padding: 0; overflow: hidden; } .table-responsive { overflow-x: auto; } table { width: 100%; border-collapse: collapse; text-align: left; } th { background: var(--bg); color: var(--text-light); font-weight: 600; padding: 15px 20px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; } td { padding: 15px 20px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; } tr:last-child td { border-bottom: none; } tr:hover { background: var(--bg); } .post-title { font-weight: 600; font-size: 0.95rem; display: block; margin-bottom: 2px; } .post-meta { font-size: 0.8rem; color: var(--text-light); }
    .rank-list { padding: 20px; max-height: 520px; overflow-y: auto; } .rank-list::-webkit-scrollbar { width: 5px; } .rank-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; } .rank-list::-webkit-scrollbar-track { background: transparent; } .rank-item { display: flex; align-items: center; margin-bottom: 16px; } .rank-idx { width: 24px; height: 24px; border-radius: 50%; background: var(--bg); color: var(--text-light); font-size: 0.75rem; display: flex; align-items: center; justify-content: center; margin-right: 12px; font-weight: bold; flex-shrink: 0; } .rank-item:nth-child(1) .rank-idx { background: var(--rank-1); color: var(--rank-1-text); } .rank-item:nth-child(2) .rank-idx { background: var(--rank-2); color: var(--rank-2-text); } .rank-item:nth-child(3) .rank-idx { background: var(--rank-3); color: var(--rank-3-text); } .rank-info { flex: 1; overflow: hidden; } .rank-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.9rem; font-weight: 500; } .rank-views { font-size: 0.85rem; color: var(--text-light); text-align: right; margin-left: 10px; font-variant-numeric: tabular-nums; } .rank-bar { height: 6px; background: var(--bg); border-radius: 3px; margin-top: 6px; overflow: hidden; } .rank-fill { height: 100%; background: var(--primary); border-radius: 3px; }
    .login-wrapper { min-height: 100vh; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; background: #f0f2f5; } .login-bg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: url('${CONFIG.bannerUrl}') no-repeat center center/cover; opacity: 0.5; filter: blur(20px); transform: scale(1.1); z-index: 0; } .login-card { position: relative; z-index: 1; background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(20px); padding: 40px; width: 100%; max-width: 400px; border-radius: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.5); } [data-theme="dark"] .login-card { background: rgba(30, 41, 59, 0.9); border-color: rgba(255,255,255,0.1); } .input-group-modern { position: relative; margin-bottom: 20px; } .input-group-modern i { position: absolute; left: 16px; top: 50%; transform: translateY(-50%); color: var(--text-light); pointer-events: none; } .input-group-modern input { width: 100%; padding: 14px 14px 14px 48px; border: 2px solid transparent; background: var(--bg); border-radius: 12px; font-size: 1rem; color: var(--text); outline: none; transition: 0.3s; } .input-group-modern input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.1); } .btn-login { width: 100%; padding: 14px; font-size: 1rem; border-radius: 12px; background: linear-gradient(90deg, var(--primary), #4f46e5); box-shadow: 0 5px 15px rgba(37, 99, 235, 0.4); justify-content: center; }
    .comments-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid var(--border); } .comments-header h3 { margin: 0; font-size: 1.2rem; display: flex; align-items: center; gap: 8px; } .comment-list { display: flex; flex-direction: column; gap: 20px; margin-bottom: 40px; } .comment-item { display: flex; gap: 15px; animation: fadeIn 0.5s ease; } .c-avatar { width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg, var(--primary-light), var(--bg)); color: var(--primary); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.1rem; flex-shrink: 0; text-transform: uppercase; user-select: none; box-shadow: 0 2px 5px rgba(0,0,0,0.05); } .c-body { flex: 1; background: var(--bg); padding: 15px 20px; border-radius: 0 16px 16px 16px; position: relative; border: 1px solid var(--border); } [data-theme="dark"] .c-body { background: rgba(255,255,255,0.03); } .c-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; } .c-user { font-weight: 600; font-size: 0.95rem; color: var(--text); } .c-date { font-size: 0.75rem; color: var(--text-light); background: var(--card); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); } .c-content { font-size: 0.95rem; line-height: 1.6; color: var(--text); white-space: pre-wrap; word-break: break-all; } .comment-form-box { background: var(--bg); padding: 25px; border-radius: 16px; border: 1px solid var(--border); margin-top: 10px; position: relative; overflow: hidden; } .comment-form-box::before { content:''; position: absolute; top:0; left:0; width:4px; height:100%; background: var(--primary); } .c-input-grid { display: grid; gap: 15px; margin-bottom: 15px; } .c-input { width: 100%; padding: 12px 15px; border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 8px; outline: none; transition: all 0.2s; font-family: inherit; font-size: 0.95rem; } .c-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); } .c-textarea { min-height: 100px; resize: vertical; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .toast { position: fixed; bottom: 30px; right: 30px; background: #1e293b; color: #fff; padding: 12px 24px; border-radius: 8px; transform: translateY(100px); transition: 0.3s; z-index: 9999; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); } .toast.show { transform: translateY(0); }
    @media(max-width: 768px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } .editor-main { flex-direction: column; } .editor-textarea { border-right: none; border-bottom: 1px solid var(--border); } .settings-panel { grid-template-columns: 1fr; } .grid { grid-template-columns: 1fr; } .dash-header { flex-direction: column; align-items: flex-start; gap: 15px; } }

    /* ============================================================
       统一设计系统（覆盖层）
       统一的圆角 / 阴影 / 间距 / 表单控件 / 页面骨架，
       使前台与后台视觉语言保持一致。
       ============================================================ */

    :root {
        --primary-hover: #1d4ed8;
        --surface: #f8fafc;
        --surface-2: #f1f5f9;
        --text-faint: #94a3b8;
        --border-strong: #cbd5e1;
        --danger-bg: #fef2f2;
        --success-bg: #f0fdf4;
        --radius-sm: 8px; --radius: 12px; --radius-lg: 16px; --radius-xl: 24px;
        --shadow-sm: 0 1px 2px rgba(15, 23, 42, .06);
        --shadow-md: 0 6px 16px rgba(15, 23, 42, .08);
        --shadow-lg: 0 16px 40px rgba(15, 23, 42, .14);
        --ring: 0 0 0 3px rgba(37, 99, 235, .16);
        --banner: none;
    }
    [data-theme="dark"] {
        --primary-hover: #60a5fa;
        --surface: #1e293b;
        --surface-2: #334155;
        --text-faint: #64748b;
        --border-strong: #475569;
        --danger-bg: rgba(239, 68, 68, .12);
        --success-bg: rgba(34, 197, 94, .12);
        --shadow-sm: 0 1px 2px rgba(0, 0, 0, .4);
        --shadow-md: 0 6px 16px rgba(0, 0, 0, .45);
        --shadow-lg: 0 16px 40px rgba(0, 0, 0, .55);
        --ring: 0 0 0 3px rgba(59, 130, 246, .25);
    }

    /* --- 基础排版 --- */
    body { -webkit-font-smoothing: antialiased; }
    h1, h2, h3, h4 { letter-spacing: -.01em; }
    code, pre, .mono { font-family: 'Menlo', 'Monaco', 'Consolas', monospace; }
    :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    .hero-subtitle { font-size: 1.15rem; margin: 0; opacity: .92; text-shadow: 0 1px 3px rgba(0, 0, 0, .5); }
    .hero-banner { background: var(--banner) center center / cover no-repeat; }
    .login-bg { background: var(--banner) center center / cover no-repeat; }
    .card-body { padding: 24px; }

    /* --- 按钮：统一高度与圆角 --- */
    .btn { border-radius: var(--radius-sm); font-weight: 500; box-shadow: none; }
    .btn:hover { opacity: 1; transform: none; background: var(--primary-hover); box-shadow: var(--shadow-sm); }
    .btn:disabled { opacity: .55; }
    .btn-ghost { box-shadow: none; }
    .btn-ghost:hover { background: var(--surface-2); border-color: var(--border-strong); color: var(--text); }
    .btn-danger { background: var(--danger); }
    .btn-danger:hover { background: #dc2626; box-shadow: 0 4px 10px rgba(239, 68, 68, .3); }
    .btn-sm { padding: 5px 12px; }
    .btn-icon { border-radius: var(--radius-sm); }
    .btn-icon:hover { background: var(--surface-2); }
    .btn-icon.delete:hover { background: var(--danger-bg); }

    /* --- 卡片与徽标 --- */
    .card { border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
    .card-hover:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); }
    .badge { border-radius: 6px; padding: 3px 9px; font-weight: 500; }

    /* --- 表格：去掉全大写，收紧节奏 --- */
    th { padding: 12px 18px; font-size: .78rem; text-transform: none; letter-spacing: .02em; background: var(--surface-2); white-space: nowrap; }
    td { padding: 14px 18px; font-size: .9rem; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: var(--surface); }

    /* --- 登录页 --- */
    .login-wrapper { background: var(--bg); padding: 24px; }
    .login-card { padding: 36px; border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); }
    .login-header { text-align: center; margin-bottom: 28px; }
    .login-icon { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: var(--radius-lg); display: flex; align-items: center; justify-content: center; font-size: 1.4rem; color: #fff; background: linear-gradient(135deg, var(--primary), #4f46e5); box-shadow: 0 8px 20px rgba(37, 99, 235, .35); }
    .login-title { margin: 0 0 6px; font-size: 1.4rem; font-weight: 700; }
    .login-subtitle { margin: 0; color: var(--text-light); font-size: .9rem; }
    .input-group-modern input { border-radius: var(--radius); }
    .btn-login { border-radius: var(--radius); font-weight: 600; }

    /* --- 页面骨架：头部 + 子导航 --- */
    .page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; margin-bottom: 22px; }
    .page-title { margin: 0; font-size: 1.6rem; font-weight: 700; line-height: 1.3; }
    .page-sub { margin: 6px 0 0; color: var(--text-light); font-size: .92rem; }
    .page-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .admin-nav { display: flex; gap: 6px; flex-wrap: wrap; padding: 6px; margin-bottom: 22px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); }
    .admin-nav-item { display: inline-flex; align-items: center; gap: 8px; padding: 9px 16px; border-radius: var(--radius-sm); font-size: .9rem; font-weight: 500; color: var(--text-light); transition: all .18s; }
    .admin-nav-item:hover { background: var(--surface-2); color: var(--text); }
    .admin-nav-item.active { background: var(--primary); color: #fff; box-shadow: 0 2px 8px rgba(37, 99, 235, .3); }
    .admin-nav-item .nav-count { font-size: .75rem; padding: 1px 7px; border-radius: 999px; background: var(--surface-2); color: var(--text-light); }
    .admin-nav-item.active .nav-count { background: rgba(255, 255, 255, .22); color: #fff; }

    /* --- 区块标题 --- */
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .section-title { font-size: 1rem; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .section-title i { color: var(--primary); }
    .section-link { font-size: .85rem; color: var(--text-light); }
    .section-link:hover { color: var(--primary); }

    /* --- 工具条 / 表单控件 --- */
    .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .toolbar .spacer { flex: 1; }
    .search-box { position: relative; flex: 1; min-width: 180px; max-width: 320px; }
    .search-box i { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-faint); font-size: .85rem; pointer-events: none; }
    .search-box .input { padding-left: 34px; }
    .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
    .field-label { font-size: .85rem; font-weight: 500; color: var(--text-light); }
    .field-hint { font-size: .78rem; color: var(--text-faint); }
    .input, .select, .textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: var(--radius-sm); font-size: .92rem; font-family: inherit; outline: none; transition: border-color .18s, box-shadow .18s; }
    .input:focus, .select:focus, .textarea:focus { border-color: var(--primary); box-shadow: var(--ring); }
    .input::placeholder, .textarea::placeholder { color: var(--text-faint); }
    .input:disabled { background: var(--surface-2); color: var(--text-light); cursor: not-allowed; }
    .textarea { resize: vertical; min-height: 84px; line-height: 1.6; }
    .switch { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; font-size: .92rem; }
    .switch input { appearance: none; -webkit-appearance: none; width: 40px; height: 22px; border-radius: 999px; background: var(--border-strong); position: relative; cursor: pointer; transition: background .2s; flex-shrink: 0; margin: 0; }
    .switch input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .2s; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); }
    .switch input:checked { background: var(--primary); }
    .switch input:checked::after { transform: translateX(18px); }

    /* --- 空状态 / 分页 --- */
    .empty-state { text-align: center; padding: 56px 24px; color: var(--text-light); }
    .empty-state i { font-size: 2rem; color: var(--text-faint); display: block; margin-bottom: 12px; }
    .empty-state p { margin: 0 0 16px; font-size: .92rem; }
    .pager { display: flex; justify-content: center; align-items: center; gap: 6px; flex-wrap: wrap; padding: 16px 18px; border-top: 1px solid var(--border); }
    .pager-btn { min-width: 34px; height: 34px; padding: 0 11px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--card); color: var(--text-light); font-size: .86rem; cursor: pointer; transition: all .18s; }
    .pager-btn:hover { border-color: var(--primary); color: var(--primary); }
    .pager-btn.active { background: var(--primary); border-color: var(--primary); color: #fff; }
    .pager-btn:disabled { opacity: .45; cursor: not-allowed; }
    .pager-btn:disabled:hover { border-color: var(--border); color: var(--text-light); }
    .pager-info { font-size: .82rem; color: var(--text-faint); margin: 0 6px; }

    /* --- 统计卡片 --- */
    .stats-grid { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { padding: 20px; border-radius: var(--radius-lg); }
    .stat-val { font-size: 1.75rem; font-weight: 700; line-height: 1.2; }
    .stat-label { font-size: .85rem; margin-bottom: 6px; }
    .stat-icon { width: 42px; height: 42px; border-radius: var(--radius); font-size: 1.15rem; }
    .stat-foot { font-size: .78rem; color: var(--text-faint); margin-top: 8px; }
    .icon-pink { background: linear-gradient(135deg, #ec4899, #db2777); color: #fff; }

    /* --- 响应式两栏 --- */
    .split { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 20px; align-items: start; }
    .split-even { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; align-items: start; }

    /* --- 设置页：2×2 四宫格，四张卡片等宽等高 ---
       grid-auto-rows: 1fr 让所有行等分高度，align-items: stretch 让卡片撑满单元格，
       两者叠加后四个模块尺寸完全一致（内容较少的一侧会留白，属预期效果）。 */
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 1fr; gap: 20px; align-items: stretch; }
    .settings-grid > .card { display: flex; }
    .settings-grid > .card > .card-body { flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
    /* 铺开后最后一项不再需要下边距，否则底部会多出一截 */
    .settings-grid > .card > .card-body > .field:last-child { margin-bottom: 0; }
    /* 把动作行（如「更新密码」按钮）压到卡片底部，避免留白显得突兀 */
    .settings-grid .push-bottom { margin-top: auto; }

    /* --- 提示条 --- */
    .toast { display: flex; align-items: center; gap: 10px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-lg); font-size: .9rem; padding: 13px 18px; max-width: min(90vw, 400px); }
    .toast i { font-size: 1rem; color: var(--primary); flex-shrink: 0; }
    .toast.ok i { color: var(--success); }
    .toast.err i { color: var(--danger); }

    /* --- 确认弹窗 --- */
    .modal-mask { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(15, 23, 42, .45); backdrop-filter: blur(2px); opacity: 0; pointer-events: none; transition: opacity .2s; }
    .modal-mask.open { opacity: 1; pointer-events: auto; }
    .modal { width: 100%; max-width: 400px; padding: 24px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); transform: translateY(10px) scale(.98); transition: transform .2s; }
    .modal-mask.open .modal { transform: none; }
    .modal-title { margin: 0 0 8px; font-size: 1.05rem; font-weight: 600; }
    .modal-text { margin: 0 0 20px; color: var(--text-light); font-size: .92rem; line-height: 1.6; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; }

    /* --- 行内操作区 --- */
    .row-actions { display: flex; justify-content: flex-end; gap: 4px; }
    .mono-sm { font-family: 'Menlo', 'Monaco', 'Consolas', monospace; font-size: .82rem; color: var(--text-light); }

    @media(max-width: 900px) {
        .split, .split-even { grid-template-columns: 1fr; }
        /* 单列时取消等高，否则每张卡片都会被拉到最高那张的高度 */
        .settings-grid { grid-template-columns: 1fr; grid-auto-rows: auto; }
        .page-title { font-size: 1.35rem; }
        .admin-nav { gap: 4px; }
        .admin-nav-item { padding: 8px 12px; font-size: .85rem; }
    }
    @media(max-width: 600px) {
        .stats-grid { grid-template-columns: repeat(2, 1fr); }
        .toast { left: 16px; right: 16px; bottom: 16px; max-width: none; }
        th, td { padding: 11px 14px; }
    }
`;

// 基础 HTML 模版函数
const html = (title, content, user = null, ctx = {}) => {
    // 背景图通过 CSS 变量注入，这样「站点设置」里改了背景图能立刻生效
    const bannerUrl = String(CONFIG.bannerUrl || '');
    const bannerCss = (bannerUrl && !bannerUrl.includes('...'))
        ? ':root{--banner:url("' + bannerUrl.replace(/"/g, '') + '")}' : '';
    const isAdmin = String(ctx.page || '').startsWith('admin');

    return `
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)} - ${esc(CONFIG.name)}</title>

    ${CONFIG.googleVerify ? `<meta name="google-site-verification" content="${esc(CONFIG.googleVerify)}" />` : ''}

    <meta name="description" content="${esc(ctx.excerpt || CONFIG.desc)}">
    <link rel="icon" href="${esc(CONFIG.favicon)}">
    <link rel="apple-touch-icon" href="${esc(CONFIG.favicon)}">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown-light.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    ${ctx.useTurnstile ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}
    <style>${STYLES}${bannerCss}</style>
    <script>
        (function(){ const s = localStorage.getItem('theme'); const m = window.matchMedia('(prefers-color-scheme: dark)').matches; const t = s ? s : (m ? 'dark' : 'light'); document.documentElement.setAttribute('data-theme', t); })();
    </script>
    <script>
        // 选择器助手必须在 <head> 里提前定义。
        // 页面内容中的 <script> 会在解析阶段（DOMContentLoaded 之前）就调用 $ / $$，
        // 若把它们定义在 body 末尾，那些脚本会因执行顺序太晚而抛 "$ is not defined"，
        // 导致搜索、批量选择、下拉筛选等交互整体失效。
        const $ = s => document.querySelector(s);
        const $$ = s => Array.from(document.querySelectorAll(s));
    </script>
</head>
<body>
    ${ctx.page !== 'login' ? `
    <nav class="navbar">
        <a href="/" class="nav-icon" title="回到首页"><i class="fa-solid fa-layer-group"></i></a>
        <div class="nav-links"><a href="/" class="${!ctx.page ? 'active' : ''}">首页</a><a href="/about" class="${ctx.page === 'about' ? 'active' : ''}">关于</a></div>
        <div class="nav-right nav-links">
            <button id="theme-btn" class="btn-icon" style="background:transparent;border:none;margin-right:8px" onclick="toggleTheme()" title="切换主题"><i class="fa-solid fa-moon"></i></button>
            ${user
                ? `<a href="/admin/dashboard" class="${isAdmin ? 'active' : ''}"><i class="fa-solid fa-gauge-high"></i> 管理台</a><a href="/logout" class="btn-ghost" style="border:none; color:#dc3545; font-size:0.9rem" title="退出登录"><i class="fa-solid fa-power-off"></i></a>`
                : `<a href="/admin">登录</a>`}
        </div>
    </nav>` : ''}

    ${ctx.page === 'home' ? `
    <div class="hero-banner">
        <div class="hero-content"><h1 class="hero-title">${esc(CONFIG.name)}</h1><p class="hero-subtitle">${esc(CONFIG.desc)}</p></div>
    </div>
    <div class="category-tabs">${(ctx.categories || []).map(c => `<a href="${esc(c.url)}" class="tab-item ${c.active ? 'active' : ''}">${esc(c.name)}</a>`).join('')}</div>
    ` : ''}

    <div ${ctx.page === 'login' ? 'class="login-wrapper"' : 'class="container" id="main-container"'} ${ctx.page !== 'home' && ctx.page !== 'login' ? 'style="margin-top: 100px;"' : ''}>
        ${content}
        ${ctx.page === 'login' ? `<div class="login-bg"></div>` : ''}
    </div>

    <div id="toast"></div>
    <div class="modal-mask" id="modal-mask">
        <div class="modal">
            <h3 class="modal-title" id="modal-title">确认操作</h3>
            <p class="modal-text" id="modal-text"></p>
            <div class="modal-actions">
                <button class="btn btn-ghost" id="modal-cancel" type="button">取消</button>
                <button class="btn btn-danger" id="modal-ok" type="button">确定</button>
            </div>
        </div>
    </div>

    <script>
        // 注意：$ / $$ 已在 <head> 中提前定义（页面脚本在解析阶段就会用到），此处不要重复声明。

        // 统一的提示条：toast(msg, 'ok' | 'err')
        function toast(msg, type) {
            const el = $('#toast');
            if (!el) return;
            const icon = type === 'ok' ? 'fa-circle-check' : (type === 'err' ? 'fa-circle-exclamation' : 'fa-circle-info');
            el.className = 'toast' + (type ? ' ' + type : '');
            el.innerHTML = '<i class="fa-solid ' + icon + '"></i><span></span>';
            el.querySelector('span').textContent = msg;
            requestAnimationFrame(() => el.classList.add('show'));
            clearTimeout(el._timer);
            el._timer = setTimeout(() => el.classList.remove('show'), 2800);
        }

        // 统一确认弹窗，替代原生 confirm（返回 Promise<boolean>）
        function uiConfirm(text, opts) {
            opts = opts || {};
            return new Promise(resolve => {
                const mask = $('#modal-mask'), ok = $('#modal-ok'), cancel = $('#modal-cancel');
                $('#modal-title').textContent = opts.title || '确认操作';
                $('#modal-text').textContent = text;
                ok.textContent = opts.okText || '确定';
                ok.className = 'btn ' + (opts.danger === false ? '' : 'btn-danger');
                mask.classList.add('open');
                const done = v => {
                    mask.classList.remove('open');
                    ok.removeEventListener('click', onOk);
                    cancel.removeEventListener('click', onCancel);
                    mask.removeEventListener('click', onMask);
                    document.removeEventListener('keydown', onKey);
                    resolve(v);
                };
                const onOk = () => done(true), onCancel = () => done(false);
                const onMask = e => { if (e.target === mask) done(false); };
                const onKey = e => { if (e.key === 'Escape') done(false); };
                ok.addEventListener('click', onOk);
                cancel.addEventListener('click', onCancel);
                mask.addEventListener('click', onMask);
                document.addEventListener('keydown', onKey);
            });
        }

        // 复制：优先 clipboard API，非安全上下文回退 execCommand
        async function copyText(text) {
            try {
                if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                return ok;
            } catch (e) { return false; }
        }

        // 删除文章（后台多处复用）
        async function delPost(id, title) {
            const yes = await uiConfirm('删除后无法恢复，该文章及其全部评论会被一并删除。', { title: '删除《' + title + '》？', okText: '确认删除' });
            if (!yes) return false;
            try {
                const r = await fetch('/api/posts?id=' + encodeURIComponent(id), { method: 'DELETE' });
                if (r.ok) { toast('文章已删除', 'ok'); setTimeout(() => location.reload(), 700); return true; }
                toast('删除失败', 'err');
            } catch (e) { toast('网络错误', 'err'); }
            return false;
        }

        // 统一用事件委托处理后台的「行内操作」，避免把 id / 标题拼进 onclick 字符串
        // （标题里只要有一个单引号，拼字符串的写法就会把整段脚本打断）
        document.addEventListener('click', e => {
            const el = e.target.closest('[data-act]');
            if (!el) return;
            const act = el.dataset.act;
            if (act === 'del-post') { e.preventDefault(); delPost(el.dataset.id, el.dataset.title || '未命名'); }
            else if (act === 'toggle-pin') { e.preventDefault(); if (typeof togglePin === 'function') togglePin(el.dataset.id, el.dataset.next === 'true', el); }
            else if (act === 'del-comment') { e.preventDefault(); if (typeof delComment === 'function') delComment(el.dataset.post, el.dataset.cid); }
            else if (act === 'clear-comments') { e.preventDefault(); if (typeof clearComments === 'function') clearComments(el.dataset.post); }
        });

        window.toggleTheme = function() { const r = document.documentElement; const n = r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; r.setAttribute('data-theme', n); localStorage.setItem('theme', n); updateThemeIcon(n); }
        function updateThemeIcon(t) { const icon = document.querySelector('#theme-btn i'); if(icon) icon.className = t === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; }
        document.addEventListener('DOMContentLoaded', () => {
            const cur = document.documentElement.getAttribute('data-theme'); updateThemeIcon(cur);
            const md = $('#markdown-content');
            if(md && window._RAW_MD) {
                md.innerHTML = marked.parse(window._RAW_MD);
                md.querySelectorAll('pre code').forEach((el) => { if(el.textContent.length > 10000) return; hljs.highlightElement(el); });
            }
            if(window.initEditor) window.initEditor();
            if(window.pageInit) window.pageInit();
        });
    </script>
</body>
</html>
`;
};

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        const path = url.pathname;
        let config = null;
        try { config = await (await env.BLOG_BUCKET.get('sys/config.json')).json(); } catch (e) { }
        // 站点设置覆盖 CONFIG 默认值（在渲染任何页面前应用）
        applySettings(await loadSettings(env));
        // 若用 `wrangler secret put TURNSTILE_SECRET_KEY` 注入了密钥，它的优先级最高：
        // 密钥不落盘、不出现在 R2 里，比存 sys/settings.json 更安全。
        if (env.TURNSTILE_SECRET_KEY) CONFIG.turnstileSecretKey = env.TURNSTILE_SECRET_KEY;

        // 1. 初始化检查
        if (!config && path !== '/api/install' && !path.startsWith('/images/')) {
            return response.html(html('系统安装', `
                <div class="login-card">
                    <div class="login-header">
                        <div class="login-icon"><i class="fa-solid fa-rocket"></i></div>
                        <h2 class="login-title">初始化站点</h2>
                        <p class="login-subtitle">设置管理员账号与密码，完成后即可开始写作</p>
                    </div>
                    <form onsubmit="event.preventDefault();inst()">
                        <div class="input-group-modern">
                            <input id="u" placeholder="管理员用户名" required autocomplete="username">
                            <i class="fa-solid fa-user"></i>
                        </div>
                        <div class="input-group-modern">
                            <input id="p" type="password" placeholder="管理员密码（至少 6 位）" required minlength="6" autocomplete="new-password">
                            <i class="fa-solid fa-lock"></i>
                        </div>
                        <button type="submit" id="inst-btn" class="btn btn-login">完成安装 <i class="fa-solid fa-arrow-right" style="margin-left:6px"></i></button>
                    </form>
                </div>
                <script>
                    async function inst() {
                        const btn = $('#inst-btn');
                        const raw = btn.innerHTML;
                        const u = $('#u').value.trim(), p = $('#p').value;
                        if (!u || !p) return toast('请填写用户名和密码', 'err');
                        if (p.length < 6) return toast('密码至少 6 位', 'err');
                        btn.disabled = true;
                        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 配置中…';
                        try {
                            const res = await fetch('/api/install', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ u, p })
                            });
                            if (res.ok) {
                                toast('安装成功，正在进入后台…', 'ok');
                                setTimeout(() => location.href = '/admin', 900);
                                return;
                            }
                            toast('安装失败，请重试', 'err');
                        } catch (e) {
                            toast('网络错误：' + (e && e.message ? e.message : '请检查连接'), 'err');
                        }
                        btn.disabled = false;
                        btn.innerHTML = raw;
                    }
                </script>
            `, null, { page: 'login' }));
        }

        // 2. 身份验证
        const cookie = req.headers.get('Cookie') || '';
        let user = null, sessions = [];
        try { const sObj = await env.BLOG_BUCKET.get('sys/sessions.json'); if (sObj) sessions = await sObj.json(); } catch (e) { }
        const tokenMatch = cookie.match(/auth=([^;]+)/);
        if (tokenMatch && config) {
            const token = tokenMatch[1];
            const validSession = sessions.find(s => s.token === token && new Date(s.expires) > new Date());
            if (validSession) user = { name: config.username };
        }

        // --- API 路由区域 ---
        if (path === '/api/install' && !config) {
            const b = await req.json();
            await env.BLOG_BUCKET.put('sys/config.json', JSON.stringify({ username: b.u, passwordHash: await hash(b.p) }));
            return response.html('ok');
        }

        if (path === '/api/login') {
            const b = await req.json();
            const ip = req.headers.get('CF-Connecting-IP');
            if (turnstileEnabled()) {
                if (!(await verifyTurnstile(b.turnstileToken, CONFIG.turnstileSecretKey, ip))) return response.error('Captcha Failed', 403);
            }
            if (b.u === config.username && await hash(b.p) === config.passwordHash) {
                const token = crypto.randomUUID(), expires = new Date();
                expires.setDate(expires.getDate() + 7);
                const cleanSessions = sessions.filter(s => new Date(s.expires) > new Date());
                cleanSessions.push({ token, expires: expires.toISOString(), ip });
                await env.BLOG_BUCKET.put('sys/sessions.json', JSON.stringify(cleanSessions));
                return response.redirect('/', `auth=${token}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`);
            }
            await new Promise(r => setTimeout(r, 2000));
            return response.error('err', 401);
        }

        if (path === '/logout') {
            if (tokenMatch) {
                const remaining = sessions.filter(s => s.token !== tokenMatch[1]);
                ctx.waitUntil(env.BLOG_BUCKET.put('sys/sessions.json', JSON.stringify(remaining)));
            }
            return response.redirect('/', 'auth=; Path=/; Max-Age=0; HttpOnly; Secure');
        }

        // --- 文章 API ---
        if (path === '/api/posts' && user) {
            if (req.method === 'DELETE') {
                const idsParam = url.searchParams.get('ids');
                const ids = idsParam ? idsParam.split(',').filter(Boolean) : [url.searchParams.get('id')].filter(Boolean);
                if (!ids.length) return response.error('missing id', 400);
                for (const raw of ids) {
                    const id = safeKey(raw);
                    await env.BLOG_BUCKET.delete(`posts/${id}.json`);
                    await env.BLOG_BUCKET.delete(`comments/${id}.json`);
                }
                return response.json({ ok: true, deleted: ids.length });
            }
            const b = await req.json();
            const content = b.content || '';
            const id = safeKey(b.slug || b.id || Date.now().toString());
            let views = 0;
            const oldObj = await env.BLOG_BUCKET.get(`posts/${id}.json`);
            if (oldObj) { const old = await oldObj.json(); views = old.views || 0; }
            const post = {
                id, title: b.title, content, tags: b.tags, cover: b.cover, slug: id,
                category: b.category || '默认', isPinned: b.isPinned || false,
                date: b.date || new Date().toISOString(), views,
                excerpt: content.substring(0, 120).replace(/[#*`\[\]]/g, '') + '...'
            };
            await env.BLOG_BUCKET.put(`posts/${id}.json`, JSON.stringify(post));
            return response.json({ ok: true, id });
        }

        // 置顶开关（列表页直接切换，不必进编辑器）
        if (path === '/api/pin' && req.method === 'POST' && user) {
            const b = await req.json();
            const key = `posts/${safeKey(b.id)}.json`;
            const o = await env.BLOG_BUCKET.get(key);
            if (!o) return response.error('not found', 404);
            const p = await o.json();
            p.isPinned = !!b.isPinned;
            await env.BLOG_BUCKET.put(key, JSON.stringify(p));
            return response.json({ ok: true, isPinned: p.isPinned });
        }

        // --- 评论 API ---
        if (path === '/api/comment' && req.method === 'POST') {
            const b = await req.json();
            const key = `comments/${safeKey(b.postId)}.json`;
            let comments = []; try { comments = await (await env.BLOG_BUCKET.get(key)).json(); } catch (e) { }
            comments.push({ id: crypto.randomUUID(), user: b.user || '访客', content: b.content, date: new Date().toISOString() });
            await env.BLOG_BUCKET.put(key, JSON.stringify(comments));
            return response.html('ok');
        }

        if (path === '/api/comment' && req.method === 'DELETE' && user) {
            const postId = safeKey(url.searchParams.get('postId'));
            const key = `comments/${postId}.json`;
            let comments = []; try { comments = await (await env.BLOG_BUCKET.get(key)).json(); } catch (e) { }
            const before = comments.length;

            if (url.searchParams.get('all')) {
                await env.BLOG_BUCKET.delete(key);
                return response.json({ ok: true, deleted: before });
            }
            const cid = url.searchParams.get('id');
            const idx = url.searchParams.get('index');
            if (cid) comments = comments.filter(c => c.id !== cid);
            else if (idx !== null && idx !== '') comments.splice(Number(idx), 1);
            else return response.error('missing id', 400);

            if (comments.length === before) return response.error('not found', 404);
            await env.BLOG_BUCKET.put(key, JSON.stringify(comments));
            return response.json({ ok: true, deleted: 1 });
        }

        // --- 站点设置 / 改密 ---
        if (path === '/api/settings' && req.method === 'POST' && user) {
            const b = await req.json();
            const current = (await loadSettings(env)) || {};
            for (const k of SETTING_KEYS) {
                if (b[k] !== undefined) current[k] = String(b[k]).trim();
            }
            current.pageSize = Math.min(Math.max(parseInt(current.pageSize, 10) || 6, 1), 50);
            await env.BLOG_BUCKET.put('sys/settings.json', JSON.stringify(current));
            return response.json({ ok: true });
        }

        if (path === '/api/password' && req.method === 'POST' && user) {
            const b = await req.json();
            if (await hash(b.current || '') !== config.passwordHash) return response.error('当前密码不正确', 403);
            if (!b.next || String(b.next).length < 6) return response.error('新密码至少 6 位', 400);
            await env.BLOG_BUCKET.put('sys/config.json', JSON.stringify({ username: config.username, passwordHash: await hash(b.next) }));
            // 改密后让所有已登录会话失效
            await env.BLOG_BUCKET.put('sys/sessions.json', JSON.stringify([]));
            return response.json({ ok: true });
        }

        // --- 媒体 API ---
        if (path === '/api/upload' && user) {
            const f = (await req.formData()).get('file');
            if (!f || typeof f === 'string') return response.error('no file', 400);
            if (!String(f.type || '').startsWith('image/')) return response.error('仅支持图片', 400);
            const k = `images/${Date.now()}-${safeFileName(f.name)}`;
            await env.BLOG_BUCKET.put(k, f);
            return response.json({ url: `/${k}`, key: k });
        }

        if (path === '/api/media' && req.method === 'DELETE' && user) {
            const keysParam = url.searchParams.get('keys');
            const keys = keysParam ? keysParam.split(',').filter(Boolean) : [url.searchParams.get('key')].filter(Boolean);
            for (const k of keys) {
                if (String(k).startsWith('images/')) await env.BLOG_BUCKET.delete(k);
            }
            return response.json({ ok: true, deleted: keys.length });
        }

        // --- 静态文件与 RSS ---
        if (path.startsWith('/images/')) {
            const o = await env.BLOG_BUCKET.get(path.substring(1));
            return o ? response.asset(o.body, o.httpMetadata?.contentType) : response.error('404', 404);
        }
        if (path === '/rss.xml') {
            const posts = (await loadAllPosts(env)).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);
            const x = (v) => String(v === undefined || v === null ? '' : v)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
            const base = String(CONFIG.url || '').replace(/\/+$/, '');
            const xml = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>'
                + '<title>' + x(CONFIG.name) + '</title>'
                + '<link>' + x(base) + '</link>'
                + '<description>' + x(CONFIG.desc) + '</description>'
                + '<generator>Cloudflare Workers Blog</generator>'
                + '<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>'
                + posts.map(p => '<item>'
                    + '<title>' + x(p.title) + '</title>'
                    + '<link>' + x(base + '/post/' + encodeURIComponent(p.id)) + '</link>'
                    + '<description>' + x(p.excerpt) + '</description>'
                    + '<pubDate>' + new Date(p.date).toUTCString() + '</pubDate>'
                    + '<guid isPermaLink="false">' + x(p.id) + '</guid>'
                    + '</item>').join('')
                + '</channel></rss>';
            return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
        }

        // --- 页面路由区域 ---

        // 1. 管理后台
        if (path === '/admin') {
            if (user) return response.redirect('/admin/dashboard');
            const hasTurnstile = turnstileEnabled();
            return response.html(html('后台登录', `
              <div class="login-card">
                  <div class="login-header"><div class="login-icon"><i class="fa-solid fa-user-shield"></i></div><h2 class="login-title">管理员登录</h2><p class="login-subtitle">欢迎回来，请验证身份以继续</p></div>
                  <form onsubmit="event.preventDefault();login()">
                      <div class="input-group-modern"><input id="u" placeholder="用户名" required autocomplete="username"><i class="fa-solid fa-user"></i></div>
                      <div class="input-group-modern"><input id="p" type="password" placeholder="密码" required autocomplete="current-password"><i class="fa-solid fa-lock"></i></div>
                      ${hasTurnstile ? `<div style="display:flex;justify-content:center;margin-bottom:20px;min-height:65px;"><div class="cf-turnstile" data-sitekey="${CONFIG.turnstileSiteKey}"></div></div>` : ''}
                      <button type="submit" id="login-btn" class="btn btn-login">立即登录 <i class="fa-solid fa-arrow-right" style="margin-left:5px"></i></button>
                  </form>
              </div>
              <script>
                async function login() {
                    const btn = $('#login-btn');
                    const u = $('#u').value.trim(), p = $('#p').value;
                    if (!u || !p) return toast('请输入用户名和密码');
                    let t = '';
                    const tsBox = $('.cf-turnstile');
                    if (tsBox) {
                        if (typeof turnstile === 'undefined') return toast('人机验证组件尚未加载完成，请稍后重试');
                        t = turnstile.getResponse();
                        if (!t) return toast('请先完成人机验证');
                    }
                    const rawHtml = btn.innerHTML;
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 验证中...';
                    try {
                        const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u, p, turnstileToken: t }) });
                        if (res.ok) { toast('登录成功'); setTimeout(() => location.href = '/admin/dashboard', 500); return; }
                        toast(res.status === 403 ? '人机验证未通过，请重试' : '用户名或密码错误');
                        if (tsBox && typeof turnstile !== 'undefined') turnstile.reset();
                    } catch (e) {
                        toast('网络错误：' + (e && e.message ? e.message : '请检查网络连接'));
                    }
                    btn.disabled = false;
                    btn.innerHTML = rawHtml;
                }
              </script>`, null, { useTurnstile: hasTurnstile, page: 'login' }));
        }

        // 概览
        if (path === '/admin/dashboard' && user) {
            const posts = await loadAllPosts(env);
            const comments = await loadAllComments(env);
            const media = await loadAllMedia(env);
            const totalViews = posts.reduce((sum, p) => sum + (p.views || 0), 0);
            const pinnedCount = posts.filter(p => p.isPinned).length;
            const recent = [...posts].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
            const topPosts = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5);
            const maxViews = topPosts[0]?.views || 1;
            const hour = (new Date().getUTCHours() + 8) % 24;
            const greeting = hour < 6 ? '凌晨好' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';

            const kpi = (label, value, foot, icon, cls) => `
                <div class="card stat-card">
                    <div class="stat-info">
                        <div class="stat-label">${label}</div>
                        <div class="stat-val">${value}</div>
                        <div class="stat-foot">${foot}</div>
                    </div>
                    <div class="stat-icon ${cls}"><i class="fa-solid ${icon}"></i></div>
                </div>`;

            const recentRows = recent.map(p => `
                <tr>
                    <td>
                        <a href="/post/${encodeURIComponent(p.id)}" target="_blank" class="post-title">${esc(p.title)}</a>
                        <div class="post-meta">${new Date(p.date).toLocaleDateString('zh-CN')} · ${esc(p.category || '默认')}</div>
                    </td>
                    <td>${p.isPinned ? '<span class="badge badge-pin">置顶</span>' : '<span class="badge">常规</span>'}</td>
                    <td style="color:var(--text-light)"><i class="fa-regular fa-eye"></i> ${p.views || 0}</td>
                    <td>
                        <div class="row-actions">
                            <a href="/admin/edit?id=${encodeURIComponent(p.id)}" class="btn-icon" title="编辑"><i class="fa-solid fa-pen"></i></a>
                            <button class="btn-icon delete" title="删除" data-act="del-post" data-id="${esc(p.id)}" data-title="${esc(p.title)}"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </td>
                </tr>`).join('');

            const rankRows = topPosts.map((p, idx) => `
                <div class="rank-item">
                    <div class="rank-idx">${idx + 1}</div>
                    <div class="rank-info">
                        <div style="display:flex;justify-content:space-between;gap:10px">
                            <div class="rank-title">${esc(p.title)}</div>
                            <div class="rank-views">${p.views || 0}</div>
                        </div>
                        <div class="rank-bar"><div class="rank-fill" style="width:${((p.views || 0) / maxViews) * 100}%"></div></div>
                    </div>
                </div>`).join('');

            return response.html(html('概览', `
                ${adminNav('dash', { posts: posts.length, comments: comments.length, media: media.length })}
                ${pageHead(greeting + '，' + esc(user.name), '这是你博客的整体运行情况。',
                    '<a href="/admin/edit" class="btn"><i class="fa-solid fa-pen-nib"></i> 写文章</a>'
                    + '<a href="/" target="_blank" class="btn btn-ghost"><i class="fa-solid fa-arrow-up-right-from-square"></i> 查看站点</a>')}
                <div class="stats-grid">
                    ${kpi('文章', posts.length, pinnedCount ? '其中置顶 ' + pinnedCount + ' 篇' : '暂无置顶文章', 'fa-file-lines', 'icon-blue')}
                    ${kpi('评论', comments.length, comments.length ? '最新 ' + new Date([...comments].sort((a, b) => new Date(b.date) - new Date(a.date))[0].date).toLocaleDateString('zh-CN') : '还没有评论', 'fa-comments', 'icon-purple')}
                    ${kpi('总阅读', totalViews, posts.length ? '篇均 ' + Math.round(totalViews / posts.length) : '暂无数据', 'fa-eye', 'icon-orange')}
                    ${kpi('图片', media.length, 'R2 存储桶内', 'fa-image', 'icon-green')}
                </div>
                <div class="split">
                    <div>
                        <div class="section-head">
                            <div class="section-title"><i class="fa-solid fa-clock-rotate-left"></i> 最近文章</div>
                            <a href="/admin/posts" class="section-link">全部文章 <i class="fa-solid fa-chevron-right" style="font-size:.7rem"></i></a>
                        </div>
                        <div class="card table-card">
                            ${recent.length ? `<div class="table-responsive"><table>
                                <thead><tr><th>文章</th><th>状态</th><th>阅读</th><th style="text-align:right">操作</th></tr></thead>
                                <tbody>${recentRows}</tbody>
                            </table></div>` : emptyState('fa-file-pen', '还没有文章，写下第一篇吧。', '<a href="/admin/edit" class="btn btn-sm"><i class="fa-solid fa-pen-nib"></i> 写文章</a>')}
                        </div>
                    </div>
                    <div>
                        <div class="section-head">
                            <div class="section-title"><i class="fa-solid fa-fire"></i> 阅读排行</div>
                        </div>
                        <div class="card rank-list">
                            ${rankRows || emptyState('fa-chart-simple', '暂无阅读数据')}
                        </div>
                    </div>
                </div>
            `, user, { page: 'admin' }));
        }

        // 文章管理
        if (path === '/admin/posts' && user) {
            const posts = await loadAllPosts(env);
            const comments = await loadAllComments(env);
            const media = await loadAllMedia(env);
            const cats = [...new Set(posts.map(p => p.category || '默认'))];
            const q = (url.searchParams.get('q') || '').trim();
            const cat = url.searchParams.get('cat') || '';
            const page = Math.max(1, parseInt(url.searchParams.get('p'), 10) || 1);
            const size = 10;

            let filtered = [...posts].sort((a, b) => (a.isPinned !== b.isPinned) ? (a.isPinned ? -1 : 1) : new Date(b.date) - new Date(a.date));
            if (cat) filtered = filtered.filter(p => (p.category || '默认') === cat);
            if (q) {
                const kw = q.toLowerCase();
                filtered = filtered.filter(p => (p.title || '').toLowerCase().includes(kw)
                    || (p.content || '').toLowerCase().includes(kw)
                    || (p.tags || '').toLowerCase().includes(kw));
            }
            const total = filtered.length;
            const pages = Math.max(1, Math.ceil(total / size));
            const cur = Math.min(page, pages);
            const slice = filtered.slice((cur - 1) * size, cur * size);

            const buildUrl = (n) => {
                const u = new URLSearchParams();
                if (q) u.set('q', q);
                if (cat) u.set('cat', cat);
                if (n > 1) u.set('p', n);
                const s = u.toString();
                return '/admin/posts' + (s ? '?' + s : '');
            };

            const rows = slice.map(p => `
                <tr data-id="${esc(p.id)}">
                    <td style="width:44px"><input type="checkbox" class="pick" value="${esc(p.id)}" style="transform:scale(1.15);cursor:pointer"></td>
                    <td>
                        <a href="/post/${encodeURIComponent(p.id)}" target="_blank" class="post-title">${esc(p.title)}</a>
                        <div class="post-meta mono-sm">/${esc(p.id)} · ${new Date(p.date).toLocaleDateString('zh-CN')}</div>
                    </td>
                    <td><span class="badge badge-cat">${esc(p.category || '默认')}</span></td>
                    <td><span style="color:var(--text-light)"><i class="fa-regular fa-eye"></i> ${p.views || 0}</span></td>
                    <td>
                        <button class="btn-icon" title="${p.isPinned ? '取消置顶' : '设为置顶'}"
                            data-act="toggle-pin" data-id="${esc(p.id)}" data-next="${p.isPinned ? 'false' : 'true'}">
                            <i class="fa-solid fa-thumbtack" style="${p.isPinned ? 'color:var(--pinned)' : ''}"></i>
                        </button>
                    </td>
                    <td>
                        <div class="row-actions">
                            <a href="/admin/edit?id=${encodeURIComponent(p.id)}" class="btn-icon" title="编辑"><i class="fa-solid fa-pen"></i></a>
                            <button class="btn-icon delete" title="删除" data-act="del-post" data-id="${esc(p.id)}" data-title="${esc(p.title)}"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </td>
                </tr>`).join('');

            const pager = pages > 1 ? `
                <div class="pager">
                    <button class="pager-btn" ${cur <= 1 ? 'disabled' : ''} onclick="location.href='${buildUrl(cur - 1)}'"><i class="fa-solid fa-chevron-left"></i></button>
                    ${Array.from({ length: pages }, (_, i) => i + 1)
                        .filter(n => n === 1 || n === pages || Math.abs(n - cur) <= 2)
                        .map((n, i, arr) => (i > 0 && n - arr[i - 1] > 1 ? '<span class="pager-info">…</span>' : '')
                            + `<button class="pager-btn ${n === cur ? 'active' : ''}" onclick="location.href='${buildUrl(n)}'">${n}</button>`)
                        .join('')}
                    <button class="pager-btn" ${cur >= pages ? 'disabled' : ''} onclick="location.href='${buildUrl(cur + 1)}'"><i class="fa-solid fa-chevron-right"></i></button>
                    <span class="pager-info">共 ${total} 篇</span>
                </div>` : '';

            return response.html(html('文章管理', `
                ${adminNav('posts', { posts: posts.length, comments: comments.length, media: media.length })}
                ${pageHead('文章管理', '共 ' + posts.length + ' 篇文章' + (q || cat ? '，筛选出 ' + total + ' 篇' : ''),
                    '<a href="/admin/edit" class="btn"><i class="fa-solid fa-plus"></i> 写文章</a>')}
                <div class="toolbar">
                    <div class="search-box">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input id="q" class="input" placeholder="搜索标题、正文或标签…" value="${esc(q)}">
                    </div>
                    <select id="cat" class="select" style="width:auto;min-width:130px">
                        <option value="">全部分类</option>
                        ${cats.map(c => `<option value="${esc(c)}" ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}
                    </select>
                    <button class="btn btn-ghost" onclick="applyFilter()"><i class="fa-solid fa-filter"></i> 筛选</button>
                    ${(q || cat) ? '<a href="/admin/posts" class="btn btn-ghost"><i class="fa-solid fa-xmark"></i> 重置</a>' : ''}
                    <div class="spacer"></div>
                    <span id="sel-info" class="pager-info"></span>
                    <button class="btn btn-ghost btn-sm" id="batch-del" style="display:none" onclick="batchDelete()"><i class="fa-solid fa-trash"></i> 删除选中</button>
                </div>
                <div class="card table-card">
                    ${slice.length ? `<div class="table-responsive"><table>
                        <thead><tr>
                            <th><input type="checkbox" id="pick-all" style="transform:scale(1.15);cursor:pointer"></th>
                            <th>文章</th><th>分类</th><th>阅读</th><th>置顶</th><th style="text-align:right">操作</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table></div>${pager}`
                    : emptyState(q || cat ? 'fa-magnifying-glass' : 'fa-file-pen',
                        q || cat ? '没有找到匹配的文章，换个关键词试试。' : '还没有文章，写下第一篇吧。',
                        q || cat ? '<a href="/admin/posts" class="btn btn-sm btn-ghost">清空筛选</a>' : '<a href="/admin/edit" class="btn btn-sm"><i class="fa-solid fa-pen-nib"></i> 写文章</a>')}
                </div>
                <script>
                    function applyFilter() {
                        const u = new URLSearchParams();
                        const q = $('#q').value.trim(), cat = $('#cat').value;
                        if (q) u.set('q', q);
                        if (cat) u.set('cat', cat);
                        location.href = '/admin/posts' + (u.toString() ? '?' + u.toString() : '');
                    }
                    $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') applyFilter(); });
                    $('#cat').addEventListener('change', applyFilter);

                    async function togglePin(id, next, btn) {
                        btn.disabled = true;
                        try {
                            const r = await fetch('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, isPinned: next }) });
                            if (r.ok) { toast(next ? '已置顶' : '已取消置顶', 'ok'); setTimeout(() => location.reload(), 600); }
                            else { toast('操作失败', 'err'); btn.disabled = false; }
                        } catch (e) { toast('网络错误', 'err'); btn.disabled = false; }
                    }

                    const picks = () => $$('.pick').filter(c => c.checked).map(c => c.value);
                    function refreshSel() {
                        const n = picks().length;
                        $('#sel-info').textContent = n ? '已选 ' + n + ' 篇' : '';
                        $('#batch-del').style.display = n ? '' : 'none';
                    }
                    document.addEventListener('change', e => {
                        if (e.target.id === 'pick-all') $$('.pick').forEach(c => { c.checked = e.target.checked; });
                        if (e.target.classList.contains('pick') || e.target.id === 'pick-all') refreshSel();
                    });
                    async function batchDelete() {
                        const ids = picks();
                        if (!ids.length) return;
                        const yes = await uiConfirm('将删除选中的 ' + ids.length + ' 篇文章及其全部评论，此操作不可恢复。', { title: '批量删除？', okText: '确认删除' });
                        if (!yes) return;
                        try {
                            const r = await fetch('/api/posts?ids=' + encodeURIComponent(ids.join(',')), { method: 'DELETE' });
                            if (r.ok) { toast('已删除 ' + ids.length + ' 篇', 'ok'); setTimeout(() => location.reload(), 700); }
                            else toast('删除失败', 'err');
                        } catch (e) { toast('网络错误', 'err'); }
                    }
                </script>
            `, user, { page: 'admin' }));
        }

        // 评论管理
        if (path === '/admin/comments' && user) {
            const posts = await loadAllPosts(env);
            const comments = await loadAllComments(env);
            const media = await loadAllMedia(env);
            const titleOf = (id) => (posts.find(p => p.id === id) || {}).title || id;

            const grouped = {};
            comments.forEach(c => { (grouped[c.postId] = grouped[c.postId] || []).push(c); });
            const groups = Object.entries(grouped)
                .sort((a, b) => new Date(b[1][0].date) - new Date(a[1][0].date));

            const groupsHtml = groups.map(([postId, list]) => {
                list.sort((a, b) => new Date(b.date) - new Date(a.date));
                const items = list.map(c => `
                    <div class="comment-item">
                        <div class="c-avatar">${esc(String(c.user || '访').charAt(0).toUpperCase())}</div>
                        <div class="c-body">
                            <div class="c-head">
                                <span class="c-user">${esc(c.user || '访客')}</span>
                                <span style="display:flex;align-items:center;gap:8px">
                                    <span class="c-date">${new Date(c.date).toLocaleString('zh-CN')}</span>
                                    <button class="btn-icon delete" title="删除这条评论"
                                        data-act="del-comment" data-post="${esc(postId)}" data-cid="${esc(c.cid)}">
                                        <i class="fa-solid fa-trash"></i>
                                    </button>
                                </span>
                            </div>
                            <div class="c-content">${esc(c.content)}</div>
                        </div>
                    </div>`).join('');

                return `
                <div class="card" style="margin-bottom:18px">
                    <div class="comments-header" style="margin:0;padding:16px 20px">
                        <h3 style="font-size:1rem">
                            <i class="fa-regular fa-file-lines"></i>
                            <a href="/post/${encodeURIComponent(postId)}" target="_blank">${esc(titleOf(postId))}</a>
                            <span class="badge badge-cat">${list.length}</span>
                        </h3>
                        <button class="btn btn-ghost btn-sm" data-act="clear-comments" data-post="${esc(postId)}">
                            <i class="fa-solid fa-broom"></i> 清空
                        </button>
                    </div>
                    <div style="padding:20px;display:flex;flex-direction:column;gap:18px">${items}</div>
                </div>`;
            }).join('');

            return response.html(html('评论管理', `
                ${adminNav('comments', { posts: posts.length, comments: comments.length, media: media.length })}
                ${pageHead('评论管理', '共 ' + comments.length + ' 条评论，分布在 ' + groups.length + ' 篇文章下。')}
                ${groupsHtml || '<div class="card">' + emptyState('fa-comments', '还没有收到评论。') + '</div>'}
                <script>
                    async function delComment(postId, cid) {
                        const yes = await uiConfirm('删除后无法恢复。', { title: '删除这条评论？', okText: '确认删除' });
                        if (!yes) return;
                        try {
                            const r = await fetch('/api/comment?postId=' + encodeURIComponent(postId) + '&id=' + encodeURIComponent(cid), { method: 'DELETE' });
                            if (r.ok) { toast('评论已删除', 'ok'); setTimeout(() => location.reload(), 600); }
                            else toast('删除失败', 'err');
                        } catch (e) { toast('网络错误', 'err'); }
                    }
                    async function clearComments(postId) {
                        const yes = await uiConfirm('该文章下的全部评论都会被删除，此操作不可恢复。', { title: '清空这篇的评论？', okText: '确认清空' });
                        if (!yes) return;
                        try {
                            const r = await fetch('/api/comment?postId=' + encodeURIComponent(postId) + '&all=1', { method: 'DELETE' });
                            if (r.ok) { toast('已清空', 'ok'); setTimeout(() => location.reload(), 600); }
                            else toast('操作失败', 'err');
                        } catch (e) { toast('网络错误', 'err'); }
                    }
                </script>
            `, user, { page: 'admin' }));
        }

        // 站点设置
        if (path === '/admin/settings' && user) {
            const posts = await loadAllPosts(env);
            const comments = await loadAllComments(env);
            const media = await loadAllMedia(env);
            const saved = (await loadSettings(env)) || {};
            const val = (k) => esc(saved[k] !== undefined ? saved[k] : CONFIG[k]);
            // 密钥一律不回显到页面上，只用「是否已配置」驱动界面
            const hasSecret = !!(saved.turnstileSecretKey || CONFIG.turnstileSecretKey);
            const tsOn = turnstileEnabled();
            const tsFromEnv = !!env.TURNSTILE_SECRET_KEY;

            return response.html(html('站点设置', `
                ${adminNav('settings', { posts: posts.length, comments: comments.length, media: media.length })}
                ${pageHead('站点设置', '这些设置保存在 R2 中，保存后立即对全站生效。',
                    '<button class="btn" id="save-settings"><i class="fa-solid fa-floppy-disk"></i> 保存设置</button>')}
                <div class="settings-grid">
                    <div class="card">
                        <div class="card-body">
                            <div class="section-head"><div class="section-title"><i class="fa-solid fa-globe"></i> 基础信息</div></div>
                            <div class="field">
                                <label class="field-label" for="s-name">站点名称</label>
                                <input id="s-name" class="input" value="${val('name')}" placeholder="博客世界">
                            </div>
                            <div class="field">
                                <label class="field-label" for="s-desc">副标题 / SEO 描述</label>
                                <input id="s-desc" class="input" value="${val('desc')}" placeholder="人生如戏">
                            </div>
                            <div class="field">
                                <label class="field-label" for="s-url">站点主域名</label>
                                <input id="s-url" class="input" value="${val('url')}" placeholder="https://example.com">
                                <span class="field-hint">用于 RSS 输出中的绝对链接。</span>
                            </div>
                            <div class="field">
                                <label class="field-label" for="s-pageSize">首页每页文章数</label>
                                <input id="s-pageSize" class="input" type="number" min="1" max="50" value="${val('pageSize')}">
                            </div>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-body">
                            <div class="section-head"><div class="section-title"><i class="fa-solid fa-image"></i> 外观与图标</div></div>
                            <div class="field">
                                <label class="field-label" for="s-bannerUrl">顶部背景图 URL</label>
                                <input id="s-bannerUrl" class="input" value="${val('bannerUrl')}" placeholder="https://…/banner.webp">
                                <span class="field-hint">同时用作首页横幅与登录页背景。</span>
                            </div>
                            <div class="field">
                                <label class="field-label" for="s-favicon">网站图标 URL</label>
                                <input id="s-favicon" class="input" value="${val('favicon')}" placeholder="https://…/favicon.webp">
                            </div>
                            <div class="field">
                                <label class="field-label" for="s-googleVerify">Google 站点验证码</label>
                                <input id="s-googleVerify" class="input" value="${val('googleVerify')}" placeholder="留空则不输出该标签">
                                <span class="field-hint">只填自己的验证码，填别人的等于把搜索后台权限交出去。</span>
                            </div>
                        </div>
                    </div>

                    <div class="card">
                        <div class="card-body">
                            <div class="section-head">
                                <div class="section-title"><i class="fa-solid fa-shield-halved"></i> 人机验证（Turnstile）</div>
                                <span class="badge ${tsOn ? 'badge-cat' : ''}">${tsOn ? '已启用' : '未启用'}</span>
                            </div>
                            ${tsFromEnv ? `<p class="field-hint" style="margin:0 0 14px"><i class="fa-solid fa-circle-info"></i> Secret Key 来自 Worker 环境变量，此处填写无效，需在 Cloudflare 后台修改。</p>` : ''}
                            <div class="field">
                                <label class="field-label" for="s-turnstileSiteKey">Site Key（站点密钥）</label>
                                <input id="s-turnstileSiteKey" class="input" value="${val('turnstileSiteKey')}" placeholder="0x4AAAAAAA…" spellcheck="false">
                                <span class="field-hint">站点密钥会公开出现在登录页，属于可公开的值。</span>
                            </div>
                            <div class="field">
                                <label class="field-label" for="s-turnstileSecretKey">Secret Key（私密密钥）</label>
                                <div style="display:flex;gap:8px">
                                    <input id="s-turnstileSecretKey" class="input" type="password" autocomplete="new-password" spellcheck="false"
                                        placeholder="${hasSecret ? '已配置 · 留空表示不修改' : '尚未配置'}" ${tsFromEnv ? 'disabled' : ''}>
                                    ${hasSecret && !tsFromEnv ? '<button type="button" class="btn btn-ghost btn-sm" id="clear-ts" style="flex:0 0 auto">清除</button>' : ''}
                                </div>
                                <span class="field-hint" id="ts-hint">出于安全考虑，已保存的密钥不会回显到页面上。</span>
                            </div>
                            <p class="field-hint" style="margin:0">
                                <i class="fa-solid fa-circle-info"></i>
                                两项都填且格式正确才会启用；只填一项不生效。密钥在 Cloudflare 控制台 → <strong>Turnstile</strong> → 添加站点后获取。
                            </p>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-body">
                            <div class="section-head">
                                <div class="section-title"><i class="fa-solid fa-key"></i> 修改管理员密码</div>
                            </div>
                            <div class="field">
                                <label class="field-label" for="pw-cur">当前密码</label>
                                <input id="pw-cur" class="input" type="password" autocomplete="current-password">
                            </div>
                            <div class="field">
                                <label class="field-label" for="pw-new">新密码（至少 6 位）</label>
                                <input id="pw-new" class="input" type="password" autocomplete="new-password">
                            </div>
                            <div class="push-bottom" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
                                <span class="field-hint">修改成功后所有设备都需要重新登录。</span>
                                <button class="btn" id="save-pw"><i class="fa-solid fa-shield-halved"></i> 更新密码</button>
                            </div>
                        </div>
                    </div>
                </div>

                <script>
                    let clearSecret = false;
                    const clearBtn = $('#clear-ts');
                    if (clearBtn) clearBtn.addEventListener('click', () => {
                        clearSecret = !clearSecret;
                        const inp = $('#s-turnstileSecretKey');
                        inp.disabled = clearSecret;
                        inp.value = '';
                        clearBtn.textContent = clearSecret ? '撤销' : '清除';
                        clearBtn.classList.toggle('btn-danger', clearSecret);
                        clearBtn.classList.toggle('btn-ghost', !clearSecret);
                        $('#ts-hint').textContent = clearSecret
                            ? '保存后将清除已存储的 Secret Key，人机验证会被关闭。'
                            : '出于安全考虑，已保存的密钥不会回显到页面上。';
                    });

                    $('#save-settings').addEventListener('click', async function () {
                        const btn = this;
                        const payload = {};
                        ['name', 'desc', 'url', 'bannerUrl', 'favicon', 'googleVerify', 'pageSize', 'turnstileSiteKey'].forEach(k => {
                            const el = $('#s-' + k);
                            if (el && !el.disabled) payload[k] = el.value.trim();
                        });

                        // Secret Key 只在用户真的输入了、或点了「清除」时才提交；留空表示保持原值，
                        // 这样既不会把密钥回显到页面上，也不会因为留空而误删已配置的密钥。
                        const secretEl = $('#s-turnstileSecretKey');
                        const typedSecret = (secretEl && !secretEl.disabled) ? secretEl.value.trim() : '';
                        if (clearSecret) payload.turnstileSecretKey = '';
                        else if (typedSecret) payload.turnstileSecretKey = typedSecret;

                        // 提前拦一下占位符：历史上正是因为 "0x4AAAAAA..." 被当成真密钥，导致登录页异常
                        const siteKey = payload.turnstileSiteKey || '';
                        if (siteKey && !/^0x[A-Za-z0-9_-]{20,}$/.test(siteKey)) {
                            const go = await uiConfirm('它看起来不是有效的 Site Key（真实密钥以 0x 开头、不含省略号）。保存后不会启用人机验证，也不会影响登录。', { title: 'Site Key 格式可疑', okText: '仍然保存', danger: false });
                            if (!go) return;
                        }

                        btn.disabled = true;
                        try {
                            const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                            if (r.ok) { toast('设置已保存', 'ok'); setTimeout(() => location.reload(), 700); return; }
                            toast('保存失败', 'err');
                        } catch (e) { toast('网络错误', 'err'); }
                        btn.disabled = false;
                    });

                    $('#save-pw').addEventListener('click', async function () {
                        const cur = $('#pw-cur').value, next = $('#pw-new').value;
                        if (!cur || !next) return toast('请填写当前密码和新密码', 'err');
                        if (next.length < 6) return toast('新密码至少 6 位', 'err');
                        const btn = this;
                        btn.disabled = true;
                        try {
                            const r = await fetch('/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: cur, next }) });
                            if (r.ok) {
                                toast('密码已更新，请重新登录', 'ok');
                                setTimeout(() => location.href = '/logout', 1200);
                                return;
                            }
                            toast(await r.text() || '更新失败', 'err');
                        } catch (e) { toast('网络错误', 'err'); }
                        btn.disabled = false;
                    });
                </script>
            `, user, { page: 'admin' }));
        }

        if (path.startsWith('/admin/edit')) {
            if (!user) return response.redirect('/');
            const id = url.searchParams.get('id') ? safeKey(url.searchParams.get('id')) : '';
            let d = { title: '', content: '', tags: '', cover: '', id: '', slug: '', category: '', isPinned: false };
            if (id) { const o = await env.BLOG_BUCKET.get(`posts/${id}.json`); if (o) d = await o.json(); }
            const allPosts = await loadAllPosts(env);
            const catOptions = [...new Set(allPosts.map(p => p.category || '默认'))].filter(c => c && c !== '默认');
            const isNew = !id;
            // 编辑器 CSS 和 JS 逻辑较多，这里通过模版字符串嵌入
            const editorLogic = `
            <style>
                .editor-wrapper { display: flex; flex-direction: column; height: calc(100vh - 80px); background: var(--card); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; position: relative; } .editor-header { padding: 10px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 15px; background: var(--toolbar-bg); } .title-input { flex: 1; font-size: 1.2rem; font-weight: 700; border: none; background: transparent; color: var(--text); outline: none; } .editor-toolbar { padding: 8px 15px; border-bottom: 1px solid var(--border); display: flex; gap: 6px; flex-wrap: wrap; background: var(--card); align-items: center; } .tool-btn { width: 32px; height: 32px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--text-light); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; position: relative; } .tool-btn:hover { background: var(--bg); color: var(--primary); } .tool-sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; } .main-area { flex: 1; display: flex; overflow: hidden; position: relative; } .edit-area { flex: 1; padding: 20px; font-family: 'Menlo', 'Monaco', monospace; font-size: 15px; line-height: 1.6; border: none; outline: none; resize: none; background: var(--card); color: var(--text); overflow-y: auto; } .preview-area { flex: 1; padding: 20px; overflow-y: auto; background: var(--bg); border-left: 1px solid var(--border); display: block; } .preview-area.hidden { display: none; } .settings-drawer { position: fixed; top: 0; right: -350px; width: 350px; height: 100vh; background: var(--card); z-index: 2000; box-shadow: -5px 0 15px rgba(0,0,0,0.1); transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1); padding: 20px; display: flex; flex-direction: column; } .settings-drawer.open { right: 0; } .drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 1999; display: none; backdrop-filter: blur(2px); } .drawer-mask.open { display: block; } .drawer-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 15px; } .form-group { margin-bottom: 15px; } .form-group label { display: block; margin-bottom: 5px; font-size: 0.9rem; color: var(--text-light); font-weight: 500; } .form-input { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); outline: none; } .form-input:focus { border-color: var(--primary); } .zen-mode .navbar, .zen-mode .editor-header { display: none; } .zen-mode .editor-wrapper { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 9999; border-radius: 0; } .zen-btn { position: fixed; bottom: 20px; right: 20px; z-index: 10000; opacity: 0.3; } .zen-btn:hover { opacity: 1; } #drop-zone { position: absolute; inset: 0; background: rgba(37, 99, 235, 0.1); border: 3px dashed var(--primary); z-index: 10; display: none; align-items: center; justify-content: center; font-size: 1.5rem; color: var(--primary); font-weight: bold; pointer-events: none; } .main-area.drag-over #drop-zone { display: flex; } @media(max-width: 768px) { .preview-area { display: none; } .editor-toolbar { gap: 4px; } .settings-drawer { width: 85%; } }
            </style>
            <style>
                .editor-wrapper { height: calc(100vh - 230px); min-height: 460px; border-radius: var(--radius-lg); border: 1px solid var(--border); }
                .editor-header { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
                .title-input { font-weight: 600; }
                .editor-meta { display: flex; align-items: center; gap: 10px; font-size: .78rem; color: var(--text-faint); white-space: nowrap; }
                .editor-meta .dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); display: none; }
                .editor-meta.dirty .dirty-dot { display: block; }
                .editor-meta.dirty .save-status { color: var(--warn); }
                .edit-area { padding: 24px; }
                @media(max-width: 768px) { .editor-wrapper { height: auto; min-height: 70vh; } }
            </style>
            ${adminNav('posts', { posts: allPosts.length })}
            <div class="editor-wrapper">
                <div class="editor-header">
                    <a href="/admin/posts" class="btn btn-ghost btn-sm"><i class="fa-solid fa-chevron-left"></i> 返回</a>
                    <input id="title" class="title-input" placeholder="输入文章标题…" value="${esc(d.title)}" autocomplete="off">
                    <div class="editor-meta" id="editor-meta">
                        <span class="dirty-dot"></span>
                        <span class="save-status" id="save-status">${isNew ? '新文章' : '已保存'}</span>
                        <span id="word-count">0 字</span>
                    </div>
                    <button class="btn btn-ghost btn-sm" onclick="toggleSettings()"><i class="fa-solid fa-sliders"></i> 设置</button>
                    <button id="save-btn" class="btn btn-sm"><i class="fa-solid fa-floppy-disk"></i> ${isNew ? '发布' : '保存'}</button>
                </div>
                <div class="editor-toolbar">
                    <button class="tool-btn" data-act="bold" title="加粗 (Ctrl+B)"><i class="fa-solid fa-bold"></i></button>
                    <button class="tool-btn" data-act="italic" title="斜体 (Ctrl+I)"><i class="fa-solid fa-italic"></i></button>
                    <button class="tool-btn" data-act="strike" title="删除线"><i class="fa-solid fa-strikethrough"></i></button>
                    <button class="tool-btn" data-act="inline" title="行内代码"><i class="fa-solid fa-terminal"></i></button>
                    <div class="tool-sep"></div>
                    <button class="tool-btn" data-act="h1" title="一级标题">H1</button>
                    <button class="tool-btn" data-act="h2" title="二级标题">H2</button>
                    <button class="tool-btn" data-act="h3" title="三级标题">H3</button>
                    <div class="tool-sep"></div>
                    <button class="tool-btn" data-act="ul" title="无序列表"><i class="fa-solid fa-list-ul"></i></button>
                    <button class="tool-btn" data-act="ol" title="有序列表"><i class="fa-solid fa-list-ol"></i></button>
                    <button class="tool-btn" data-act="task" title="任务列表"><i class="fa-solid fa-list-check"></i></button>
                    <button class="tool-btn" data-act="quote" title="引用"><i class="fa-solid fa-quote-left"></i></button>
                    <button class="tool-btn" data-act="hr" title="分割线"><i class="fa-solid fa-minus"></i></button>
                    <div class="tool-sep"></div>
                    <button class="tool-btn" data-act="code" title="代码块"><i class="fa-solid fa-code"></i></button>
                    <button class="tool-btn" data-act="table" title="插入表格"><i class="fa-solid fa-table"></i></button>
                    <button class="tool-btn" data-act="link" title="链接 (Ctrl+K)"><i class="fa-solid fa-link"></i></button>
                    <button class="tool-btn" data-act="image" title="插入图片（也可直接拖拽 / 粘贴）"><i class="fa-regular fa-image"></i></button>
                    <div class="tool-sep"></div>
                    <button class="tool-btn" onclick="toggleZen()" title="全屏专注模式"><i class="fa-solid fa-expand"></i></button>
                    <button class="tool-btn" onclick="togglePreview()" title="显示 / 隐藏预览"><i class="fa-solid fa-eye"></i></button>
                </div>
                <div class="main-area" id="main-area">
                    <div id="drop-zone">松开鼠标即可上传图片</div>
                    <textarea id="co" class="edit-area" placeholder="开始创作…（支持 Markdown，可直接拖拽或粘贴图片）">${esc(d.content)}</textarea>
                    <div id="pre" class="preview-area markdown-body"></div>
                </div>
            </div>
            <div class="drawer-mask" onclick="toggleSettings()"></div>
            <div class="settings-drawer" id="settings-drawer">
                <div class="drawer-header">
                    <h3 style="margin:0;font-size:1.05rem">文章属性</h3>
                    <button class="btn-icon" onclick="toggleSettings()" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="field">
                    <label class="field-label" for="slug">URL 别名</label>
                    <input id="slug" class="input" value="${esc(d.slug || d.id || '')}" ${id ? 'disabled' : ''} placeholder="留空则自动生成">
                    <span class="field-hint">${id ? '文章发布后不可修改，否则原链接会失效。' : '决定文章链接 /post/<别名>。'}</span>
                </div>
                <div class="field">
                    <label class="field-label" for="category">分类</label>
                    <input id="category" class="input" value="${esc(d.category || '')}" list="cat-list" placeholder="默认">
                    <datalist id="cat-list">${catOptions.map(c => '<option value="' + esc(c) + '"></option>').join('')}</datalist>
                </div>
                <div class="field">
                    <label class="field-label" for="tags">标签</label>
                    <input id="tags" class="input" value="${esc(d.tags || '')}" placeholder="多个标签用逗号分隔">
                </div>
                <div class="field">
                    <label class="field-label" for="cover">封面图 URL</label>
                    <input id="cover" class="input" value="${esc(d.cover || '')}" placeholder="可粘贴媒体库链接">
                </div>
                <label class="switch" style="margin-bottom:16px">
                    <input type="checkbox" id="isPinned" ${d.isPinned ? 'checked' : ''}>
                    <span>置顶到首页顶部</span>
                </label>
                <div style="margin-top:auto;display:flex;gap:10px">
                    <button class="btn btn-ghost" style="flex:1" onclick="toggleSettings()">完成</button>
                    <a class="btn btn-ghost" style="flex:0 0 auto" href="/admin/posts" title="放弃编辑"><i class="fa-solid fa-list"></i></a>
                </div>
            </div>
            <input type="file" id="f" accept="image/*" hidden><input id="pid" type="hidden" value="${esc(d.id)}">
            <input id="slug-locked" type="hidden" value="${id ? '1' : ''}">
            <script>
                function initEditor() {
                    const ta=$('#co'),pre=$('#pre'),main=$('#main-area'),fileInput=$('#f');
                    const meta=$('#editor-meta'),statusEl=$('#save-status'),counter=$('#word-count');
                    let isDirty=false,renderTimer=null;
                    const draftKey='blog_draft_'+($('#pid').value||'new');

                    const countWords=()=>{const v=ta.value;const cjk=(v.match(/[\u4e00-\u9fa5]/g)||[]).length;const words=(v.replace(/[\u4e00-\u9fa5]/g,' ').match(/[A-Za-z0-9_'-]+/g)||[]).length;return cjk+words;};
                    const refreshCount=()=>{counter.textContent=countWords()+' 字';};
                    const markDirty=()=>{isDirty=true;meta.classList.add('dirty');statusEl.textContent='未保存';};

                    const renderPreview=()=>{pre.innerHTML=marked.parse(ta.value);pre.querySelectorAll('pre code').forEach((b)=>{if(b.textContent.length>10000)return;hljs.highlightElement(b);});};
                    const sync=()=>{clearTimeout(renderTimer);renderTimer=setTimeout(renderPreview,300);};

                    ta.addEventListener('input',()=>{sync();refreshCount();markDirty();autoSave();});
                    $('#title').addEventListener('input',()=>{markDirty();autoSave();});
                    ta.addEventListener('scroll',()=>{const range=ta.scrollHeight-ta.clientHeight;if(range<=0)return;pre.scrollTop=(ta.scrollTop/range)*(pre.scrollHeight-pre.clientHeight);});
                    renderPreview();refreshCount();

                    function autoSave(){try{localStorage.setItem(draftKey,JSON.stringify({title:$('#title').value,content:ta.value,time:Date.now()}));}catch(e){}}

                    if(!$('#pid').value){
                        try{
                            const saved=localStorage.getItem(draftKey);
                            if(saved){
                                const dd=JSON.parse(saved);
                                if(dd.content||dd.title){
                                    uiConfirm('检测到 '+new Date(dd.time).toLocaleString('zh-CN')+' 保存的本地草稿，是否恢复到编辑器？',{title:'恢复草稿',okText:'恢复',danger:false})
                                        .then(yes=>{if(!yes)return;$('#title').value=dd.title||'';ta.value=dd.content||'';renderPreview();refreshCount();markDirty();});
                                }
                            }
                        }catch(e){}
                    }

                    const uploadFile=async(file)=>{
                        if(!file||!file.type.startsWith('image/'))return toast('请选择图片文件','err');
                        toast('正在上传…');
                        const fd=new FormData();fd.append('file',file);
                        try{
                            const r=await fetch('/api/upload',{method:'POST',body:fd});
                            if(!r.ok)return toast('上传失败','err');
                            const res=await r.json();
                            insertText('![Image]('+res.url+')','');
                            if(!$('#cover').value)$('#cover').value=res.url;
                            toast('图片已插入正文','ok');
                        }catch(e){toast('网络错误','err');}
                    };

                    main.addEventListener('dragover',e=>{e.preventDefault();main.classList.add('drag-over');});
                    main.addEventListener('dragleave',e=>{e.preventDefault();if(main.contains(e.relatedTarget))return;main.classList.remove('drag-over');});
                    main.addEventListener('drop',e=>{e.preventDefault();main.classList.remove('drag-over');if(e.dataTransfer.files.length)uploadFile(e.dataTransfer.files[0]);});
                    ta.addEventListener('paste',e=>{if(e.clipboardData&&e.clipboardData.files.length){e.preventDefault();uploadFile(e.clipboardData.files[0]);}});

                    const tools={
                        bold:{s:'**',e:'**'},italic:{s:'*',e:'*'},strike:{s:'~~',e:'~~'},
                        code:{s:'\\n\`\`\`\\n',e:'\\n\`\`\`\\n'},inline:{s:'\`',e:'\`'},
                        quote:{s:'\\n> ',e:''},link:{s:'[',e:'](https://)'},
                        h1:{s:'# ',e:''},h2:{s:'## ',e:''},h3:{s:'### ',e:''},
                        ul:{s:'\\n- ',e:''},ol:{s:'\\n1. ',e:''},hr:{s:'\\n\\n---\\n\\n',e:''},
                        table:{s:'\\n| 标题 | 标题 |\\n| --- | --- |\\n| 内容 | 内容 |\\n',e:''},
                        task:{s:'\\n- [ ] 待办事项\\n- [ ] 待办事项',e:''}
                    };
                    window.insertText=(startStr,endStr)=>{const s=ta.selectionStart,e=ta.selectionEnd;ta.setRangeText(startStr+ta.value.substring(s,e)+endStr,s,e,'select');ta.focus();sync();refreshCount();markDirty();};
                    $$('.tool-btn[data-act]').forEach(btn=>{btn.addEventListener('click',()=>{const act=btn.dataset.act;if(act==='image')return fileInput.click();if(tools[act])insertText(tools[act].s,tools[act].e);});});
                    fileInput.addEventListener('change',()=>uploadFile(fileInput.files[0]));
                    document.addEventListener('keydown',e=>{
                        if(!(e.ctrlKey||e.metaKey))return;
                        if(e.key==='s'){e.preventDefault();$('#save-btn').click();}
                        else if(e.key==='b'){e.preventDefault();insertText('**','**');}
                        else if(e.key==='i'){e.preventDefault();insertText('*','*');}
                        else if(e.key==='k'){e.preventDefault();insertText('[','](https://)');}
                    });
                    $('#save-btn').addEventListener('click',async function(){
                        const btn=this;
                        const t=$('#title').value.trim();
                        if(!t){toast('请先填写文章标题','err');$('#title').focus();return;}
                        const raw=btn.innerHTML;
                        btn.disabled=true;
                        btn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i> 保存中…';
                        const postData={id:$('#pid').value,title:t,content:ta.value,tags:$('#tags').value,cover:$('#cover').value,slug:$('#slug').value,category:$('#category').value,isPinned:$('#isPinned').checked};
                        try{
                            const r=await fetch('/api/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(postData)});
                            if(!r.ok){toast('保存失败','err');btn.disabled=false;btn.innerHTML=raw;return;}
                            const saved=await r.json();
                            try{localStorage.removeItem(draftKey);}catch(e){}
                            isDirty=false;meta.classList.remove('dirty');statusEl.textContent='已保存';
                            toast('保存成功','ok');
                            if(!$('#pid').value&&saved.id){setTimeout(()=>location.href='/admin/edit?id='+encodeURIComponent(saved.id),600);return;}
                            btn.disabled=false;btn.innerHTML=raw;
                        }catch(e){toast('网络错误','err');btn.disabled=false;btn.innerHTML=raw;}
                    });
                    window.onbeforeunload=()=>isDirty?"有未保存的修改，确定要离开吗？":undefined;
                }
                window.toggleSettings=()=>{ $('#settings-drawer').classList.toggle('open'); $('.drawer-mask').classList.toggle('open'); };
                window.toggleZen=()=>document.body.classList.toggle('zen-mode');
                window.togglePreview=()=>{ const pre=$('#pre'); pre.classList.toggle('hidden'); if(pre.classList.contains('hidden'))$('#co').style.flex='1'; };
            </script>`;
            return response.html(html('编辑器', editorLogic, user));
        }

        // 媒体库
        if (path === '/admin/media' && user) {
            const keys = await loadAllMedia(env);
            const posts = await loadAllPosts(env);
            const comments = await loadAllComments(env);

            const items = keys.map(k => `
                <div class="media-item card" data-key="${esc(k)}">
                    <img src="/${esc(k)}" loading="lazy" alt="">
                    <div class="batch-checkbox"><i class="fa-solid fa-check"></i></div>
                    <div class="media-tools">
                        <button class="media-btn" data-act="preview" title="新标签页打开"><i class="fa-solid fa-up-right-from-square"></i></button>
                        <button class="media-btn danger" data-act="del" title="删除"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>`).join('');

            return response.html(html('媒体库', `
                <style>
                    .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
                    .media-item { position: relative; aspect-ratio: 1; overflow: hidden; border-radius: var(--radius); cursor: pointer; background: var(--surface-2); transition: box-shadow .2s, transform .2s; }
                    .media-item:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
                    .media-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
                    .media-tools { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; opacity: 0; transition: opacity .2s; }
                    .media-item:hover .media-tools { opacity: 1; }
                    .batch-mode .media-tools { display: none; }
                    .media-btn { width: 28px; height: 28px; border: none; border-radius: 6px; background: rgba(255,255,255,.92); color: var(--text); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: .78rem; transition: all .18s; }
                    .media-btn:hover { background: #fff; }
                    .media-btn.danger { color: var(--danger); }
                    .media-btn.danger:hover { background: var(--danger); color: #fff; }
                    [data-theme="dark"] .media-btn { background: rgba(30,41,59,.92); color: var(--text); }
                    .batch-checkbox { position: absolute; top: 8px; left: 8px; width: 20px; height: 20px; border-radius: 5px; background: rgba(255,255,255,.92); border: 1px solid var(--border-strong); display: none; align-items: center; justify-content: center; color: var(--primary); font-size: .7rem; z-index: 5; }
                    .batch-mode .batch-checkbox { display: flex; }
                    .media-item.selected { box-shadow: 0 0 0 3px var(--primary); }
                    .media-item.selected .batch-checkbox { background: var(--primary); border-color: var(--primary); color: #fff; }
                    .media-grid.dragging { outline: 2px dashed var(--primary); outline-offset: 6px; border-radius: var(--radius); }
                    .batch-bar { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(120%); display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 999px; background: var(--card); color: var(--text); border: 1px solid var(--border); box-shadow: var(--shadow-lg); z-index: 1000; transition: transform .28s cubic-bezier(.18,.89,.32,1.28); }
                    .batch-bar.show { transform: translateX(-50%) translateY(0); }
                    .batch-btn { border: none; border-radius: 999px; padding: 7px 14px; font-size: .85rem; cursor: pointer; background: var(--surface-2); color: var(--text); display: inline-flex; align-items: center; gap: 6px; transition: background .18s; }
                    .batch-btn:hover { background: var(--border); }
                    .batch-btn.danger { background: var(--danger); color: #fff; }
                    .batch-info { font-size: .88rem; font-weight: 500; padding-left: 6px; }
                </style>
                ${adminNav('media', { posts: posts.length, comments: comments.length, media: keys.length })}
                ${pageHead('媒体库', '共 ' + keys.length + ' 张图片，点击缩略图即可复制 Markdown 链接。',
                    '<button class="btn" id="upload-btn"><i class="fa-solid fa-cloud-arrow-up"></i> 上传图片</button>')}
                <div class="toolbar">
                    <div class="search-box">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input id="m-q" class="input" placeholder="按文件名筛选…">
                    </div>
                    <div class="spacer"></div>
                    <span id="sel-info" class="pager-info"></span>
                    <button class="btn btn-ghost btn-sm" id="batch-toggle"><i class="fa-solid fa-list-check"></i> 批量管理</button>
                </div>
                <input type="file" id="m-file" accept="image/*" multiple hidden>
                ${keys.length
                    ? '<div class="media-grid" id="media-grid">' + items + '</div>'
                    : '<div class="card">' + emptyState('fa-images', '还没有图片。点击右上角上传，或直接把图片拖到这里。', '<button class="btn btn-sm" onclick="document.getElementById(\'m-file\').click()"><i class="fa-solid fa-cloud-arrow-up"></i> 上传图片</button>') + '</div>'}
                <div class="batch-bar" id="batch-bar">
                    <span class="batch-info">已选 <span id="sel-count">0</span> 项</span>
                    <button class="batch-btn" data-act="copy"><i class="fa-regular fa-copy"></i> 复制链接</button>
                    <button class="batch-btn danger" data-act="del"><i class="fa-solid fa-trash"></i> 删除</button>
                    <button class="batch-btn" data-act="close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <script>
                    let isBatch = false;
                    const selected = new Set();
                    const grid = $('#media-grid');
                    const fileInput = $('#m-file');

                    function refreshSel() {
                        $('#sel-count').textContent = selected.size;
                        $('#sel-info').textContent = selected.size ? '已选 ' + selected.size + ' 张' : '';
                    }
                    function toggleBatch(force) {
                        isBatch = typeof force === 'boolean' ? force : !isBatch;
                        document.body.classList.toggle('batch-mode', isBatch);
                        $('#batch-bar').classList.toggle('show', isBatch);
                        $('#batch-toggle').classList.toggle('btn-ghost', !isBatch);
                        if (!isBatch) {
                            selected.clear();
                            $$('.media-item.selected').forEach(el => el.classList.remove('selected'));
                            refreshSel();
                        }
                    }

                    async function uploadFiles(files) {
                        const list = Array.from(files || []).filter(f => f.type.startsWith('image/'));
                        if (!list.length) return toast('请选择图片文件', 'err');
                        let done = 0;
                        toast('正在上传 ' + list.length + ' 张…');
                        for (const f of list) {
                            const fd = new FormData();
                            fd.append('file', f);
                            try {
                                const r = await fetch('/api/upload', { method: 'POST', body: fd });
                                if (r.ok) done++;
                            } catch (e) { }
                        }
                        if (done) { toast('已上传 ' + done + ' 张', 'ok'); setTimeout(() => location.reload(), 700); }
                        else toast('上传失败', 'err');
                    }

                    async function delOne(key) {
                        const yes = await uiConfirm('删除后，引用了这张图片的文章会显示为裂图。', { title: '删除这张图片？', okText: '确认删除' });
                        if (!yes) return;
                        try {
                            const r = await fetch('/api/media?key=' + encodeURIComponent(key), { method: 'DELETE' });
                            if (r.ok) { toast('已删除', 'ok'); setTimeout(() => location.reload(), 600); }
                            else toast('删除失败', 'err');
                        } catch (e) { toast('网络错误', 'err'); }
                    }

                    $('#upload-btn').addEventListener('click', () => fileInput.click());
                    fileInput.addEventListener('change', () => uploadFiles(fileInput.files));
                    $('#batch-toggle').addEventListener('click', () => toggleBatch());

                    if (grid) {
                        grid.addEventListener('click', e => {
                            const item = e.target.closest('.media-item');
                            if (!item) return;
                            const key = item.dataset.key;
                            const act = (e.target.closest('[data-act]') || {}).dataset;
                            if (act && act.act === 'preview') { window.open('/' + key, '_blank'); return; }
                            if (act && act.act === 'del') { delOne(key); return; }
                            if (isBatch) {
                                if (selected.has(key)) { selected.delete(key); item.classList.remove('selected'); }
                                else { selected.add(key); item.classList.add('selected'); }
                                refreshSel();
                                return;
                            }
                            copyText('![](' + '/' + key + ')').then(ok => toast(ok ? '链接已复制' : '复制失败，请手动复制', ok ? 'ok' : 'err'));
                        });

                        ['dragenter', 'dragover'].forEach(ev => grid.addEventListener(ev, e => {
                            e.preventDefault();
                            grid.classList.add('dragging');
                        }));
                        ['dragleave', 'drop'].forEach(ev => grid.addEventListener(ev, e => {
                            e.preventDefault();
                            if (ev === 'dragleave' && grid.contains(e.relatedTarget)) return;
                            grid.classList.remove('dragging');
                        }));
                        grid.addEventListener('drop', e => { if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });
                    }

                    document.addEventListener('keydown', e => { if (e.key === 'Escape' && isBatch) toggleBatch(false); });
                    $('#m-q').addEventListener('input', function () {
                        const kw = this.value.trim().toLowerCase();
                        $$('.media-item').forEach(el => {
                            el.style.display = !kw || el.dataset.key.toLowerCase().includes(kw) ? '' : 'none';
                        });
                    });

                    $('#batch-bar').addEventListener('click', async e => {
                        const act = (e.target.closest('[data-act]') || {}).dataset;
                        if (!act) return;
                        if (act.act === 'close') return toggleBatch(false);
                        if (!selected.size) return toast('请先选择图片', 'err');
                        const keys = Array.from(selected);
                        if (act.act === 'copy') {
                            const ok = await copyText(keys.map(k => '![](' + '/' + k + ')').join('\\n'));
                            toast(ok ? '已复制 ' + keys.length + ' 条链接' : '复制失败', ok ? 'ok' : 'err');
                            toggleBatch(false);
                            return;
                        }
                        if (act.act === 'del') {
                            const yes = await uiConfirm('将删除选中的 ' + keys.length + ' 张图片，此操作不可恢复。', { title: '批量删除？', okText: '确认删除' });
                            if (!yes) return;
                            try {
                                const r = await fetch('/api/media?keys=' + encodeURIComponent(keys.join(',')), { method: 'DELETE' });
                                if (r.ok) { toast('已删除 ' + keys.length + ' 张', 'ok'); setTimeout(() => location.reload(), 700); }
                                else toast('删除失败', 'err');
                            } catch (err) { toast('网络错误', 'err'); }
                        }
                    });
                </script>
            `, user, { page: 'admin' }));
        }

        // 2. 公开页面
        if (path === '/') {
            const all = await loadAllPosts(env);
            all.sort((a, b) => (a.isPinned !== b.isPinned) ? (a.isPinned ? -1 : 1) : new Date(b.date) - new Date(a.date));
            const uniqueCats = [...new Set(all.map(p => p.category || '默认'))];
            const selectedCat = url.searchParams.get('category');
            const categories = [{ name: '全部', url: '/', active: !selectedCat }, ...uniqueCats.map(c => ({ name: c, url: '/?category=' + encodeURIComponent(c), active: c === selectedCat }))];
            const filtered = selectedCat ? all.filter(p => (p.category || '默认') === selectedCat) : all;

            const size = Math.max(1, parseInt(CONFIG.pageSize, 10) || 6);
            const total = filtered.length;
            const pages = Math.max(1, Math.ceil(total / size));
            const cur = Math.min(Math.max(1, parseInt(url.searchParams.get('p'), 10) || 1), pages);
            const slice = filtered.slice((cur - 1) * size, cur * size);

            const pageUrl = (n) => {
                const u = new URLSearchParams();
                if (selectedCat) u.set('category', selectedCat);
                if (n > 1) u.set('p', n);
                const s = u.toString();
                return '/' + (s ? '?' + s : '');
            };

            const listHtml = slice.length ? slice.map(p => `
                <div class="card card-hover">
                    ${p.cover ? `<img src="${esc(p.cover)}" class="card-cover" loading="lazy" alt="">` : ''}
                    <div class="card-body">
                        <div style="margin-bottom:12px;">${p.isPinned ? '<span class="badge badge-pin">置顶</span>' : ''}<span class="badge badge-cat">${esc(p.category || '默认')}</span></div>
                        <h2 style="margin:0 0 10px 0;font-size:1.4rem;line-height:1.4"><a href="/post/${encodeURIComponent(p.id)}">${esc(p.title)}</a></h2>
                        <p style="color:var(--text-light);margin-bottom:20px;font-size:0.95rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(p.excerpt)}</p>
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;color:var(--text-light)"><span>${new Date(p.date).toLocaleDateString('zh-CN')}</span><span><i class="fa-regular fa-eye"></i> ${p.views || 0}</span></div>
                    </div>
                </div>`).join('') : '';

            const pager = pages > 1 ? `
                <div class="pager">
                    <button class="pager-btn" ${cur <= 1 ? 'disabled' : ''} onclick="location.href='${pageUrl(cur - 1)}'"><i class="fa-solid fa-chevron-left"></i></button>
                    ${Array.from({ length: pages }, (_, i) => i + 1)
                        .filter(n => n === 1 || n === pages || Math.abs(n - cur) <= 1)
                        .map((n, i, arr) => (i > 0 && n - arr[i - 1] > 1 ? '<span class="pager-info">…</span>' : '')
                            + `<button class="pager-btn ${n === cur ? 'active' : ''}" onclick="location.href='${pageUrl(n)}'">${n}</button>`)
                        .join('')}
                    <button class="pager-btn" ${cur >= pages ? 'disabled' : ''} onclick="location.href='${pageUrl(cur + 1)}'"><i class="fa-solid fa-chevron-right"></i></button>
                </div>` : '';

            const body = slice.length
                ? `<div class="grid">${listHtml}</div>${pager}`
                : `<div class="card">${emptyState('fa-file-pen', selectedCat ? '该分类下还没有文章。' : '还没有发布任何文章。')}</div>`;

            return response.html(html(CONFIG.name + ' - 首页', body, user, { page: 'home', categories }));
        }

        if (path.startsWith('/post/')) {
            const id = safeKey(decodeURIComponent(path.split('/')[2] || ''));
            const obj = await env.BLOG_BUCKET.get(`posts/${id}.json`);
            if (!obj) return response.error('404 Not Found', 404);
            const p = await obj.json();
            p.views = (p.views || 0) + 1;
            ctx.waitUntil(env.BLOG_BUCKET.put(`posts/${id}.json`, JSON.stringify(p)));
            let comments = []; try { comments = await (await env.BLOG_BUCKET.get(`comments/${id}.json`)).json(); } catch (e) { }
            const commentHtml = comments.length > 0 ? comments.map(c => {
                const avatarChar = esc(String(c.user || '访').charAt(0).toUpperCase());
                return `<div class="comment-item"><div class="c-avatar">${avatarChar}</div><div class="c-body"><div class="c-head"><span class="c-user">${esc(c.user || '访客')}</span><span class="c-date">${new Date(c.date).toLocaleString('zh-CN')}</span></div><div class="c-content">${esc(c.content)}</div></div></div>`;
            }).join('') : emptyState('fa-comments', '还没有评论，来抢沙发吧。');

            return response.html(html(p.title, `
                <div style="margin-bottom:20px"><a href="/" class="btn btn-ghost btn-sm"><i class="fa-solid fa-arrow-left"></i> 返回首页</a></div>
                <div class="card" style="margin-bottom: 30px;">
                    ${p.cover ? `<img src="${esc(p.cover)}" style="width:100%;height:400px;object-fit:cover;">` : ''}
                    <div class="card-body" style="padding: 40px;">
                        <div style="margin-bottom:15px;text-align:center">${p.isPinned ? '<span class="badge badge-pin">置顶</span>' : ''}<span class="badge badge-cat">${esc(p.category || '默认')}</span></div>
                        <h1 style="font-size:2.5rem;margin-bottom:20px;margin-top:0;text-align:center">${esc(p.title)}</h1>
                        <div style="color:var(--text-light);margin-bottom:40px;border-bottom:1px solid var(--border);padding-bottom:30px;text-align:center"><i class="fa-regular fa-calendar"></i> ${new Date(p.date).toLocaleString('zh-CN')} &nbsp; <i class="fa-regular fa-eye"></i> ${p.views} 阅读</div>
                        <div id="markdown-content" class="markdown-body"></div>
                    </div>
                </div>
                <div class="card comments-sec"><div class="card-body" style="padding: 30px;"><div class="comments-header"><h3><i class="fa-regular fa-comments"></i> 评论 (${comments.length})</h3></div><div class="comment-list">${commentHtml}</div><div class="comment-form-box"><h4 style="margin-top:0;margin-bottom:15px;display:flex;align-items:center;gap:8px"><i class="fa-solid fa-pen"></i> 发表评论</h4><form onsubmit="event.preventDefault();subC()"><div class="c-input-grid"><input id="c-user" class="c-input" placeholder="怎么称呼您？" required maxlength="20"><textarea id="c-content" class="c-input c-textarea" placeholder="写下您的想法…" required></textarea></div><div style="text-align:right"><button class="btn" id="c-submit"><i class="fa-solid fa-paper-plane"></i> 发送评论</button></div></form></div></div></div>
                <script>window._RAW_MD = ${JSON.stringify(p.content || '')};async function subC(){const btn=$('#c-submit'),u=$('#c-user').value.trim(),c=$('#c-content').value.trim();if(!u||!c)return toast('请填写昵称和内容','err');const raw=btn.innerHTML;btn.disabled=true;btn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i> 发送中…';try{const res=await fetch('/api/comment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postId:'${esc(id)}',user:u,content:c})});if(res.ok){toast('评论成功','ok');setTimeout(()=>location.reload(),700);return;}toast('发送失败','err');}catch(e){toast('网络错误','err');}btn.disabled=false;btn.innerHTML=raw;}</script>
            `, user, { excerpt: p.excerpt }));
        }

        if (path === '/about') {
            return response.html(html('关于我', `
                <div class="card"><div class="card-body" style="padding: 40px; text-align:center;"><img src="${esc(CONFIG.bannerUrl)}" style="width:80px;height:80px;border-radius:50%;margin-bottom:20px;object-fit:cover;box-shadow:var(--shadow);"><h1 style="font-size:2.0rem;margin-bottom:15px;">关于 ${esc(CONFIG.name)}</h1><p style="font-size:1.05rem;color:var(--text-light);margin-bottom:30px;max-width:600px;margin-left:auto;margin-right:auto;">这是一个基于 Cloudflare Workers 和 R2 构建的极简无服务器博客系统。追求极致的加载速度与纯粹的阅读体验。</p><div style="display:inline-flex; align-items:center; gap:15px; flex-wrap:wrap; justify-content:center;"><div style="background:var(--bg); padding:10px 20px; border-radius:50px; font-size:0.9rem; color:var(--text); border:1px solid var(--border); display:flex; align-items:center;"><i class="fa-solid fa-server" style="color:var(--success); margin-right:8px;"></i><span>状态: <span style="color:var(--success);font-weight:bold">运行中</span></span></div><div style="background:var(--bg); padding:10px 20px; border-radius:50px; font-size:0.9rem; color:var(--text); border:1px solid var(--border); display:flex; align-items:center;"><i class="fa-solid fa-clock-rotate-left" style="color:var(--primary); margin-right:8px;"></i><span>已运行: <strong id="run-days" style="color:var(--primary); margin:0 4px;">1</strong> 天</span></div></div><div style="margin-top:40px; border-top:1px solid var(--border); padding-top:30px; color:var(--text-light); font-size:0.9rem;"><p>人生如戏，全靠演技。</p><p>© ${new Date().getFullYear()} ${esc(CONFIG.name)}. Powered by Cloudflare.</p></div></div></div>
                <script>const startDate = '2025-06-06'; const start = new Date(startDate); const now = new Date(); const diff = now - start; const days = Math.floor(diff / (1000 * 60 * 60 * 24)); document.getElementById('run-days').innerText = days > 0 ? days : 1;</script>
            `, user, { page: 'about' }));
        }

        return response.error('404 Not Found', 404);
    }
}
