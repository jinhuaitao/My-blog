## 🚀 快速部署与配置

1. 创建 R2 存储桶进入 Cloudflare Dashboard。导航至 R2 对象存储 -> 点击 创建存储桶（如命名为 blog-bucket）。

2. 创建 Cloudflare Worker导航至 Workers 和 Pages -> 点击 创建应用程序 -> 创建 Worker。

3. 配置存储桶绑定 (Binding)进入 Worker 控制台 -> 设置 (Settings) -> 变量与机密 (Variables & Secrets) / 绑定 (Bindings)。
添加 R2 存储桶绑定：变量名称 (Variable Name)：必须命名为 BLOG_BUCKET  R2 存储桶 (R2 Bucket)：选择刚才创建的桶（如 blog-bucket）保存更改。
