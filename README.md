# 学习中心（Learning Center）

本地优先的个人知识库与 AI 伴读工作台。支持收藏网页、YouTube/B 站视频、PDF、Markdown 笔记与图片到多个圈子，在本地嵌入式 PostgreSQL（PGlite + `pgvector`）中完成解析、混合检索、AI 智能分析、右侧分屏伴读、互动测验、交互式代码画布与 SM-2 间隔复习。

> **隐私与安全**：所有资料、笔记、对话与在界面中填写的 API Key 均仅保存在本地 `.data/` 目录中（已在 `.gitignore` 中忽略，不会提交到 Git 仓库）。

---

## 快速安装与启动

环境要求：**Node.js 24.15+ 或 Node.js 26+**（macOS / Linux / Windows 均可）。

### 方式一：终端一键拉取并启动（推荐 · macOS / Linux）

在终端直接运行以下一行命令，自动检测 Node 环境、拉取代码、安装依赖、构建并启动：

```sh
curl -fsSL https://raw.githubusercontent.com/tyyt53909-create/learning-center/main/scripts/install.sh | bash
```

> 可选环境变量：`INSTALL_DIR=~/my-learning-center`（自定义安装目录）、`AUTO_START=0`（仅安装不立即启动）。

### 方式二：手动克隆运行（全平台通用）

```sh
git clone https://github.com/tyyt53909-create/learning-center.git
cd learning-center
npm ci
npm start
```

启动后打开浏览器访问 **`http://127.0.0.1:3000`**。首次使用可在左下角点击 **「AI 设置」** 填入任意兼容 OpenAI 的模型服务与 API Key（支持 OpenAI、DeepSeek、通义千问、硅基流动、本地 Ollama），也支持复制 `.env.example` 为 `.env` 通过环境变量配置。

---

## 核心功能

- **阅读页右侧 AI 伴读侧栏（`⌘.` / `Ctrl+.`）**：在阅读任意文章、PDF、笔记或视频时，可一键在右侧展开分屏伴读侧栏，上下文自动绑定当前资料；支持「对话 / 出题 / 画布」模式切换、联网开关、点击引用原地跳转高亮原文段落，以及一键「记入本篇笔记」。
- **全类型 AI 智能分析**：针对文章、Markdown、PDF、有字幕/无字幕视频以及图片自动生成结构化分析（主要讲了什么、核心要点拆解、原文锚点引用、推荐标签与圈子），每条要点支持一键转为复习闪卡。
- **独立 AI 问答与交互工坊（`/ask`）**：支持在全部资料、指定圈子或单篇资料范围内基于关键词 + `pgvector` 向量混合检索作答；内置 **互动选择题**、沙箱运行的 **交互式代码画布（Canvas）** 与 **AI 联网搜索（DuckDuckGo 免密钥默认，可选 Tavily / Brave / Serper / SearXNG / 自定义接口）**。
- **Chrome 剪藏扩展 & 自动化安装**：在左下角点击「了解浏览器扩展」，本机支持一键自动打开 Chrome 扩展管理页并定位 `dist/extension` 文件夹，拖入 Chrome 即可安装；也提供免安装的「一键书签」方案。
- **在线与本地视频**：YouTube 支持免 `yt-dlp` 直连抓取字幕与视频简介（无字幕视频支持手动「粘贴字幕/文稿」并自动触发 AI 分析）；支持倍速播放、字幕筛选与时间戳笔记。本地视频可配合 `faster-whisper`（`WHISPER_PYTHON`）生成字幕。
- **圈子分类与智能分类**：圈子支持分类分组展示，以及关键词、来源域名、资料类型、AI 推荐与向量相似度智能归类。
- **间隔复习与知识闪卡（`/review`）**：内置 SM-2 间隔重复算法（`Space` 翻面、`1–4` 评分），支持由要点/笔记或 AI 深度制卡，每张卡片均可一键跳回原文位置。

---

## 数据与部署说明

- 默认使用嵌入式 PGlite（含 `pgvector`）与本地文件存储，数据位于 `.data/` 目录。
- 如需接入独立 PostgreSQL，设置 `DATABASE_URL`（需启用 `vector` 扩展），首次启动自动建表。
- 默认仅监听 `127.0.0.1`；如需局域网/公网监听（修改 `HOST`），必须同时设置 `ACCESS_TOKEN`。

```sh
npm run build  # 仅构建 Web 前端与 Chrome 扩展（输出到 dist/）
```
