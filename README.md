# dsh-editor-plugin

DeepSeek Harness 插件：在**现有侧边栏**的文档预览上加一个「编辑」按钮，原位编辑 Markdown 等文本文档。

## 功能

- 预览工具栏（与「打开方式 / 自动换行 / 重新加载」同一行）出现铅笔图标「编辑此文件」；只对识别为文本的文件显示（md / txt / json / yaml / 代码等）。
- 点击后在**预览区原位**覆盖一个全文编辑器，文件路径行与工具栏保留：
  - **保存**（`Ctrl+S`）：显式写回磁盘，带版本守卫——文件在磁盘上被改动过则以 409 拒绝并提示先重载；
  - **脏标记**：有未保存修改时标题前出现琥珀色圆点，关闭/重载前弹出确认；
  - **⟳ 从磁盘重载**、**✕ 关闭**（或 `Esc`）。
- 读写走 Host 半边注册的 `/dsh-editor/file` 路由，与内置「打开方式」共用同一套 connection 信任栅栏（Host/Origin 防线 + 浏览器登录鉴权），且经组合的 `fs` 服务落盘——不绕过沙箱/观测策略。

## 结构

```
package.json        dsh.bundle.patch + dsh.client(platform web) 声明
cordis.patch.yml    insert Host 半边
lib/index.js        Host：GET/POST /dsh-editor/file（读全文+版本 / 原子写回+版本守卫）
lib/client.js       Client：编辑按钮 + 原位编辑器（免构建 __ModuleLoader__ CJS 包）
```

## 安装

在 desktop profile 中加入本插件（二选一）：

```powershell
# 方式一：dsh 插件命令
dsh plugin --profile desktop add D:\code\dsh\plugins\dsh-editor-plugin

# 方式二：手动
#   1. 在 C:\Users\sea\.dsh\profiles\desktop\package.json 的 dependencies 加
#      "dsh-editor-plugin": "link:D:/code/dsh/plugins/dsh-editor-plugin"
#      并在 dsh.profile.bundles 数组加 "dsh-editor-plugin"
#   2. 在该 profile 目录执行 pnpm install（生成 node_modules 链接）
```

然后重启 `dsh --profile desktop`（或 DeepSeek Harness 桌面端），刷新 GUI。

## 限制

- 文件上限 4 MB（读取）／8 MB（单次保存请求体）。
- 二进制文件（图片、xlsx、pdf 等）不显示编辑按钮。
- 保存成功后，预览侧依赖其自身的变更观察（`resourceChanged` / 自动刷新）感知新版本；若预览未开启自动刷新，关闭编辑器后手动点一次「重新加载」即可看到新内容。
