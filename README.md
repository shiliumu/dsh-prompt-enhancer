# dsh-prompt-enhancer

> **同行把草稿改写得更好，本插件帮你把问题想清楚。**

DSH Web UI 双引擎插件：✨ **提示词增强器** + 🧭 **参谋方向引擎**。
前者把口语草稿改写成结构清晰的提示词（候选框 + 方向选项 + 采纳写回）；
后者把一句话想法转成**可审查、可比较、可迭代的局势模型**——缩进树只是它的一个视图。

## 与同类插件的区别

同名插件在这个生态里至少有 11 个。我们下载并通读了 **27 个同行的完整源码**（含全部同名实现），
定位差异见下表，完整对比报告在 [docs/peer-landscape.md](./docs/peer-landscape.md)。

| 维度 | 常见 prompt-enhancer | 本插件 |
|---|---|---|
| 核心产物 | 一段改写后的提示词 | **局势模型**（意图 / 事实 / 推断 / 假设 / 未知 / 关键矛盾 / 方向 / 推荐） |
| 多轮行为 | 每次重新生成 | **续研**：带上上一份模型、标记已失效判断，增量更新而不是重生成 |
| 缩进树 | 层级列表 | 局势模型的**视图**：节点带类型 / 来源 / 置信度 / 影响 / 状态五属性徽标 |
| 事实与推断 | 不区分 | 强制四分：**事实 / 推断 / 假设 / 未知**，各带来源与置信度 |
| 信息不足时 | 硬给出结果 | 合法输出**「暂不推荐」** + 最多三个待确认问题 |
| 模型失败 | 报错即止 | 区分**「只出思维链」与「完全空白」**，自动弹出换模型选择框，失败草稿原样保留 |
| 输出预算 | 硬编 token 上限 | 交给宿主默认；空正文 + `max-tokens` 自动用更大额度重试一次 |
| 结构审查 | 无 | 手动「复查」：审查器逐条检查忠实度 / 脑补 / 方向差异 / 转向条件 |

> 并不是说同行做得不好——改写质量那条路他们走得更远；
> 本插件做的是另一件事：把"把问题想清楚"做成一等公民，改写只是它的出口。

> 仓库：https://github.com/shiliumu/dsh-prompt-enhancer
> 许可：MIT ｜ 仅使用官方插槽扩展点，不改 DSH 源码
> 版本：v0.3.0（[CHANGELOG](./CHANGELOG.md)）

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

Host 侧自带消息构造（`buildUserMessage`），直接消费 `llm.stream()` 的分片（正文走 `text-delta`，
思维链走 `reasoning-delta` 仅做统计，结束原因来自 `finish` 分片），**不依赖** `@deepseek-ai/dsh-llm`
——在 link 安装与多 profile 场景下更稳。输出额度不硬编（`maxTokens` 交由宿主默认），
空正文且 `finish=max-tokens` 时自动用更大额度重试一次。

## 请求契约

### 提示词增强

```http
POST /prompt-enhancer/enhance
{ "text": "草稿", "provider": "tokenrhythm", "model": "deepseek-v4-flash-0731",
  "sessionId": "…", "count": 3, "direction": "可选：重写角度" }
→ 200 { "structured": true,
    "candidates": [ { "text": "提示词正文…",
        "gaps": [ { "question": "这次要动代码吗？",
          "options": [ { "label": "只诊断", "fill": "…", "effect": "…", "placeholder": "" } ] } ] } ],
    "provider": "…", "model": "…" }
→ 400/403/405/500 { "error": "…", "code": "reasoning-only|empty-output", "detail": {…} }
```

### 参谋方向引擎（v0.3）

```http
POST /prompt-enhancer/advisor
{ "text": "我要不要辞职做独立开发", "provider": "…", "model": "…",
  "sessionId": "…", "mode": "decision", "resume": true }
→ 200 { "situation": { intent, situation{facts,inferences,assumptions,constraints,unknowns},
    key_tensions, directions[{id,name,thesis,premises,…}], recommendation,
    questions[≤3], tree{五属性节点} },
    "structured": true, "mode": "…", "resumed": true, "stateSaved": true }
```

POST /prompt-enhancer/review：手动复查局势模型（审查器提示词）。
GET  /prompt-enhancer/diag?provider=…&model=…：只读诊断（分片统计 / finish 原因 / 本机限定）。

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
- **报 `IMPORT-ERR`**：`install.ps1` 第 4 步会提示。v0.3 起不再依赖 `@deepseek-ai/dsh-llm`，
  通常是宿主模块加载失败；按提示用与目标 profile 相同的 DSH runtime 重跑自检。
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

模块加载自检（宿主模块可加载即通过，v0.3 起不再校验 `dsh-llm`）：

```powershell
node -e "import('./lib/index.js').then(m=>console.log(m.name, typeof m.apply))"
```

参谋引擎契约与路由测试：

```powershell
node .\test\advisor.mjs        # 引擎契约
node .\test\advisor-route.mjs  # 路由（含 stateSaved/resumed 回路）
```

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。v0.3.0 起包含参谋方向引擎，设计文档见
[docs/v0.3-advisor-engine.md](./docs/v0.3-advisor-engine.md)；同行对比见
[docs/peer-landscape.md](./docs/peer-landscape.md)。

## 仓库

GitHub：https://github.com/shiliumu/dsh-prompt-enhancer （`main` 分支，首个提交带 `v0.1.0` tag）

```powershell
git clone https://github.com/shiliumu/dsh-prompt-enhancer.git
cd dsh-prompt-enhancer
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`.gitignore` 排除了 `node_modules/`（v0.3 起插件不依赖 `@deepseek-ai/dsh-llm`，
旧版本里的 `node_modules\@deepseek-ai\dsh-llm` junction 可删掉）。

仓库里的 commit 身份是本地设置的 `ROG <ROG@local>`（机器上没配全局 git 身份），
要改成你自己的：

```powershell
git -C C:\Users\ROG\dsh-workspace\dsh-prompt-enhancer config user.name "你的名字"
git -C C:\Users\ROG\dsh-workspace\dsh-prompt-enhancer config user.email "you@example.com"
```
