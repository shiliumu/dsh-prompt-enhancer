# dsh-prompt-enhancer

DSH Web UI 的**提示词增强器**：在聊天输入框工具行加一个 ✨ 按钮，点一下就用你本地已配置的
**flash 模型**把口语化草稿改写成结构清晰的提示词，候选直接显示在输入框上方的候选框里，
用键盘选一个采纳进输入框；模型**不敢替你决定**的地方，会给你一组**方向选项**去点。

> 仓库：https://github.com/shiliumu/dsh-prompt-enhancer
> 许可：MIT ｜ 仅使用官方插槽扩展点，不改 DSH 源码

```
输入框: 帮我看看这个爬虫为啥老是断            ← 点 ✨ 或 Ctrl+Shift+Enter
        ↓
候选框: ✨ 提示词候选  [deepseek-v4-flash-0731 · tokenrhythm ▾]  看方向图   Esc 关闭
        1  排查这个爬虫反复中断的问题。请先复现一次并收集证据…      待定 2 处
        2  先不要直接改代码，请先给我一份排查方案…
        3  请先抓取并复现这个爬虫「断」的现象…

        ┌ 需要你拍板 2 处 · 已定 0/2 ──────────────────────────────┐
        │ 1 这次要动代码吗？                                       │
        │   (1) 只诊断不改代码   (2) 诊断+修复                     │
        │ 2 跑多久算稳？                                           │
        │   (1) 30 分钟   (2) 2 小时                              │
        └──────────────────────────────────────────────────────────┘
        ↑↓ 切换候选 · 1/2/3 采纳 · ←→ 重新生成 · Tab 进入拍板 · Esc 关闭
        ↓ 点「看方向图」
        ┌──────────────────────────────────────────────────────────┐
        │ 草稿：帮我看看这个爬虫为啥老是断                          │
        │ ├─ 1 这次要动代码吗？                                     │
        │ ├─ 只诊断不改代码                                        │
        │ │   └ 效果：最快、零风险；可能要多来一轮                  │
        │ └─ 诊断+修复   ◀ 当前                                    │
        │     └ 效果：一次到位；判断错会白改一轮                    │
        └──────────────────────────────────────────────────────────┘
```

采纳时你选的方向会**原地替换**正文里的 `<待确认：…>`；没有对应占位符的（属于新增约束）
统一追加到文末的 `【补充要求】`。

## 功能

- **✨ 按钮**：注册在官方插槽 `conversation.input.right`（输入框工具行右侧、模型选择器左边）。
- **候选框**：注册在官方插槽 `conversation.input.dock`（输入卡片上方整行，和 token 统计同一区域）。
- **模型选择**：按 `id`/`name` 里含 `flash` 的模型优先，且优先当前默认 provider；
  一个 flash 都没有时，候选框变成模型列表，按数字键挑一个（选择会记住，直到重开会话）。
- **生成后换模型**：候选框表头显示当前模型（如 `DeepSeek V4 Flash · TokenRhythm ▾`），点它
  弹出模型列表（当前模型高亮），数字键或点击选择 → 立刻用新模型重新生成同一份草稿；
  此时 `Esc` 是退回候选而不是关掉面板。
- **待定点 → 方向选项框**（v0.2.0）：模型"不该替你决定"的地方不再只留 `<待确认：…>`，
  而是给出 2–4 个**方向选项**让你点选。每个选项带一句「效果」说明选它会往哪走。
  候选卡上有 `待定 N 处 / 已定 N/N` 标记。
- **效果方向缩进树**（v0.2.0）：点表头「看方向图」展开一棵缩进树，把每个待定点的各个方向
  和它们的后果并列出来，当前选择高亮。默认收起，不挤压输入框。
- **采纳**：走官方 `inputActions.setDraft(text)`，整段替换草稿且并入撤销历史（Ctrl+Z 可回退）。
  采纳时会把你选的方向填回去：正文里有对应 `<待确认：…>` 就**原地替换**，
  没有对应占位符的（属于"新增约束"）统一追加到文末的 `【补充要求】`。
- **生成约束**：只做结构化补全，禁止编造文件/报错/需求；
  原样保留 `@引用`、`/命令`、路径、报错原文。

## 键盘

| 按键 | 行为 |
|---|---|
| `Ctrl+Shift+Enter` | 生成（候选框已打开时则关闭） |
| `↑` / `↓` | 切换候选（拍板模式下：切换待定点） |
| `1`–`9` | 直接采纳第 N 个候选（模型列表态选模型；拍板模式下选第 N 个方向） |
| `Enter` | 采纳当前高亮候选（拍板模式下：退回候选） |
| `←` / `→` | 换一个角度重新生成（拍板模式下：在同一待定点的方向间切换） |
| `Tab` | 在「选候选」与「拍板方向」之间切换焦点 |
| `0` | 拍板模式下清除当前待定点的选择 |
| `Esc` | 关闭候选框（模型列表 / 拍板模式下：退回上一层） |
| 点模型名 | 打开模型列表，换模型重新生成 |
| 点方向 chip | 选中 / 取消该方向 |

## 安装

沙箱/权限原因，安装脚本需要**你自己在终端里跑**（普通 PowerShell，无需管理员）：

```powershell
cd C:\Users\ROG\dsh-workspace\dsh-prompt-enhancer
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本做四件事：

1. 在 `C:\Users\ROG\.dsh-community\profiles\desktop\node_modules\@linxin666\` 下建一个指向本目录的 **junction**；
2. 往 profile 的 `cordis.patch.yml` 追加插件注册段（幂等；自动备份为 `cordis.patch.yml.bak-prompt-enhancer`）；
3. 把包登记进 profile `package.json` 的 `dependencies`（**关键**：Desktop 的插件图谱是从 dependencies 派生的，
   只写 patch 不写依赖，插件不会被解析加载）；
4. 跑一次 Node 自检，确认 Host 模块能加载、`@deepseek-ai/dsh-llm` 能解析。

装完**完全退出并重启 DeepSeek Harness Desktop**（Desktop profile 没有 `patchReload`，不会热加载），
然后打开任意会话即可看到 ✨。

如果 Desktop 用的是另一个 profile（例如 `C:\Users\ROG\.dsh\profiles\desktop`）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfilePath "C:\Users\ROG\.dsh\profiles\desktop"
```

## 真机验证（不用重启 App）

```powershell
powershell -ExecutionPolicy Bypass -File .\verify-live.ps1
```

它会临时克隆一个 `pe-verify` profile（取自官方 web 模板）并挂上本插件，起一个一次性 DSH host，
然后自动检查：

| 检查项 | 判定依据 |
|---|---|
| 组装树 | `dsh --profile pe-verify --dump-config` 输出里含 `prompt-enhancer` |
| Host 路由 | `GET /prompt-enhancer/enhance` → 405；`POST {}` → 400；无关路径 → 404 |
| 客户端渲染 | 无头 Chromium 里 `document.querySelectorAll('.dshpe_button').length === 1` |
| 端到端 | 输入草稿 → 点 ✨ → 出候选（真实模型）→ 按数字键写回输入框 |

跑完默认删除临时 profile。`-KeepProfile` 保留，`-Port` 换端口。

### 最近一次真机验证结果

```
[1/4] junction + patch + package.json dependency   PASS
[2/4] --dump-config 含 prompt-enhancer             PASS
[3/4] host up, token acquired                      PASS
[4/4] GET 405 / POST 400 / control 404             PASS
      浏览器: contenteditable=1  .dshpe_button=1  .dshpe_dock=0
      toolbar: aria=生成清晰提示词 title=生成清晰提示词（Ctrl+Shift+Enter） cls=dshpe_button
      候选框: 模型：deepseek-v4-flash-0731 · tokenrhythm，3 条候选
      数字键 2 → 输入框内容被替换、候选框关闭
```

这次真机验证抓到两个只在运行期才暴露的问题，均已修复：
`inject` 缺 `remote.session`（cordis 报 `cannot get property "remote.session" without inject`）、
报错态再点 ✨ 只会关掉错误条而不是重试。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

删 junction、patch 注册段、package.json 依赖，不会碰本目录源码。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 侧：`POST /prompt-enhancer/enhance`，用 `ctx.llm.stream()` 调模型，按 `===` 切分候选 |
| `lib/client.js` | 浏览器侧：两个插槽的 React 组件 + 共享快照 store + 键盘处理 |
| `cordis.patch.yml` | 插件注册段（作为 bundle 安装时使用） |
| `install.ps1` / `uninstall.ps1` | 本地挂载 / 卸载（junction + patch + package.json 依赖） |
| `verify-live.ps1` | 一次性起真实 host 做端到端验证（见上） |
| `test/smoke.mjs` | 离线逻辑测试（React/DOM/fetch 桩） |
| `test/verify-host.mjs` | 对运行中的 host 探测路由（405/400/404） |
| `test/verify-dom.mjs` | dump 页面里已渲染的插槽与按钮 |
| `test/verify-ui.mjs` | 真浏览器端到端：点按钮 → 出候选 → 数字键采纳 |
| `test/verify-manifests.mjs` | 安全校验：profile 的 package.json / cordis.patch.yml 能被真实解析器解析 |
| `test/probe-pipe.mjs` / `asar-grep.mjs` | 排查工具：命名管道探测、asar 内按字节搜代码 |

Host 侧依赖 `@deepseek-ai/dsh-llm` 的 `BlockAssembler` / `createUserMessage`，通过
`node_modules\@deepseek-ai\dsh-llm` junction 解析（install 脚本会校验）。

## 请求契约

```http
POST /prompt-enhancer/enhance
{ "text": "草稿", "provider": "tokenrhythm", "model": "deepseek-v4-flash-0731",
  "sessionId": "…", "count": 3, "direction": "可选：重写角度" }
→ 200 {
    "structured": true,
    "candidates": [
      { "text": "提示词正文…",
        "gaps": [
          { "question": "这次要动代码吗？",
            "options": [
              { "label": "只诊断", "fill": "只做根因定位，暂不修改任何代码",
                "effect": "最快、零风险；可能多来一轮", "placeholder": "" }
            ] } ] }
    ],
    "provider": "…", "model": "…" }
→ 400/403/405/500 { "error": "…" }
```

仅接受本机来源；请求体上限 256 KB，草稿上限 6000 字符，单次调用 90 秒超时。

### 模型输出格式（DSL）

Host 不要求模型吐 JSON —— flash 级模型经常吐出不合法 JSON（转义、截断、多对象），
所以改用**行分隔 DSL**，无转义问题，且 system prompt 里就带了一份完整示例：

```
【候选】
（提示词正文，可多行；不确定处写 <待确认：…>）
【待定】这次要动代码吗？
- 只诊断 || 只做根因定位，暂不修改任何代码 || 最快、零风险 || 
- 诊断+修复 || 定位根因后直接给出并应用修复 || 一次到位 || 
【候选】
（第二条候选正文…）
```

解析优先级：**DSL → JSON（万一模型还是给 JSON）→ 纯文本按 `===` 切分**。
三条路都不通才报「模型没有产出可用文本」。DSL 的容错在 `test/host-parse.mjs` 里覆盖：
编号变体、缺段、`·` 当选项符号、单选项 gap 丢弃、gaps/options/候选数裁剪、被裁选项不漏进正文。

## 故障排查

- **看不到 ✨ 按钮**：确认已重启 Desktop；看日志 `%APPDATA%\@linxin666\dsh-desktop\logs`；
  打开浏览器控制台（Ctrl+Shift+I）看有没有 `dsh-prompt-enhancer` 模块加载报错。
- **日志提示找不到插件 `@linxin666/dsh-prompt-enhancer`**：说明宿主只认 `package.json` 里声明过的依赖，
  手动往 profile 的 `package.json` 的 `dependencies` 里加一行即可（路径按实际改）：
  ```json
  "@linxin666/dsh-prompt-enhancer": "link:C:/Users/ROG/dsh-workspace/dsh-prompt-enhancer"
  ```
  加完重启 Desktop（若 Desktop 会跑 `pnpm install`，`link:` 指向真实存在的目录，不会失败）。
- **点了报「本地没有 flash 模型」**：候选框会列出可选模型，按数字键选一个。
- **换模型后报 `no adapter registered for provider "xxx"`**：模型目录里列出了当前 profile
  没挂适配器的 provider（例如精简 profile 缺 `llm-deepseek`）。这是环境问题不是插件问题，
  在桌面版里通常不会出现；换回同 provider 的模型即可。
- **候选没有「待定」标记**：说明这次模型没给出待定点（草稿本身已经够清楚），或输出格式跑偏
  —— 后者会让 `structured=false`，此时退化成纯文本候选，功能仍可用。
- **报 `IMPORT-ERR`**：`install.ps1` 第 3 步会提示，通常是 `node_modules\@deepseek-ai\dsh-llm` junction 缺失。
- **回滚**：`uninstall.ps1`，或把 `cordis.patch.yml.bak-prompt-enhancer` 覆盖回去。

## 自测

不需要浏览器/Electron 就能验证客户端逻辑（插槽注册、请求体、候选渲染、键盘采纳、模型兜底、
待定点与方向选项、缩进树、占位符回填）：

```powershell
node .\test\smoke.mjs
```

Host 侧结构化解析（JSON 抽取 / 围栏穿透 / 截断兜底 / 字段裁剪 / 上限）：

```powershell
node .\test\host-parse.mjs
```

模块加载自检（模块加载 + `dsh-llm` 解析）：

```powershell
node -e "import('./lib/index.js').then(m=>console.log(m.name, typeof m.apply))"
```

## 后续（v0.3 待办）

- 本地模板兜底模式（完全离线、零 token）。
- 设置页：固定模型、候选数量、是否附加上下文（cwd / @引用 / agent preset）。
- 生成前 diff 预览、采纳后一键撤销条。
- 提示词模板收藏库。

## 仓库

GitHub：https://github.com/shiliumu/dsh-prompt-enhancer （`main` 分支，首个提交带 `v0.1.0` tag）

```powershell
git clone https://github.com/shiliumu/dsh-prompt-enhancer.git
cd dsh-prompt-enhancer
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`.gitignore` 排除了 `node_modules/`（里面的 `@deepseek-ai/dsh-llm` 是指向 DSH 安装目录的 junction，
不该进版本库；`install.ps1` 会在缺失时自动重建）。

仓库里的 commit 身份是本地设置的 `ROG <ROG@local>`（机器上没配全局 git 身份），
要改成你自己的：

```powershell
git -C C:\Users\ROG\dsh-workspace\dsh-prompt-enhancer config user.name "你的名字"
git -C C:\Users\ROG\dsh-workspace\dsh-prompt-enhancer config user.email "you@example.com"
```
