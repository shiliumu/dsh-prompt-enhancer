# v0.2.1 → v0.3 变更逻辑说明文档

> 审查范围：`533e41e (v0.2.0)` → `33da888 (v0.3 2/2)`，共 4 个提交、12 文件、+3341/−83。
> 本文档同时是 debug 的依据：每个章节末尾附"对照检查结果"。

## 一、变更总览

| 提交 | 主题 | 主要文件 |
|---|---|---|
| aec0ab6 | v0.2.1 宿主自带消息构造 + 解析器不再吞【待定】后正文 | lib/index.js, install.ps1 |
| dcf97dc | v0.2.2 输出预算交宿主默认 + 空正文诊断 + 失败换模型入口 | lib/index.js, lib/client.js |
| 3503645 | v0.3(1/2) 参谋方向引擎（局势模型为核心） | lib/advisor.js, lib/index.js, lib/advisor-client.js |
| 33da888 | v0.3(2/2) 参谋 UI 并入单一客户端模块 | lib/client.js, test/smoke.mjs |

两条技术主线：**(A) 宿主调用与解析加固**（v0.2.1–0.2.2）、**(B) 新增参谋方向引擎**（v0.3）。

## 二、修改前的运行逻辑（v0.2.0 基线）

### 2.1 改写流程（唯一流程）

```
用户点 ✨ / Ctrl+Shift+Enter
  EnhanceButton.onClick → generate(direction=null)
    resolveModel()（首次 flash 优先，缓存 preferredModel）
    requestCandidates(text, chosen, direction)
      POST /prompt-enhancer/enhance {text, provider, model, count, sessionId}
  ── Host ──
  handleEnhance
    generate(ctx, request)
      messages = [createUserMessage(frameDraft)]   ← 依赖 @deepseek-ai/dsh-llm
      BlockAssembler 消费 llm.stream()             ← 依赖 assembler.blocks()
      parseStructured(output)
        parseDsl（行分隔 DSL）→ extractJsonObject → splitCandidates(===)
    500 时只回 {error: string}
  ── Client ──
  CandidatePanel：候选列表 + gaps 拍板区 + 缩进树
    adopt() → applySelections（占位符原地替换/补充要求）→ inputActions.setDraft
```

### 2.2 数据走向（改前）

```
草稿(string) → frameDraft → llm.stream → output(string)
  → parseStructured → candidates[{text, gaps[]}] → 前端渲染 → setDraft(最终文本)
```

无会话态、无持久化、无参谋流程。状态字段：phase/candidates/index/selections/focus/activeGap/showTree。

## 三、修改后的运行逻辑

### 3.1 v0.2.1：宿主自带消息构造 + DSL 解析修复

**调用关系变化：**

| 项 | 改前 | 改后 |
|---|---|---|
| 消息构造 | `createUserMessage`（@deepseek-ai/dsh-llm） | `buildUserMessage`（本文件，randomUUID + Object.freeze） |
| 流消费 | `BlockAssembler`（dsh-llm） | 直接 for-await 判 `chunk.type === 'text-delta'` |
| parseDsl | `inGapSection` 不闭合，【待定】后正文被吞 | 普通正文行退出 gap 区并收回正文 |

**数据走向（不变的部分）：** `output → parseStructured` 仍然 DSL 优先 → JSON 次 → 纯文本兜底。

### 3.2 v0.2.2：预算策略 + 可诊断失败

```
generate(ctx, request)
  streamOnce(ctx, {...})                 ← 抽出：正文/思维链/finish 分开统计
    text-delta → output += text
    reasoning-delta → reasoningChars += len   （改前：丢弃）
    finish → finish = chunk.reason?.kind ?? chunk.reason ?? chunk.kind
    tool-call → throw '模型返回了工具调用'
    error → throw chunk.error.message
  maxTokens: 不再硬编 2600 → 不传（走宿主默认）
  若 output 为空 && finish === 'max-tokens' → 用 16000 重试一次
  解析为空时抛：
    reasoning-only（思维链>0）或 empty-output，带 error.code + error.detail
  → handleEnhance 把 code/detail 随 500 回传
```

**新增诊断路由**：`GET /prompt-enhancer/diag?provider&model[&text][&maxTokens=off]` → 分片统计、`finish` 原文、正文/思维链长度。

**客户端失败分支（新增）：**

```
catch (error)
  patch({ phase: 'error', error })
  若 error.code ∈ {reasoning-only, empty-output}
    → pendingDraftRef = text
    → openPicker(带失败原因, keepCandidates=true)
    → chooseFromPicker：preferredModel = entry; 用 pendingDraftRef ?? readDraft() 重试
```

### 3.3 v0.3：参谋方向引擎

**Host 侧（lib/index.js 新增两个路由，lib/advisor.js 为引擎核心）：**

```
POST /prompt-enhancer/advisor {text, provider, model, sessionId?, mode?, resume?}
  mode = requestedMode ?? inferMode(draft)      ← 侦察>决策>复盘>执行>谋划
  previous = resume ? advisorStates.get(sessionId) : null   ← 会话态快照
  input = buildAdvisorInput({draft, mode, context, constraints, evidence, currentState: previous})
  streamOnce(..., system: ADVISOR_SYSTEM_PROMPT, maxTokens: 12000, timeout: 240s)
  parseAdvisorOutput(output, draft)
    extractJsonObject（宽松：去围栏/取首对象/截断修复）→ normalizeAdvisorModel
    校验裁剪：directions ≤4, questions ≤3, 树深 ≤7, 节点 ≤160, 文本 ≤600 字
    recommendation.direction_id 不存在 → 'undetermined'
    降级：非 JSON → parseAdvisorOutput 纯文本兜底（structured=false）
  advisorStates.set(sessionId, snapshot)      ← 无论结构化与否都存
  回传 {situation, structured, fallbackText, mode, resumed, provider, modelId, finish, reasoningChars}

POST /prompt-enhancer/review {provider, model, sessionId?, state?}
  target = body.state ?? advisorStates.get(sessionId)?.model
  streamOnce(..., system: REVIEW_SYSTEM_PROMPT, maxTokens: 2000)
  → normalizeReview（valid/errors/warnings/missing_questions/recommended_corrections）
```

**会话态快照（AdvisorStateStore，进程内存）：**

```
get(sessionId) → 过期(TTL 6h)删除并返回 null
set(sessionId, model) → 超过 24 条时淘汰最旧
```

**客户端（lib/client.js 合并后，1616 行，单一模块工厂）：**

共享快照新增参谋态字段（advPhase/advMode/situation/advSelected/advCollapsed/advReviewResult/advExported/advResumed...）。

```
🧭 AdvisorButton.onClick → advAnalyze(resume=false)
  advResolveModel()（isFastModel 过滤：排除 glm-5.3/qwen3.8/kimi）
  requestJson(ADVISOR_ROUTE, body)          ← 与改写共用 requestJson
  → patch({advPhase:'ready', situation, advSelected: 推荐 id ?? null})

AdvisorDock 渲染：模式条 → 意图 → 关键矛盾 → 事实/推断/假设/未知 →
  方向卡(data-rec 推荐星标) → 方向详情 → 待确认问题 → 缩进树(五属性徽标, data-dead) →
  推荐依据 / 暂不推荐提示 → 复查结果 → 导出结果

动作：
  续研 → advAnalyze(true)                    ← resume 带上一份
  复查 → advRunReview → requestJson(REVIEW_ROUTE)
  导出 → advExportPrompt → 拼方向要点 → requestJson(ROUTE='/prompt-enhancer/enhance')
  采纳 → advAdopt → 优先采纳 advExported，否则局势小结 → setDraft → advReset()

Ctrl+Shift+J 参谋 / Ctrl+Shift+Enter 改写；任一方 reset() 都会收起对方。
```

### 3.4 调用关系图（合并后，函数级）

```
EnhanceButton ──> generate ──> resolveModel ──> requestCandidates ──> requestJson ──> /enhance
CandidatePanel ──> adopt ──> applySelections ──> setDraft

AdvisorButton ──> advAnalyze ──> advResolveModel ──> requestJson ──> /advisor
AdvisorDock ──> advRunReview / advExportPrompt / advAdopt / advChooseFromPicker
  advExportPrompt ──> requestJson(ROUTE) ──> /enhance（复用改写）
  advAdopt ──> setDraft ──> advReset

Host:
  handleEnhance → generate → streamOnce → parseStructured
  handleDiag（诊断）
  handleAdvisor → streamOnce → parseAdvisorOutput → normalizeAdvisorModel → advisorStates.set
  handleReview → streamOnce → normalizeReview
```

## 四、对照检查结果（debug 发现）

### D1 🔴 `reset()` 丢失"保留 advMode"修复（回归，改前无此问题）

**位置**：`client.js:110-112`
**现状**：`patch({ ...INITIAL })` —— 这是我合并时因 git 还原重放修复时的遗漏（合并脚本生成的是旧实现）。
**影响**：用户在改写流程中点 Esc/采纳/出错后，`advMode`（手动选的参谋模式）会被静默重置回 `'auto'`；同时**参谋面板不被收起**（reset 只重写 INITIAL 没有的 adv 字段时，patch 是浅合并——实际上 `...INITIAL` 包含全部 adv 字段，所以会全部重置；问题在于用户偏好也一并丢失）。
**改前状态**：v0.2.0 的 reset 只重置改写态，没有参谋态——此次变更新增了参谋态，却让 reset 把偏好也清了。
**修复方向**：reset 只清改写流程状态 + 收起参谋面板，但保留 `advMode`。

### D2 🟠 双模型黑名单不一致（设计缺陷，改前不存在）

**位置**：`client.js:175`（`EMPTY_TEXT_MODELS = [glm-5.3-flash, glm-5.3-flashx, qwen3.8-flash]`）与 `client.js:926`（`isFastModel = !/glm-5.3|qwen3.8|kimi/i`）。
**影响**：选择框打标用前者（3 个），参谋选模型过滤用后者（更广，含 kimi-k3 和 glm-5.3 全家族）。用户能看到 `glm-5.3`（非 flash）被打"⚠易空正文"但 `deepseek-flash` 同样实测空正文却没被打标；`kimi-k3` 被参谋过滤但选择框里没提示。**同一事实两份口径**。
**修复方向**：合并为单一函数，统一判据（基于实测：`deepseek-flash` 在 8000 预算下已可用，GLM 全家与 kimi-k3 仍不可靠）。

### D3 🟠 `advAnalyze` 缺 `picker` 态守卫（改前无此状态机）

**位置**：`client.js:959` —— `if (snapshot.advPhase === 'busy') return;`
**对照**：改写流程 `generate` 同样只有 busy 守卫（line 371），但改写按钮在 picker 态是"点一下收起"；参谋按钮的 toggleable 判定（`ready || picker`）相同，**而 Ctrl+Shift+J 快捷键在 picker 态会触发 advAnalyze(false)**，此时 draftRef 若为空会报"输入框是空的"并清掉 picker。
**修复方向**：快捷键与按钮一致处理 picker 态（picker 时收起）。

### D4 🟡 `handleAdvisor` 的 `resume` 语义缺口（新增功能自带的边界）

**位置**：`index.js handleAdvisor` —— `previous = body.resume === true ? advisorStates.get(sessionId) : null`
**问题**：`sessionId === ''`（无会话）时 `resume=true` 静默等价于 `resume=false`，且响应里 `resumed: false`——用户/客户端无法区分"续研但没历史"与"首次分析"；快照对无会话请求也不存（`set(''…)` 直接 return）。
**影响**：低。但 diagnostics 里 `resumed` 字段可能误导。
**修复方向**：无会话时明确回传 `resumed: false` 且不存快照（现状已如此），建议在响应中补 `stateSaved: boolean`。

### D5 🟡 `normalizeAdvisorModel` 根节点 children 未做"去重/合并"

**位置**：`advisor.js` —— `rootNode = normalizeNode({...})` 直接采用模型给的 `tree.children`。
**问题**：若模型把同一事实同时放在 `facts` 数组与 `tree.children` 里（实测出现过：`facts: ['后端五年经验']` 与树里 `label: '后端五年经验'` 同时存在），界面会双份显示。属于数据冗余，不影响正确性。
**修复方向**：低优先级，可不动；或在渲染层按 label 去重。

### D6 🟡 `advExportPrompt` 的草稿拼装丢弃了 `constraints`

**位置**：`client.js advExportPrompt` —— 只带 name/thesis/premises/first_action/risks/target。
**问题**：`situation.situation.constraints`（如"房贷在还"）未进入导出草稿，导致 /enhance 改写时不知道硬约束。
**修复方向**：导出草稿追加 `约束：${constraints.join('；')}`。

### D7 🟢 `streamOnce` 的 `chunkKinds` 120 字符截断可能截断诊断信息

**位置**：`index.js streamOnce` —— `chunkKinds.length < 120`。
**影响**：长会话（几百个分片）时 chunkKinds 被截断，只影响诊断字段，不影响主流程。可接受。

### D8 🟢 资源释放核查：定时器/监听器全部有清理

- `handleAdvisor/handleReview/generate` 的 `setTimeout` 均有 `finally clearTimeout` ✓
- `apply()` 里四个 `webServer.register` 在 `ctx.effect` 的 dispose 中全部注销 ✓
- `advisorStates` 是进程内存 Map，有 TTL + 容量上限，无泄漏（但重启即失效——已知定位差异，非 bug）✓
- 客户端 `keydown` 监听均有 `removeEventListener` ✓

### D9 🔴 测试用例对 `reset()` 保留 advMode 的断言缺失

正因为 D1，测试里没有"reset 后 advMode 保留"的用例，所以回归没被抓到。修复 D1 时必须补测试。

## 五、修复清单

| 编号 | 级别 | 修复 |
|---|---|---|
| D1 | 🔴 | reset() 保留 advMode，仅清流程状态 |
| D2 | 🟠 | 合并模型黑名单为单一判据（含 deepseek-flash 在 8000 预算可用、GLM 与 kimi-k3 不可靠） |
| D3 | 🟠 | Ctrl+Shift+J 在 picker 态改为收起 |
| D6 | 🟡 | advExportPrompt 导出草稿补 constraints |
| D4 | 🟡 | handleAdvisor 响应补 stateSaved 字段 |
| D9 | 🔴 | 为 D1/D2/D3/D6 各补一个测试用例 |
