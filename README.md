[README.md](https://github.com/user-attachments/files/31180901/README.md)
# YouTube Digest — Bilibili 支持版

> Turn every YouTube and Bilibili video into a resource for deep learning.
> 把每个 YouTube 和 B站视频变成一份可以深入学习的资料：字幕、双语翻译、AI 概览、内容讲解和时间戳笔记，全部收进同一个 Chrome 侧边栏。

## What's new in this derivative version

**Derivative version now supports Bilibili!**

1. Added Bilibili reading/parsing support.
2. Swapped out the Supadata API to avoid registration; now directly uses YouTube and Bilibili's built-in AI subtitles. (Next step: figure out a fallback when built-in subtitles aren't available.)
3. Replaced Deepseek API with a custom endpoint + API key setup. Now you can use any token plan or even piggyback on free tokens from providers!
4. Integrated one-click transcript download.
5. Added bilingual English and Chinese versions for Keynotes.
6. During development, I built this entirely through natural language conversations with LLMs, and tried out Qoder with qwen3-max (is it actually a bit smarter?).

Special thanks again to **Zarazhangrui** for showing me the ropes! This plugin is a derivative of her original work.

## 这个改版带来了什么

**本衍生版本现已支持 Bilibili！**

1. 新增 B站视频的读取与字幕解析支持。
2. 移除了 Supadata API，免去注册流程；现在直接读取 YouTube 和 B站自带的字幕。（下一步：研究无自带字幕时的兜底方案。）
3. 把 Deepseek API 换成了自定义接口 + API 密钥的设置方式。你可以使用任意 token 套餐，甚至"蹭"服务商的免费额度！
4. 集成了一键下载逐字稿（Word 格式）。
5. 为 Keynotes（要点笔记）增加了中英双语版本。
6. 开发全程完全通过与大模型的自然语言对话完成，还试用了 Qoder 搭配 qwen3-max（好像确实聪明一点？）。

再次特别感谢 **Zarazhangrui** 的领路！本插件是基于她原作的衍生版本。

## Features / 功能一览

- Original, Simplified Chinese, and aligned bilingual transcript views / 原文、简体中文翻译、双语对照字幕
- AI overviews, chapters, key quotes, and selected-text explanations / AI 概览、章节、重点引用、选中讲解
- Timestamped notes with automatic polishing / 自动润色的时间戳笔记
- One-click transcript export to Word / 一键导出 Word 逐字稿
- Bring your own OpenAI-compatible endpoint; keys stay in local Chrome storage / 自带任意 OpenAI 兼容接口，密钥只保存在本地

## Install / 安装

1. Clone or download this repository to a permanent folder.
   把本仓库克隆或下载到一个长期保留的文件夹。
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
   在 Chrome 中打开 `chrome://extensions`，开启**开发者模式**。
3. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
   点击**加载已解压的扩展程序**，选择包含 `manifest.json` 的项目文件夹。
4. Open **Settings** from the side panel, then enter your API base URL, API key, and model.
   在侧边栏打开**设置**，填入 API 接口地址、密钥和模型名称。

Default endpoint: Alibaba Cloud DashScope (Qwen) — `https://dashscope.aliyuncs.com/compatible-mode/v1`, model `qwen-plus`. Any OpenAI-compatible Chat Completions endpoint works.

For Bilibili, sign in to `bilibili.com` in the same browser first — subtitles are only returned for logged-in accounts.

> ⚠️ Never paste your API key into chats, issues, screenshots, or source files. Enter it only in the extension Settings page.
> 请勿把 API 密钥发到聊天、issue、截图或源代码中，只在扩展设置页面填写。

## Documentation / 完整文档

- [完整中文说明](README.zh-CN.html)
- [Full English README](README.html)
- [Privacy / 隐私说明](PRIVACY.html)
- [Security / 安全说明](SECURITY.html)

## License

MIT. See [LICENSE](LICENSE.html). This is a personal remix project; upstream issues and pull requests are not accepted. Feel free to fork and make it your own.
