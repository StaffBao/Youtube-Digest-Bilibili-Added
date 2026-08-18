# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

把每个 YouTube 和 Bilibili 视频变成一份可以深入学习的资料。YouTube Digest 把字幕、双语翻译、AI 概览、内容讲解和时间戳笔记放进同一个 Chrome 侧边栏，让你可以持续学习视频中的知识和语言，同时不丢失原视频上下文。

- 把零碎字幕变成清晰、可搜索的学习资料。
- 查看原文、简体中文翻译，或中英双语对照字幕来学习语言。
- 通过 AI 概览、章节、重点引用和选中文本讲解建立系统理解。
- 点击字幕、概览或笔记中的时间戳，快速跳转到对应位置。
- 保存自动润色的时间戳笔记，方便之后复习。
- 使用自己的 AI 接口，数据保存在本地 Chrome 中，不包含分析统计或行为追踪。

YouTube Digest 是一个需要自行提供 AI 接口的开源项目，通过 GitHub 安装。目前没有上架 Chrome 应用商店，也没有开发者运营的服务器。

## 让你的编程 Agent 帮你安装

你不需要看懂代码，也不需要会使用命令行。把下面这段话发送给你的编程 Agent：

> 请把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome“加载已解压的扩展程序”使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`，但不要假设我一定使用这些路径。请用简单易懂的语言一步一步指导我完成安装和配置。

你的 Agent 应该帮你：

1. 先询问你想把项目长期保存在哪里，再下载或克隆到那里，并告诉你准确的完整路径。
2. 指导你在 Chrome 中通过“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹。
3. 告诉你应该在扩展的“设置”页面哪个位置填写 API 接口地址、API 密钥和模型名称。
4. 打开一个带字幕的 YouTube 或 B站视频，确认字幕和翻译功能可以使用。

安装后请让这个文件夹留在原位。如果移动或删除它，Chrome 中加载的本地扩展会失效，需要从新的长期存放位置重新加载。

不要把 API Key 发送到 AI 对话、源代码、截图或公开消息中。请你自己在 YouTube Digest 的设置页面直接填写。编程 Agent 可以告诉你填写位置，但不需要看到 Key。

## 手动安装

如果你想自己操作：

1. 选择一个长期保留的文件夹，并把项目解压或克隆到这里。可选建议是 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`。你也可以使用其他文件夹。
2. 在 Chrome 地址栏打开 `chrome://extensions`。
3. 打开右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest.json`。
6. 如果需要，可以在 Chrome 扩展菜单中固定 YouTube Digest。

这是一个本地加载的扩展，不会自动更新。下载新版或让 Agent 修改代码后，请在 `chrome://extensions` 中找到 YouTube Digest 并点击“重新加载”，然后刷新已经打开的视频页面。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

## 设置你的 AI 接口

YouTube Digest 无需字幕服务的 API Key，也无需注册。字幕直接从视频页面读取：YouTube 字幕轨道直接从 YouTube 下载；Bilibili 字幕使用你浏览器中已登录的 B站账号获取。

AI 功能（概览、讲解、翻译、笔记润色）需要配置任意 OpenAI 兼容的 Chat Completions 接口，共三个字段：

1. **API 接口地址**：服务商提供的 Chat Completions 接口地址。默认为阿里云百炼 DashScope（Qwen）：

   ```text
   https://dashscope.aliyuncs.com/compatible-mode/v1
   ```

2. **API 密钥**：服务商签发的密钥。如果使用 DashScope，请在百炼控制台创建密钥后粘贴到设置中。
3. **模型**：你的接口可接受的模型名称，例如 `qwen-plus`（默认）、`qwen-max`、`deepseek-chat` 或 `gpt-4o-mini`。

在侧边栏中打开 **Settings**。你也可以在 `chrome://extensions` 的 YouTube Digest 卡片中打开扩展选项。Key 只能粘贴到设置输入框中。不要把 Key 发送到 AI 对话、项目文件、截图或公开消息中。

在网关支持的情况下，YouTube Digest 会让所有 AI 请求使用非思考模式，以获得更快、更稳定的交互。API Key 和设置保存在你设备上的 Chrome 扩展本地存储中。发布包不会包含或使用 `config.js`。

## 启用 Bilibili 模式

Bilibili 支持默认开启，可以在设置中关闭：

1. 先在同一个浏览器中登录 `bilibili.com`。B站的字幕接口只对已登录账号返回字幕。
2. 打开 `bilibili.com/video/...` 视频页。Digest 按钮和侧边栏的使用方式与 YouTube 相同。
3. 如果视频没有字幕，或者你没有登录，侧边栏会明确说明原因，而不是静默失败。

## 使用 YouTube Digest

1. 打开一个有字幕的普通 YouTube 视频页面，或在已登录状态下打开 B站视频页面。
2. 点击 YouTube Digest 扩展图标，打开侧边栏。
3. 阅读带时间戳的字幕，或选择 **Original**、**中文**、**双语**。
4. 打开 **Overview**，查看 AI 生成的章节和重点引用。
5. 选中字幕，获取 AI 内容讲解。
6. 从播放器或重点引用中保存笔记，之后可以在 **Notes** 中查看。

## 当前支持范围

- Chrome 116 或更高版本。
- 标准的 `youtube.com/watch` 视频页面和 `bilibili.com/video` 视频页面。
- 直接从平台读取的原生字幕。YouTube Digest 优先选择人工字幕，优先中文或英文，也可能显示其他可用的原生语言。
- 原文、简体中文和双语对照字幕。
- 通过你配置的任意 OpenAI 兼容接口使用 AI 概览、选中文本讲解、翻译和自动润色笔记。
- 本地笔记，以及最近字幕、概览和翻译的本地缓存。

Shorts、直播、私密视频、受访问限制的视频，以及没有原生字幕的视频可能无法使用。目前没有测试 Firefox、Safari、移动浏览器或其他 Chromium 浏览器。

在没有原生字幕时，YouTube Digest 不会请求 AI 生成转录，也不会在本地转录音频。

## AI 使用成本

字幕获取是免费的：直接使用各平台自己的字幕接口。AI 费用由你配置的服务商按其价格计费，取决于服务商定价、所选模型，以及你使用概览、讲解、翻译和笔记润色的频率。翻译是延迟按需和渐进式的：已缓存的分段会复用，只有滚动到并请求的字幕行才会发起调用。建议在服务商账号中设置消费上限。

## 用编程 Agent 改造成自己的版本

这是一个个人 Remix 项目，不接受上游 Issue 或 Pull Request。如果功能出错，或者你想增加新功能，请下载或 Fork 自己的副本，再让你的编程 Agent 帮你修复、改造和个性化。

YouTube Digest 使用原生 HTML、CSS 和 JavaScript，没有构建步骤，很适合用编程 Agent 做个人项目。你可以尝试：

- 增加更多翻译语言，并让每个人选择自己的学习语言。
- 为课程、访谈、教程、测评或研究视频增加自定义总结模板。
- 增加生词本，保存单词、原句、解释和视频时间戳。
- 把笔记和生词导出到 Markdown、CSV、Anki 或其他学习工具。
- 增加个人主题筛选，只突出与你目标相关的章节。
- 增加本地模型选项，获得不同的隐私和成本方案。
- 改善键盘操作、字体大小和高对比度等无障碍体验。

请让 Agent 保留用户自带 API Key 的模式，不要把秘密写入源代码，并运行下方检查。分享自己的版本前，也要在真实视频上测试。

如果需要接入不遵循 OpenAI Chat Completions API 的服务，请先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 YouTube Digest 项目文件夹。然后打开 YouTube Digest 设置并点击 **Copy customization prompt**。发送前替换 `[PROVIDER]`，但不要加入任何 API Key。Agent 完成本地代码修改后，请你自己在它指出的设置位置填写 Key。

## 隐私和数据流向

YouTube Digest 会直接从扩展向各平台和你配置的服务商发送请求：

1. 从 YouTube 自己的 timedtext 接口下载字幕，或使用你浏览器的登录态从 B站字幕接口获取字幕。
2. 当你使用 AI 功能时，把字幕和相关视频信息发送给你配置的 AI 接口。
3. 翻译或讲解等功能只发送当前需要的内容，例如选中的文本和上下文，或少量字幕分段。
4. API Key、设置、笔记和最近缓存保存在 Chrome 本地。

YouTube Digest 没有账号系统、广告、分析统计或行为追踪。你配置的 AI 服务商仍会按照其条款和隐私政策处理数据。详情请查看 [PRIVACY.md](PRIVACY.md)。

## 常见问题

### YouTube 视频页面没有显示 Digest 按钮

- 在 `chrome://extensions` 中找到 YouTube Digest，点击“重新加载”，然后刷新 YouTube 页面。
- 确认当前页面是标准 `https://www.youtube.com/watch?...` 页面，而不是 Shorts、嵌入页面或直播页面。
- 当前版本会在 YouTube 响应式操作栏变化时自动重新定位按钮。页面加载完成后可以稍等片刻。
- 如果按钮仍然没有出现，让你的编程 Agent 在这个具体视频页面检查 content script。

### 侧边栏无法打开

- 确认你打开的是标准 `https://www.youtube.com/watch?...` 页面，或 `https://www.bilibili.com/video/...` 页面。
- 在 `chrome://extensions` 中确认 YouTube Digest 已启用，并点击“重新加载”。
- 重新加载扩展后，刷新视频页面。
- 如果问题仍然存在，让你的编程 Agent 检查扩展。

### YouTube Digest 提示需要设置

- 打开 **Settings**，保存 API 接口地址、API 密钥和模型。默认指向阿里云百炼 DashScope 和 `qwen-plus`，如果你使用 DashScope，只需要粘贴密钥。
- 如果设置提示旧的自定义服务已移除，请重新填写三个字段。旧 AI Key 已安全清除，避免被错误用于其他服务。

### 找不到字幕

- 确认视频是公开的，并且有原生字幕。
- 没有字幕的 YouTube 视频无法生成字幕。YouTube Digest 不会自动改用 AI 生成字幕。
- 对于 Bilibili：请确认已在同一个浏览器登录 `bilibili.com`。字幕只对已登录账号返回，而且很多视频本身没有字幕。

### AI 请求失败

- `401` 或 `403` 通常表示 API Key 与配置的接口地址不匹配或已失效。
- `404` 通常表示接口地址或模型名称填写有误。
- `429` 通常表示达到了服务商限速或消费上限。
- 如果你把本地副本改成了非兼容模型，请再次使用设置中的自定义 prompt，让编程 Agent 检查本地实现。

不要在对话、截图或日志中分享 API Key、私密字幕或个人笔记。

## 给编程 Agent 的检查命令

修改项目后，让你的编程 Agent 运行：

```bash
npm test
npm run check
npm run package
```

Agent 还应该在 Chrome 中重新加载扩展，并测试多个真实 YouTube 和 Bilibili 视频。自动检查通过，不代表真实服务请求和平台交互一定正常。

## 开源许可

MIT，详见 [LICENSE](LICENSE)。
