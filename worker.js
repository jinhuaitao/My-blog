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
    // Cloudflare Turnstile 验证配置（可选，不配置则跳过人机验证）
    turnstileSiteKey: "0x4AAAAAA...",     
    turnstileSecretKey: "0x4AAAAAA...",
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
`;

// 基础 HTML 模版函数
const html = (title, content, user = null, ctx = {}) => `
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - ${CONFIG.name}</title>

    <meta name="google-site-verification" content="8gkd4psEV_1VMGdu5A7_8ZZns38sUEGphEH3YWPFDLw" />
    
    <meta name="description" content="${ctx.excerpt || CONFIG.desc}">
    <link rel="icon" href="${CONFIG.favicon}">
    <link rel="apple-touch-icon" href="${CONFIG.favicon}">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown-light.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    ${ctx.useTurnstile ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}
    <style>${STYLES}</style>
    <script>
        (function(){ const s = localStorage.getItem('theme'); const m = window.matchMedia('(prefers-color-scheme: dark)').matches; const t = s ? s : (m ? 'dark' : 'light'); document.documentElement.setAttribute('data-theme', t); })();
    </script>
</head>
<body>
    ${ctx.page !== 'login' ? `
    <nav class="navbar">
        <a href="/" class="nav-icon"><i class="fa-solid fa-layer-group"></i></a>
        <div class="nav-links"><a href="/" class="${!ctx.page ? 'active' : ''}">首页</a><a href="/about" class="${ctx.page === 'about' ? 'active' : ''}">关于</a></div>
        <div class="nav-right nav-links">
            <button id="theme-btn" class="btn-icon" style="background:transparent;border:none;margin-right:8px" onclick="toggleTheme()" title="切换主题"><i class="fa-solid fa-moon"></i></button>
            ${user ? `<a href="/admin/dashboard" class="${ctx.page === 'dash' ? 'active' : ''}">管理台</a><a href="/logout" class="btn-ghost" style="border:none; color:#dc3545; font-size:0.9rem"><i class="fa-solid fa-power-off"></i></a>` : `<a href="/admin">登录</a>`}
        </div>
    </nav>` : ''}

    ${ctx.page === 'home' ? `
    <div class="hero-banner">
        <div class="hero-content"><h1 class="hero-title">${CONFIG.name}</h1><p class="hero-subtitle">${CONFIG.desc}</p></div>
    </div>
    <div class="category-tabs">${(ctx.categories || []).map(c => `<a href="${c.url}" class="tab-item ${c.active ? 'active' : ''}">${c.name}</a>`).join('')}</div>
    ` : ''}

    <div ${ctx.page === 'login' ? 'class="login-wrapper"' : 'class="container" id="main-container"'} ${ctx.page !== 'home' && ctx.page !== 'login' ? 'style="margin-top: 100px;"' : ''}>
        ${content}
        ${ctx.page === 'login' ? `<div class="login-bg"></div>` : ''}
    </div>
    <div id="toast"></div>

    <script>
        const $ = s => document.querySelector(s); const $$ = s => document.querySelectorAll(s);
        function toast(msg) { $('#toast').innerText=msg; $('#toast').classList.add('show'); setTimeout(()=>$('#toast').classList.remove('show'), 3000); }
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
        });
        async function delP(id) { if(!confirm('确定要删除这篇文章吗？不可恢复。')) return; const r = await fetch('/api/posts?id='+id, {method:'DELETE'}); if(r.ok) { toast('已删除'); setTimeout(()=>location.reload(), 800); } else toast('删除失败'); }
    </script>
</body>
</html>
`;

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        const path = url.pathname;
        let config = null;
        try { config = await (await env.BLOG_BUCKET.get('sys/config.json')).json(); } catch (e) { }

        // 1. 初始化检查
        if (!config && path !== '/api/install' && !path.startsWith('/images/')) {
            return response.html(html('系统安装', `
                <div class="login-card" style="text-align: center;">
                    <div style="margin-bottom: 30px;">
                        <div style="font-size: 3rem; margin-bottom: 15px;">🚀</div>
                        <h2 style="margin: 0; font-size: 1.6rem; color: var(--text);">初始化 CMS</h2>
                        <p style="color: var(--text-light); font-size: 0.95rem; margin-top: 8px;">设置您的管理员账号与密码</p>
                    </div>
                    <form onsubmit="event.preventDefault();inst()">
                        <div class="input-group-modern">
                            <input id="u" placeholder="管理员用户名" required autocomplete="username">
                            <i class="fa-solid fa-user"></i>
                        </div>
                        <div class="input-group-modern">
                            <input id="p" type="password" placeholder="管理员密码" required autocomplete="new-password">
                            <i class="fa-solid fa-lock"></i>
                        </div>
                        <button class="btn btn-login" style="margin-top: 10px;">完成安装 <i class="fa-solid fa-arrow-right" style="margin-left:5px"></i></button>
                    </form>
                </div>
                <script>
                    async function inst() {
                        const btn = document.querySelector('.btn-login');
                        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 配置中...';
                        try {
                            const res = await fetch('/api/install', {
                                method: 'POST',
                                body: JSON.stringify({ u: $('#u').value, p: $('#p').value })
                            });
                            if (res.ok) {
                                toast('安装成功，正在载入...');
                                setTimeout(() => location.reload(), 1000);
                            } else {
                                toast('安装失败，请重试');
                                btn.innerHTML = '完成安装 <i class="fa-solid fa-arrow-right" style="margin-left:5px"></i>';
                            }
                        } catch(e) {
                            toast('网络错误');
                            btn.innerHTML = '完成安装 <i class="fa-solid fa-arrow-right" style="margin-left:5px"></i>';
                        }
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
            if (CONFIG.turnstileSecretKey && CONFIG.turnstileSiteKey) {
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

        if (path === '/api/posts' && user) {
            if (req.method === 'DELETE') {
                const id = url.searchParams.get('id');
                await env.BLOG_BUCKET.delete(`posts/${id}.json`);
                await env.BLOG_BUCKET.delete(`comments/${id}.json`);
                return response.html('ok');
            }
            const b = await req.json();
            const id = b.slug ? b.slug : (b.id || Date.now().toString());
            let views = 0;
            const oldObj = await env.BLOG_BUCKET.get(`posts/${id}.json`);
            if (oldObj) { const old = await oldObj.json(); views = old.views || 0; }
            const post = {
                id, title: b.title, content: b.content, tags: b.tags, cover: b.cover, slug: id,
                category: b.category || '默认', isPinned: b.isPinned || false,
                date: b.date || new Date().toISOString(), views,
                excerpt: b.content.substring(0, 120).replace(/[#*`\[\]]/g, '') + '...'
            };
            await env.BLOG_BUCKET.put(`posts/${id}.json`, JSON.stringify(post));
            return response.html('ok');
        }

        if (path === '/api/comment' && req.method === 'POST') {
            const b = await req.json();
            const key = `comments/${b.postId}.json`;
            let comments = []; try { comments = await (await env.BLOG_BUCKET.get(key)).json(); } catch (e) { }
            comments.push({ user: b.user || '访客', content: b.content, date: new Date().toISOString() });
            await env.BLOG_BUCKET.put(key, JSON.stringify(comments));
            return response.html('ok');
        }

        if (path === '/api/upload' && user) {
            const f = (await req.formData()).get('file');
            const k = `images/${Date.now()}-${f.name}`;
            await env.BLOG_BUCKET.put(k, f);
            return response.json({ url: `/${k}` });
        }

        if (path === '/api/media' && req.method === 'DELETE' && user) {
            const key = url.searchParams.get('key');
            if (key) await env.BLOG_BUCKET.delete(key);
            return response.html('ok');
        }

        // --- 静态文件与 RSS ---
        if (path.startsWith('/images/')) {
            const o = await env.BLOG_BUCKET.get(path.substring(1));
            return o ? response.asset(o.body, o.httpMetadata?.contentType) : response.error('404', 404);
        }
        if (path === '/rss.xml') {
            const list = await env.BLOG_BUCKET.list({ prefix: 'posts/', limit: 50 });
            const posts = await Promise.all(list.objects.map(async o => await (await env.BLOG_BUCKET.get(o.key)).json()));
            posts.sort((a, b) => new Date(b.date) - new Date(a.date));
            const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${CONFIG.name}</title><link>${CONFIG.url}</link><description>${CONFIG.desc}</description>${posts.map(p => `<item><title>${p.title}</title><link>${CONFIG.url}/post/${p.id}</link><description>${p.excerpt}</description><pubDate>${new Date(p.date).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
            return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
        }

        // --- 页面路由区域 ---

        // 1. 管理后台
        if (path === '/admin') {
            if (user) return response.redirect('/admin/dashboard');
            const hasTurnstile = CONFIG.turnstileSiteKey && CONFIG.turnstileSiteKey.length > 5;
            return response.html(html('后台登录', `
              <div class="login-card">
                  <div class="login-header"><div class="login-icon"><i class="fa-solid fa-user-shield"></i></div><h2 class="login-title">管理员登录</h2><p class="login-subtitle">欢迎回来，请验证身份以继续</p></div>
                  <form onsubmit="event.preventDefault();login()">
                      <div class="input-group-modern"><input id="u" placeholder="用户名" required autocomplete="username"><i class="fa-solid fa-user"></i></div>
                      <div class="input-group-modern"><input id="p" type="password" placeholder="密码" required autocomplete="current-password"><i class="fa-solid fa-lock"></i></div>
                      ${hasTurnstile ? `<div style="display:flex;justify-content:center;margin-bottom:20px;min-height:65px;"><div class="cf-turnstile" data-sitekey="${CONFIG.turnstileSiteKey}"></div></div>` : ''}
                      <button class="btn btn-login">立即登录 <i class="fa-solid fa-arrow-right" style="margin-left:5px"></i></button>
                  </form>
              </div>
              <script>async function login(){const u=$('#u').value,p=$('#p').value;let t='';if(document.querySelector('.cf-turnstile')){t=turnstile.getResponse();if(!t)return toast('请先完成人机验证');}const btn=document.querySelector('.btn-login');btn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i> 验证中...';try{const res=await fetch('/api/login',{method:'POST',body:JSON.stringify({u,p,turnstileToken:t})});if(res.ok){toast('登录成功');setTimeout(()=>location.href='/admin/dashboard',500);}else{toast('登录失败');if(typeof turnstile!=='undefined')turnstile.reset();btn.innerHTML='立即登录';}}catch(e){toast('网络错误');btn.innerHTML='立即登录';}}</script>`, null, { useTurnstile: hasTurnstile, page: 'login' }));
        }

        if (path === '/admin/dashboard' && user) {
            const list = await env.BLOG_BUCKET.list({ prefix: 'posts/' });
            let posts = await Promise.all(list.objects.map(async o => await (await env.BLOG_BUCKET.get(o.key)).json()));
            const totalPosts = posts.length;
            const totalViews = posts.reduce((sum, p) => sum + (p.views || 0), 0);
            posts.sort((a, b) => new Date(b.date) - new Date(a.date));
            const topPosts = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0));
            const maxViews = topPosts[0]?.views || 1;
            const iList = await env.BLOG_BUCKET.list({ prefix: 'images/' });
            const hour = new Date().getHours() + 8; // UTC+8
            const greeting = hour < 12 ? '早上好' : (hour < 18 ? '下午好' : '晚上好');

            return response.html(html('仪表盘', `
                <div class="dash-header">
                    <div class="welcome-text"><h1>${greeting}, ${user.name} 👋</h1><p>这里是你的博客控制台，今天也是充满灵感的一天。</p></div>
                    <div style="display:flex;gap:12px;"><a href="/admin/edit" class="btn"><i class="fa-solid fa-pen-nib"></i> 发布文章</a><a href="/admin/media" class="btn btn-ghost"><i class="fa-solid fa-images"></i> 媒体库</a></div>
                </div>
                <div class="stats-grid">
                    <div class="card stat-card"><div class="stat-info"><div class="stat-label">文章总数</div><div class="stat-val">${totalPosts}</div></div><div class="stat-icon icon-blue"><i class="fa-solid fa-file-lines"></i></div></div>
                    <div class="card stat-card"><div class="stat-info"><div class="stat-label">全站阅读</div><div class="stat-val">${totalViews}</div></div><div class="stat-icon icon-orange"><i class="fa-solid fa-eye"></i></div></div>
                    <div class="card stat-card"><div class="stat-info"><div class="stat-label">图片资源</div><div class="stat-val">${iList.objects.length}</div></div><div class="stat-icon icon-green"><i class="fa-solid fa-image"></i></div></div>
                </div>
                <div style="display:grid; grid-template-columns: 2fr 1fr; gap:24px;">
                    <div><div class="dash-section-title"><i class="fa-solid fa-layer-group"></i> 最新文章</div><div class="card table-card"><div class="table-responsive"><table><thead><tr><th>文章标题</th><th>状态</th><th>数据</th><th style="text-align:right">操作</th></tr></thead><tbody>
                    ${posts.map(p => `<tr><td><a href="/post/${p.id}" target="_blank" class="post-title">${p.title}</a><div class="post-meta">${new Date(p.date).toLocaleDateString()} · ${p.category || '默认'}</div></td><td>${p.isPinned ? '<span class="badge badge-pin">📌 置顶</span>' : '<span class="badge">常规</span>'}</td><td style="color:var(--text-light);font-size:0.9rem"><i class="fa-solid fa-eye"></i> ${p.views || 0}</td><td><div style="display:flex;justify-content:flex-end;gap:5px;"><a href="/admin/edit?id=${p.id}" class="btn-icon" title="编辑"><i class="fa-solid fa-pen"></i></a><div onclick="delP('${p.id}')" class="btn-icon delete" title="删除"><i class="fa-solid fa-trash"></i></div></div></td></tr>`).join('')}
                    </tbody></table></div></div></div>
                    <div><div class="dash-section-title"><i class="fa-solid fa-fire"></i> 阅读排行</div><div class="card rank-list">
                    ${topPosts.map((p, idx) => `<div class="rank-item"><div class="rank-idx">${idx + 1}</div><div class="rank-info"><div style="display:flex;justify-content:space-between"><div class="rank-title">${p.title}</div><div class="rank-views">${p.views || 0}</div></div><div class="rank-bar"><div class="rank-fill" style="width:${((p.views || 0) / maxViews) * 100}%"></div></div></div></div>`).join('')}
                    </div></div>
                </div>
            `, user, { page: 'dash' }));
        }

        if (path.startsWith('/admin/edit')) {
            if (!user) return response.redirect('/');
            const id = url.searchParams.get('id');
            let d = { title: '', content: '', tags: '', cover: '', id: '', slug: '', category: '', isPinned: false };
            if (id) { const o = await env.BLOG_BUCKET.get(`posts/${id}.json`); if (o) d = await o.json(); }
            // 编辑器 CSS 和 JS 逻辑较多，这里通过模版字符串嵌入
            const editorLogic = `
            <style>
                .editor-wrapper { display: flex; flex-direction: column; height: calc(100vh - 80px); background: var(--card); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; position: relative; } .editor-header { padding: 10px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 15px; background: var(--toolbar-bg); } .title-input { flex: 1; font-size: 1.2rem; font-weight: 700; border: none; background: transparent; color: var(--text); outline: none; } .editor-toolbar { padding: 8px 15px; border-bottom: 1px solid var(--border); display: flex; gap: 6px; flex-wrap: wrap; background: var(--card); align-items: center; } .tool-btn { width: 32px; height: 32px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--text-light); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; position: relative; } .tool-btn:hover { background: var(--bg); color: var(--primary); } .tool-sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; } .main-area { flex: 1; display: flex; overflow: hidden; position: relative; } .edit-area { flex: 1; padding: 20px; font-family: 'Menlo', 'Monaco', monospace; font-size: 15px; line-height: 1.6; border: none; outline: none; resize: none; background: var(--card); color: var(--text); overflow-y: auto; } .preview-area { flex: 1; padding: 20px; overflow-y: auto; background: var(--bg); border-left: 1px solid var(--border); display: block; } .preview-area.hidden { display: none; } .settings-drawer { position: fixed; top: 0; right: -350px; width: 350px; height: 100vh; background: var(--card); z-index: 2000; box-shadow: -5px 0 15px rgba(0,0,0,0.1); transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1); padding: 20px; display: flex; flex-direction: column; } .settings-drawer.open { right: 0; } .drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 1999; display: none; backdrop-filter: blur(2px); } .drawer-mask.open { display: block; } .drawer-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 15px; } .form-group { margin-bottom: 15px; } .form-group label { display: block; margin-bottom: 5px; font-size: 0.9rem; color: var(--text-light); font-weight: 500; } .form-input { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); outline: none; } .form-input:focus { border-color: var(--primary); } .zen-mode .navbar, .zen-mode .editor-header { display: none; } .zen-mode .editor-wrapper { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 9999; border-radius: 0; } .zen-btn { position: fixed; bottom: 20px; right: 20px; z-index: 10000; opacity: 0.3; } .zen-btn:hover { opacity: 1; } #drop-zone { position: absolute; inset: 0; background: rgba(37, 99, 235, 0.1); border: 3px dashed var(--primary); z-index: 10; display: none; align-items: center; justify-content: center; font-size: 1.5rem; color: var(--primary); font-weight: bold; pointer-events: none; } .main-area.drag-over #drop-zone { display: flex; } @media(max-width: 768px) { .preview-area { display: none; } .editor-toolbar { gap: 4px; } .settings-drawer { width: 85%; } }
            </style>
            <div class="editor-wrapper">
                <div class="editor-header">
                    <a href="/admin/dashboard" class="btn btn-ghost btn-sm" style="margin-right:10px;"><i class="fa-solid fa-chevron-left"></i> 返回列表</a>
                    <input id="title" class="title-input" placeholder="输入文章标题..." value="${d.title}" autocomplete="off">
                    <div style="font-size:0.8rem;color:var(--text-light)" id="save-status"></div>
                    <button class="btn btn-ghost btn-sm" onclick="toggleSettings()"><i class="fa-solid fa-sliders"></i> 设置</button>
                    <button id="save-btn" class="btn btn-sm"><i class="fa-solid fa-floppy-disk"></i> 发布</button>
                </div>
                <div class="editor-toolbar">
                    <button class="tool-btn" data-act="bold" title="加粗 (Ctrl+B)"><i class="fa-solid fa-bold"></i></button>
                    <button class="tool-btn" data-act="italic" title="斜体 (Ctrl+I)"><i class="fa-solid fa-italic"></i></button>
                    <button class="tool-btn" data-act="strike" title="删除线"><i class="fa-solid fa-strikethrough"></i></button>
                    <div class="tool-sep"></div>
                    <button class="tool-btn" data-act="h1">H1</button>
                    <button class="tool-btn" data-act="h2">H2</button>
                    <button class="tool-btn" data-act="h3">H3</button>
                    <div class="tool-sep"></div>
                    <button class="tool-btn" data-act="quote" title="引用"><i class="fa-solid fa-quote-left"></i></button>
                    <button class="tool-btn" data-act="code" title="代码块"><i class="fa-solid fa-code"></i></button>
                    <button class="tool-btn" data-act="link" title="链接"><i class="fa-solid fa-link"></i></button>
                    <button class="tool-btn" data-act="image" title="图片 (可拖拽上传)"><i class="fa-regular fa-image"></i></button>
                    <button class="tool-btn" data-act="table" title="插入表格"><i class="fa-solid fa-table"></i></button>
                    <button class="tool-btn" data-act="task" title="任务列表"><i class="fa-solid fa-list-check"></i></button>
                    <div class="tool-sep"></div>
                    <button class="tool-btn" onclick="toggleZen()" title="全屏专注"><i class="fa-solid fa-expand"></i></button>
                    <button class="tool-btn" onclick="togglePreview()" title="切换预览"><i class="fa-solid fa-eye"></i></button>
                </div>
                <div class="main-area" id="main-area">
                    <div id="drop-zone">松开上传图片</div>
                    <textarea id="co" class="edit-area" placeholder="开始创作... (支持 Markdown, 拖拽上传图片)">${d.content}</textarea>
                    <div id="pre" class="preview-area markdown-body"></div>
                </div>
            </div>
            <div class="drawer-mask" onclick="toggleSettings()"></div>
            <div class="settings-drawer" id="settings-drawer">
                <div class="drawer-header"><h3>文章属性</h3><button class="btn-icon" onclick="toggleSettings()"><i class="fa-solid fa-xmark"></i></button></div>
                <div class="form-group"><label>URL Slug (自定义链接)</label><input id="slug" class="form-input" value="${d.slug || d.id || ''}" ${id ? 'disabled' : ''}></div>
                <div class="form-group"><label>分类</label><input id="category" class="form-input" value="${d.category || ''}" list="cat-list"><datalist id="cat-list"><option value="技术"><option value="生活"></datalist></div>
                <div class="form-group"><label>标签 (逗号分隔)</label><input id="tags" class="form-input" value="${d.tags || ''}"></div>
                <div class="form-group"><label>封面图 URL</label><input id="cover" class="form-input" value="${d.cover || ''}"></div>
                <div class="form-group" style="display:flex;align-items:center;gap:10px;margin-top:20px;"><input type="checkbox" id="isPinned" style="transform:scale(1.2)" ${d.isPinned ? 'checked' : ''}> <label for="isPinned" style="margin:0">置顶文章</label></div>
                <div style="margin-top:auto"><button class="btn btn-ghost" style="width:100%" onclick="toggleSettings()">完成设置</button></div>
            </div>
            <input type="file" id="f" hidden><input id="pid" type="hidden" value="${d.id}">
            <script>
                function initEditor() {
                    const ta=$('#co'),pre=$('#pre'),main=$('#main-area'),fileInput=$('#f');let isDirty=false,renderTimer=null;
                    const renderPreview=()=>{pre.innerHTML=marked.parse(ta.value);pre.querySelectorAll('pre code').forEach((b)=>{if(b.textContent.length>10000)return;hljs.highlightElement(b);});};
                    const sync=()=>{clearTimeout(renderTimer);renderTimer=setTimeout(renderPreview,300);};
                    ta.addEventListener('input',()=>{sync();isDirty=true;autoSave();});
                    ta.addEventListener('scroll',()=>{pre.scrollTop=(ta.scrollTop/(ta.scrollHeight-ta.clientHeight))*(pre.scrollHeight-pre.clientHeight);});
                    renderPreview();
                    const draftKey='blog_draft_'+($('#pid').value||'new');
                    function autoSave(){localStorage.setItem(draftKey,JSON.stringify({title:$('#title').value,content:ta.value,time:Date.now()}));$('#save-status').innerText='已保存草稿 '+new Date().toLocaleTimeString();}
                    if(!$('#pid').value){const saved=localStorage.getItem(draftKey);if(saved){const d=JSON.parse(saved);if(confirm('发现未发布的草稿 ('+new Date(d.time).toLocaleString()+')，是否恢复？')){$('#title').value=d.title;ta.value=d.content;renderPreview();}}}
                    const uploadFile=async(file)=>{if(!file||!file.type.startsWith('image/'))return;const toastId=toast('⏳ 上传中...');const fd=new FormData();fd.append('file',file);try{const r=await fetch('/api/upload',{method:'POST',body:fd});if(r.ok){const d=await r.json();insertText('![Image]('+d.url+')','');if(!$('#cover').value)$('#cover').value=d.url;toast('✅ 上传成功');}else toast('❌ 上传失败');}catch(e){toast('❌ 网络错误');}};
                    main.addEventListener('dragover',e=>{e.preventDefault();main.classList.add('drag-over');});main.addEventListener('dragleave',e=>{e.preventDefault();main.classList.remove('drag-over');});main.addEventListener('drop',e=>{e.preventDefault();main.classList.remove('drag-over');if(e.dataTransfer.files.length)uploadFile(e.dataTransfer.files[0]);});
                    ta.addEventListener('paste',e=>{if(e.clipboardData&&e.clipboardData.files.length){e.preventDefault();uploadFile(e.clipboardData.files[0]);}});
                    const tools={bold:{s:'**',e:'**'},italic:{s:'*',e:'*'},strike:{s:'~~',e:'~~'},code:{s:'\\n\`\`\`\\n',e:'\\n\`\`\`\\n'},quote:{s:'\\n> ',e:''},link:{s:'[',e:'](url)'},h1:{s:'# ',e:''},h2:{s:'## ',e:''},h3:{s:'### ',e:''},table:{s:'\\n| title | title |\\n| --- | --- |\\n| content | content |\\n',e:''},task:{s:'\\n- [ ] 任务1\\n- [ ] 任务2',e:''}};
                    window.insertText=(startStr,endStr)=>{const s=ta.selectionStart,e=ta.selectionEnd;ta.setRangeText(startStr+ta.value.substring(s,e)+endStr,s,e,'select');ta.focus();sync();isDirty=true;};
                    $$('.tool-btn[data-act]').forEach(btn=>{btn.addEventListener('click',()=>{const act=btn.dataset.act;if(act==='image')return fileInput.click();if(tools[act])insertText(tools[act].s,tools[act].e);});});
                    fileInput.addEventListener('change',()=>uploadFile(fileInput.files[0]));
                    document.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey){if(e.key==='s'){e.preventDefault();$('#save-btn').click();}if(e.key==='b'){e.preventDefault();insertText('**','**');}if(e.key==='i'){e.preventDefault();insertText('*','*');}}});
                    $('#save-btn').addEventListener('click',async()=>{const t=$('#title').value;if(!t)return alert('标题不能为空');const btn=$('#save-btn');btn.disabled=true;btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> 发布中...';const postData={id:$('#pid').value,title:t,content:ta.value,tags:$('#tags').value,cover:$('#cover').value,slug:$('#slug').value,category:$('#category').value,isPinned:$('#isPinned').checked};try{const r=await fetch('/api/posts',{method:'POST',body:JSON.stringify(postData)});if(r.ok){localStorage.removeItem(draftKey);isDirty=false;toast('🎉 发布成功！');setTimeout(()=>location.href='/',1000);}else{toast('发布失败');btn.disabled=false;btn.innerText='发布';}}catch(e){toast('网络错误');btn.disabled=false;btn.innerText='发布';}});
                    window.onbeforeunload=()=>isDirty?"有未保存的修改，确定要离开吗？":undefined;
                }
                window.toggleSettings=()=>{ $('#settings-drawer').classList.toggle('open'); $('.drawer-mask').classList.toggle('open'); };
                window.toggleZen=()=>document.body.classList.toggle('zen-mode');
                window.togglePreview=()=>{ const pre=$('#pre'); pre.classList.toggle('hidden'); if(pre.classList.contains('hidden'))$('#co').style.flex='1'; };
            </script>`;
            return response.html(html('编辑器', editorLogic, user));
        }

        if (path === '/admin/media' && user) {
            const list = await env.BLOG_BUCKET.list({ prefix: 'images/', limit: 100 });
            return response.html(html('媒体库', `
                <style>
                    .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 15px; padding-bottom: 40px; } .media-item { position: relative; aspect-ratio: 1; overflow: hidden; cursor: pointer; border: 1px solid var(--border); transition: all 0.2s; background: var(--bg); border-radius: 12px; } .media-item:hover { transform: translateY(-3px); border-color: var(--primary); box-shadow: var(--shadow); z-index: 2; } .media-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
                    .media-del { position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; background: rgba(255,255,255,0.9); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--danger); opacity: 0; transition: all 0.2s; } .media-item:hover .media-del { opacity: 1; } .media-del:hover { background: var(--danger); color: white; transform: scale(1.1); }
                    .batch-mode .media-del { display: none !important; } .media-item.selected { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.3); } .batch-checkbox { position: absolute; top: 8px; left: 8px; width: 20px; height: 20px; background: white; border: 1px solid var(--text-light); border-radius: 4px; display: none; z-index: 5; align-items: center; justify-content: center; color: var(--primary); font-size: 0.8rem; } .batch-mode .batch-checkbox { display: flex; } .media-item.selected .batch-checkbox { background: var(--primary); border-color: var(--primary); color: white; }
                    .batch-bar { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(100px); background: var(--text); color: white; padding: 12px 24px; border-radius: 50px; display: flex; gap: 15px; align-items: center; transition: 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28); z-index: 1000; box-shadow: 0 10px 25px rgba(0,0,0,0.2); } .batch-bar.show { transform: translateX(-50%) translateY(0); } .batch-btn { background: rgba(255,255,255,0.2); border: none; color: white; padding: 6px 12px; border-radius: 20px; cursor: pointer; font-size: 0.9rem; display: flex; align-items: center; gap: 5px; transition: 0.2s; } .batch-btn:hover { background: rgba(255,255,255,0.3); } .batch-btn.danger { background: var(--danger); } .batch-info { font-weight: 500; margin-right: 5px; font-size: 0.95rem; } [data-theme="dark"] .media-del { background: rgba(30, 41, 59, 0.9); }
                </style>
                <div class="dash-header">
                    <div style="display:flex;align-items:center;gap:10px;"><h2>📷 媒体库</h2><span class="badge badge-cat">${list.objects.length} 张图片</span></div>
                    <div style="display:flex;gap:10px"><button class="btn btn-ghost btn-sm" onclick="toggleBatch()"><i class="fa-solid fa-list-check"></i> 批量管理</button><a href="/admin/dashboard" class="btn btn-ghost btn-sm">← 返回</a></div>
                </div>
                <div class="media-grid">
                    ${list.objects.map(o => `<div class="media-item card" onclick="clickImg('${o.key}', this)"><img src="/${o.key}" loading="lazy"><div class="batch-checkbox"><i class="fa-solid fa-check"></i></div><div class="media-del" onclick="event.stopPropagation();delImg('${o.key}')" title="删除"><i class="fa-solid fa-trash"></i></div></div>`).join('')}
                </div>
                ${list.objects.length === 0 ? '<div style="text-align:center;color:var(--text-light);padding:60px;">暂无图片</div>' : ''}
                <div class="batch-bar"><span class="batch-info">已选 <span id="sel-count">0</span> 项</span><button class="batch-btn" onclick="batchCopy()"><i class="fa-regular fa-copy"></i> 复制链接</button><button class="batch-btn danger" onclick="batchDel()"><i class="fa-solid fa-trash"></i> 删除</button><button class="batch-btn" style="background:transparent;padding:0 8px;" onclick="toggleBatch()"><i class="fa-solid fa-xmark"></i></button></div>
                <script>
                    let isBatch=false,selected=new Set();
                    function toggleBatch(){isBatch=!isBatch;document.body.classList.toggle('batch-mode');document.querySelector('.batch-bar').classList.toggle('show',isBatch);if(!isBatch){selected.clear();$$('.media-item.selected').forEach(e=>e.classList.remove('selected'));updateBatchUI();}}
                    function clickImg(k,e){if(isBatch){if(selected.has(k))selected.delete(k);else selected.add(k);e.classList.toggle('selected');updateBatchUI();}else cp('/'+k);}
                    function updateBatchUI(){$('#sel-count').innerText=selected.size;}
                    function cp(u){navigator.clipboard.writeText('![]('+u+')');if(!isBatch)toast('✅ 链接已复制');}
                    async function delImg(k){if(!confirm('确定要永久删除这张图片吗？'))return;try{const r=await fetch('/api/media?key='+encodeURIComponent(k),{method:'DELETE'});if(r.ok){toast('已删除');setTimeout(()=>location.reload(),800);}}catch(e){toast('错误');}}
                    async function batchDel(){if(selected.size===0)return toast('请先选择图片');if(!confirm('⚠️ 警告：确定要删除选中的 '+selected.size+' 张图片吗？此操作不可恢复！'))return;toast('正在删除...');let c=0;await Promise.all(Array.from(selected).map(async k=>{try{if((await fetch('/api/media?key='+encodeURIComponent(k),{method:'DELETE'})).ok)c++;}catch(e){}}));toast('已删除 '+c+' 张图片');setTimeout(()=>location.reload(),1000);}
                    function batchCopy(){if(selected.size===0)return toast('请先选择图片');navigator.clipboard.writeText(Array.from(selected).map(k=>'![](/'+k+')').join('\\n'));toast('✅ 已复制 '+selected.size+' 条链接');toggleBatch();}
                </script>
            `, user));
        }

        // 2. 公开页面
        if (path === '/') {
            const list = await env.BLOG_BUCKET.list({ prefix: 'posts/', limit: 100 });
            let posts = await Promise.all(list.objects.map(async o => await (await env.BLOG_BUCKET.get(o.key)).json()));
            posts.sort((a, b) => (a.isPinned !== b.isPinned) ? (a.isPinned ? -1 : 1) : new Date(b.date) - new Date(a.date));
            const uniqueCats = [...new Set(posts.map(p => p.category || '默认'))];
            const selectedCat = url.searchParams.get('category');
            const categories = [{ name: '全部', url: '/', active: !selectedCat }, ...uniqueCats.map(c => ({ name: c, url: `/?category=${encodeURIComponent(c)}`, active: c === selectedCat }))];
            if (selectedCat) posts = posts.filter(p => (p.category || '默认') === selectedCat);
            const listHtml = posts.length > 0 ? posts.map(p => `
                <div class="card card-hover">
                    ${p.cover ? `<img src="${p.cover}" class="card-cover">` : ''}
                    <div class="card-body" style="padding: 24px;">
                        <div style="margin-bottom:12px;">${p.isPinned ? '<span class="badge badge-pin">📌 置顶</span>' : ''}<span class="badge badge-cat">${p.category || '默认'}</span></div>
                        <h2 style="margin:0 0 10px 0;font-size:1.4rem;line-height:1.4"><a href="/post/${p.id}">${p.title}</a></h2>
                        <p style="color:var(--text-light);margin-bottom:20px;font-size:0.95rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${p.excerpt}</p>
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;color:var(--text-light)"><span>${new Date(p.date).toLocaleDateString()}</span><span><i class="fa-solid fa-eye"></i> ${p.views || 0}</span></div>
                    </div>
                </div>`).join('') : '<div style="text-align:center;width:200%;color:var(--text-light)">该分类下暂无文章</div>';
            return response.html(html(CONFIG.name + ' - 首页', `<div class="grid">${listHtml}</div>`, user, { page: 'home', categories }));
        }

        if (path.startsWith('/post/')) {
            const id = path.split('/')[2];
            const obj = await env.BLOG_BUCKET.get(`posts/${id}.json`);
            if (!obj) return response.error('404 Not Found', 404);
            const p = await obj.json();
            p.views = (p.views || 0) + 1;
            ctx.waitUntil(env.BLOG_BUCKET.put(`posts/${id}.json`, JSON.stringify(p)));
            let comments = []; try { comments = await (await env.BLOG_BUCKET.get(`comments/${id}.json`)).json(); } catch (e) { }
            const commentHtml = comments.length > 0 ? comments.map(c => {
                const avatarChar = (c.user || '访').charAt(0).toUpperCase();
                return `<div class="comment-item"><div class="c-avatar">${avatarChar}</div><div class="c-body"><div class="c-head"><span class="c-user">${c.user}</span><span class="c-date">${new Date(c.date).toLocaleString()}</span></div><div class="c-content">${c.content.replace(/</g, "&lt;")}</div></div></div>`;
            }).join('') : '<div style="text-align:center;padding:30px;color:var(--text-light);background:var(--bg);border-radius:12px;border:1px dashed var(--border)">暂无评论，快来抢沙发吧！</div>';
            
            return response.html(html(p.title, `
                <div style="margin-bottom:20px"><a href="/" class="btn btn-ghost btn-sm"><i class="fa-solid fa-arrow-left"></i> 返回首页</a></div>
                <div class="card" style="margin-bottom: 30px;">
                    ${p.cover ? `<img src="${p.cover}" style="width:100%;height:400px;object-fit:cover;">` : ''}
                    <div class="card-body" style="padding: 40px;">
                        <div style="margin-bottom:15px;text-align:center">${p.isPinned ? '<span class="badge badge-pin">📌 置顶</span>' : ''}<span class="badge badge-cat">${p.category || '默认'}</span></div>
                        <h1 style="font-size:2.5rem;margin-bottom:20px;margin-top:0;text-align:center">${p.title}</h1>
                        <div style="color:var(--text-light);margin-bottom:40px;border-bottom:1px solid var(--border);padding-bottom:30px;text-align:center">📅 ${new Date(p.date).toLocaleString()} &nbsp; 🔥 ${p.views} 阅读</div>
                        <div id="markdown-content" class="markdown-body"></div>
                    </div>
                </div>
                <div class="card comments-sec"><div class="card-body" style="padding: 30px;"><div class="comments-header"><h3><i class="fa-regular fa-comments"></i> 评论 (${comments.length})</h3></div><div class="comment-list">${commentHtml}</div><div class="comment-form-box"><h4 style="margin-top:0;margin-bottom:15px;display:flex;align-items:center;gap:8px"><i class="fa-solid fa-pen"></i> 发表评论</h4><form onsubmit="event.preventDefault();subC()"><div class="c-input-grid"><input id="c-user" class="c-input" placeholder="怎么称呼您？" required maxlength="20"><textarea id="c-content" class="c-input c-textarea" placeholder="写下您的想法..." required></textarea></div><div style="text-align:right"><button class="btn"><i class="fa-solid fa-paper-plane"></i> 发送评论</button></div></form></div></div></div>
                <script>window._RAW_MD = ${JSON.stringify(p.content)};async function subC() {const btn=document.querySelector('.comment-form-box button'),u=$('#c-user').value.trim(),c=$('#c-content').value.trim();if(!u||!c)return toast('请填写完整');btn.disabled=true;try{const res=await fetch('/api/comment',{method:'POST',body:JSON.stringify({postId:'${id}',user:u,content:c})});if(res.ok){toast('评论成功！');setTimeout(()=>location.reload(),800);}else{toast('失败');btn.disabled=false;}}catch(e){toast('错误');btn.disabled=false;}}</script>
            `, user, { excerpt: p.excerpt }));
        }

        if (path === '/about') {
            return response.html(html('关于我', `
                <div class="card"><div class="card-body" style="padding: 40px; text-align:center;"><img src="${CONFIG.bannerUrl}" style="width:80px;height:80px;border-radius:50%;margin-bottom:20px;object-fit:cover;box-shadow:var(--shadow);"><h1 style="font-size:2.0rem;margin-bottom:15px;">关于 ${CONFIG.name}</h1><p style="font-size:1.05rem;color:var(--text-light);margin-bottom:30px;max-width:600px;margin-left:auto;margin-right:auto;">这是一个基于 Cloudflare Workers 和 R2 构建的极简无服务器博客系统。追求极致的加载速度与纯粹的阅读体验。</p><div style="display:inline-flex; align-items:center; gap:15px; flex-wrap:wrap; justify-content:center;"><div style="background:var(--bg); padding:10px 20px; border-radius:50px; font-size:0.9rem; color:var(--text); border:1px solid var(--border); display:flex; align-items:center;"><i class="fa-solid fa-server" style="color:var(--success); margin-right:8px;"></i><span>状态: <span style="color:var(--success);font-weight:bold">运行中</span></span></div><div style="background:var(--bg); padding:10px 20px; border-radius:50px; font-size:0.9rem; color:var(--text); border:1px solid var(--border); display:flex; align-items:center;"><i class="fa-solid fa-clock-rotate-left" style="color:var(--primary); margin-right:8px;"></i><span>已运行: <strong id="run-days" style="color:var(--primary); margin:0 4px;">1</strong> 天</span></div></div><div style="margin-top:40px; border-top:1px solid var(--border); padding-top:30px; color:var(--text-light); font-size:0.9rem;"><p>人生如戏，全靠演技。</p><p>© ${new Date().getFullYear()} ${CONFIG.name}. Powered by Cloudflare.</p></div></div></div>
                <script>const startDate = '2025-06-06'; const start = new Date(startDate); const now = new Date(); const diff = now - start; const days = Math.floor(diff / (1000 * 60 * 60 * 24)); document.getElementById('run-days').innerText = days > 0 ? days : 1;</script>
            `, user, { page: 'about' }));
        }

        return response.error('404 Not Found', 404);
    }
}
