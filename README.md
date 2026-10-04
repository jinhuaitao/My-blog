# My Blog · Cloudflare Workers + R2 无服务器博客

单文件 Worker（`worker.js`）实现的博客/CMS，数据全部存放在 R2 存储桶中，无需数据库、无需服务器。

---

## 📦 文件说明

| 文件               | 作用                                     |
| ---------------- | -------------------------------------- |
| `worker.js`      | 全部业务逻辑 + 前端页面（单文件 Worker，ES Module 格式） |
| `wrangler.jsonc` | **部署配置**：声明 Worker 入口与 R2 绑定（自动建桶的关键）  |
| `package.json`   | 部署脚本：先建桶、再部署                           |

> ⚠️ 三者必须同时提交到仓库，缺任何一个，控制台连 Git 部署都无法自动创建/绑定 R2。

---

## 🚀 方式一：控制台连接 GitHub 部署（推荐 · 自动建桶 + 自动绑定）

### 原理

控制台「连接 Git」的构建环境会自动注入一个 API 令牌，该令牌**自带 `Workers R2 Storage (edit)` 权限**。因此只要在部署命令里先建桶，就能实现「零手工操作」。

建桶与绑定分两步完成：

1. **建桶** → 由部署命令 `npx wrangler r2 bucket create blog-bucket` 完成；
2. **绑定** → 由 `wrangler.jsonc` 中的 `r2_buckets` 声明完成，部署时自动写入 Worker 的 Binding，**不需要再去控制台点「添加绑定」**。

### 操作步骤

1. **推送代码到 GitHub**（确保 `worker.js`、`wrangler.jsonc`、`package.json` 都在仓库根目录）：
   ```bash
   git add worker.js wrangler.jsonc package.json README.md
   git commit -m "chore: 添加 wrangler 配置，支持自动创建并绑定 R2"
   git push
   ```
2. **进入 Cloudflare 控制台** → `Workers 和 Pages` → `创建应用程序` → `Workers` → **`连接到 Git`**（Import a repository）。
3. **选择仓库与分支**（默认 `main`），点击下一步。
4. **填写构建设置**（这一步是重点）：
   | 配置项                  | 填写内容             |
   | -------------------- | ---------------- |
   | 构建命令（Build command）  | **留空**           |
   | 部署命令（Deploy command） | `npm run deploy` |
   | 根目录（Root directory）  | 留空（仓库根目录）        |
   > 也可以不用 `npm run deploy`，直接把部署命令写成：  
   > `npx wrangler r2 bucket create blog-bucket; npx wrangler deploy`
   >
   > 用 `;` 而不是 `&&`：桶已存在时 `create` 会报错，用 `;` 可以保证后面的 `deploy` 照常执行，实现「幂等建桶」。
5. **点击保存并部署**。构建日志中会依次出现：
   ```
   Creating bucket 'blog-bucket'...        ← 桶不存在时创建；已存在则报错后继续
   Uploading... / Deployed my-blog ...     ← 部署 Worker 并写入 R2 绑定
   ```
6. **验证**：访问 Worker 域名，出现「初始化 CMS」页面即代表 `env.BLOG_BUCKET` 绑定成功（该页面就是读 R2 的 `sys/config.json` 失败时的兜底页）。设置管理员账号后即可使用。

### 关于自动配置（Autoconfig）

仓库里**已经有** `wrangler.jsonc`，所以控制台不会触发 Autoconfig，也就不会给你提 PR 要求补配置——这是有意为之，避免多一轮人工合并。

---

## ⚡ 方式二：一键「Deploy to Cloudflare」按钮（Cloudflare 官方自动资源配置）

这是 Cloudflare 官方唯一**原生支持自动创建资源**的通道：读取仓库中的 Wrangler 配置文件，自动开通 KV / D1 / **R2** / Hyperdrive / Vectorize 等资源，并自动完成绑定，无需写任何命令。

在 README 中嵌入按钮（把 URL 换成你自己的仓库）：

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<你的用户名>/<仓库名>)
```

注意：该方式要求仓库为**公开**的 GitHub/GitLab 仓库，且会先把仓库克隆到你自己的 GitHub 账号下。

---

## 💻 方式三：本地 Wrangler 部署

```bash
npm install
npx wrangler login
npm run deploy        # 等价于：先建桶，再部署
```

本地部署时，`wrangler r2 bucket create` 会用你登录账号的权限建桶，效果与方式一一致。

---

## 🔧 手动配置（备选，不需要自动建桶时使用）

1. **创建 R2 存储桶**：控制台 → `R2 对象存储` → `创建存储桶`，命名为 `blog-bucket`。
2. **创建 Worker**：`Workers 和 Pages` → `创建应用程序` → `创建 Worker`。
3. **配置绑定**：进入 Worker → `设置` → `变量与机密 / 绑定` → 添加 `R2 存储桶` 绑定：
   - 变量名称（Variable Name）：**`BLOG_BUCKET`**（必须完全一致，大小写敏感）
   - R2 存储桶：选择 `blog-bucket`

---

## ⚙️ 需要改名的场景

若想换桶名或 Worker 名，**两个文件必须同步修改**：

- `wrangler.jsonc` → `name`（Worker 名）、`r2_buckets[0].bucket_name`（桶名）
- `package.json` → `deploy` 脚本里 `r2 bucket create` 后面的桶名

约束：

- `bucket_name` 只能用小写字母、数字、中划线，3–63 字符（不能有下划线）；
- `binding` 名字**不要改**，必须保持 `BLOG_BUCKET`，否则 `worker.js` 里 `env.BLOG_BUCKET` 会取到 `undefined`，全站报错。

---

## 🛠 后台管理

登录后访问 `/admin/dashboard`，顶部有统一的五个入口：

| 页面 | 路径                 | 能做什么                                              |
| -- | ------------------ | ------------------------------------------------- |
| 概览 | `/admin/dashboard` | 文章 / 评论 / 总阅读 / 图片 四项指标，最近文章、阅读排行                 |
| 文章 | `/admin/posts`     | 按标题正文标签搜索、按分类筛选、分页、置顶切换、单篇删除、批量删除                 |
| 评论 | `/admin/comments`  | 按文章分组查看全部评论，删除单条或清空某篇的全部评论                        |
| 媒体 | `/admin/media`     | 上传（点击或拖拽，支持多选）、按文件名筛选、批量复制链接、批量删除                 |
| 设置 | `/admin/settings`  | 站点名称/副标题/域名/背景图/Favicon/每页条数/Google 验证码/Turnstile 密钥，以及修改管理员密码 |

写作入口是 `/admin/edit`，支持 Markdown 实时预览、工具栏、字数统计、未保存提示、本地草稿自动保存、拖拽与粘贴上传图片、全屏专注模式，快捷键 `Ctrl/⌘+S` 保存、`Ctrl/⌘+B` 加粗、`Ctrl/⌘+I` 斜体、`Ctrl/⌘+K` 链接。

### 两个安全约定

- **输出转义**：文章标题、分类、标签、评论昵称与内容在拼接进页面前都会经过 `esc()`，标题里写 `<script>` 不会被执行。
- **R2 键名安全化**：文章别名与上传文件名会经 `safeKey()` / `safeFileName()` 处理，去掉路径分隔符，避免写出目录结构或覆盖 `sys/` 下的系统文件。

---

## 🔐 人机验证（Turnstile）

登录页可以挂 Cloudflare Turnstile 人机验证，密钥直接在后台「设置」页配置，**改完立即生效，不需要重新部署**。

### 怎么开

1. 到 Cloudflare 控制台 → **Turnstile** → **添加站点**，拿到 **Site Key** 与 **Secret Key**；
2. 后台 `/admin/settings` → 「人机验证（Turnstile）」卡片，两项都填入 → 保存；
3. 卡片右上角的徽标从「未启用」变成「已启用」，登录页即出现验证组件。

**两项都填且格式正确才会启用**（真实密钥以 `0x` 开头），只填一项不生效——这样是为了避免出现「加载了验证组件但服务端不校验」的半吊子状态。

### 三条设计约定

| 约定 | 说明 |
| -- | -- |
| **Secret Key 绝不回显** | 输入框 `type="password"`、不带 `value` 属性，页面源码里拿不到已保存的私密密钥。 |
| **留空 = 不修改** | 已配置后再保存其他设置，留空不会把密钥误删。想彻底关闭，点输入框旁的「清除」按钮（可再点一次「撤销」）。 |
| **环境变量优先级最高** | 若用 `wrangler secret put TURNSTILE_SECRET_KEY` 注入了密钥，它覆盖后台设置，输入框会禁用并提示「需在 Cloudflare 后台修改」。这是更安全的做法。 |

> 关于 Site Key 与 Secret Key 的差别：Site Key 是**公开**的，会出现在登录页 HTML 里，所以后台会正常回显；Secret Key 只在服务端调用 `siteverify` 时使用，**必须保密**。

---

## 🧩 站点信息配置

**推荐在后台「设置」页里改**，改完立即生效，无需重新部署（配置存在 R2 的 `sys/settings.json`）。

也可以改 `worker.js` 顶部的 `CONFIG` 作为默认值：

```js
const CONFIG = {
    name: "博客世界",
    desc: "人生如戏",
    url: "https://your-domain.com",
    pageSize: 6,          // 首页每页文章数
    bannerUrl: "https://.../banner.webp",
    favicon: "https://.../favicon.webp",
    googleVerify: "",     // 只填自己的验证码
    turnstileSiteKey: "", // 留空 = 关闭人机验证
    turnstileSecretKey: "",
};
```

> `turnstileSiteKey` / `turnstileSecretKey` 属于敏感信息，建议改用 `wrangler secret put` 注入，不要写死在代码里。注意：**不要保留 `0x4AAAAAA...` 这类占位符**，它会被误判为「已开启」而导致登录页异常。

---

## ❓ 常见问题

**Q：部署报错 `The bucket 'blog-bucket' does not exist`？**  
部署命令里没有先建桶。把部署命令改成 `npx wrangler r2 bucket create blog-bucket; npx wrangler deploy`（注意是分号）。

**Q：部署报错 `Authentication error` / `10000`？**  
构建使用的 API 令牌缺少 R2 权限。到 Worker → `设置` → `构建` → `API 令牌`，重新选择/创建一个带 `Workers R2 Storage (edit)` 的令牌。

**Q：部署成功但访问报错、页面读不到数据？**  
绑定的变量名不是 `BLOG_BUCKET`。检查 `wrangler.jsonc` 的 `binding` 字段，以及控制台 `设置` → `绑定` 中是否只有这一个 R2 绑定（重复绑定会冲突）。

**Q：改了 `wrangler.jsonc` 后没生效？**  
构建设置的修改只对**下一次构建**生效，重新推送一次提交或点「重试构建」。

**Q：填好账号密码后，点「立即登录」完全没反应（页面不动、也不报错）？**  
这是**Turnstile 占位符**导致的。`worker.js` 里原本写着 `turnstileSiteKey: "0x4AAAAAA..."`，判断条件是 `length > 5`，于是这个假密钥被当成了「已开启」，登录页会去渲染一个非法的验证组件；Cloudflare 的 `api.js` 因为 sitekey 非法无法初始化，点击时 `turnstile.getResponse()` 直接抛 `ReferenceError: turnstile is not defined`，函数中途中断，请求根本没发出去。

修复方式（已内置）：

- `CONFIG.turnstileSiteKey` / `turnstileSecretKey` 默认留空；
- 新增 `turnstileEnabled()`，用正则 `/^0x[A-Za-z0-9_-]{20,}$/` 判断密钥是否为**真实**密钥，占位符一律视为未开启；
- 前端 `login()` 增加 `typeof turnstile === 'undefined'` 守卫，失败时恢复按钮状态并给出明确提示。

要真正启用 Turnstile：到 Cloudflare 控制台 → `Turnstile` → 添加站点，把拿到的 Site Key / Secret Key 填进后台「设置」页（推荐），或用 `wrangler secret put TURNSTILE_SECRET_KEY` 注入（优先级更高）。

**Q：控制台（F12）看到 `Invalid input for parameter "sitekey"`？**  
同上，说明填的是占位符而不是真实密钥。
