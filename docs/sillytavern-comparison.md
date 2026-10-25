# SillyTavern 与 DSH RP 五插件：功能差距评估

评估者：Astra XHigh。日期：2026-10-25。只读能力对照，没有执行 ST 脚本、安装外源依赖或调用付费模型。本文件是评估记录，不是本轮新增实现授权或后续实现计划。

## 结论

目前差距主要在内容资产和日常创作操作：从一张角色卡进入故事、挑选玩家身份与开场、对不满意正文改稿选版、将完整故事带走。模型提供方、工具循环、原生阅读、分支回退、模块权限、动态资料检索与主动历史选材已经有实际基础，不应重复计算成从零缺失。

本轮世界书兼容补修的基线为 Database `ca025fdf568fc4665f50f0809c0302df98eb4040`。它扩展 JSON 输入形态，保留作者元数据并报告未适配行为；不等于完整 ST 角色卡、开场、persona 或脚本运行时迁移。后续 0.1.1 原生单包验收已完成，包含 ST 世界书与内嵌世界书、原件/报告保留和原生界面；本文其余新能力仍是差距评估，未声称已经实现。

## 对照依据与置信边界

- SillyTavern 程序固定到 1.19.0 / `7e8663cd9c184a550b37238218bdd32c6efc68e9`。
- 官方文档下载快照固定到 `ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d`，与程序是各自独立的版本；不能假设文档全部特性均在 1.19.0 同步存在。下述关键差异以其明确记载能力和本地五插件实际代码相结合。
- 主代理已报告五插件独立发布、跨平台 CI、实际 DSH 确定性模型联用验收；这证明工程调用和状态边界，不证明真实模型 20–30 轮角色一致性和文学质量。
- 已读取 Studio 原生 Workspace、LastStep README/receipt/routes、Database store/core、Context README，结合此前对三插件源码的完整审查。没有把主循环“能调用某类工具”当成已有用户友好的 RP 功能。

## 七项值得补的差距

### 1. 内容资产与开局闭环：最高优先

ST 将角色名称、description、personality、scenario、first_mes、alternate_greetings、mes_example、头像、作者元数据、标签，与独立 persona 管理组成常用入口。persona 可关联角色或聊天；第一条消息和例句有不同于世界事实的用途。

现有 Database 可以提取 JSON 角色卡中的世界书，但不会处理其余卡字段；PNG chara/ccv3 提取未实现。Studio 的新故事列表仍来自宿主可玩 RP preset/bundle 标记，空安装只有数据库和文风预设仍不自动得到一个故事入口。手工把卡信息粘进条目可以应急，不能算完整导入体验。

建议归属：一个轻量内容资产插件管理角色/玩家身份/开场/资源引用，Studio 提供入口，Database 和 LastStep 分别保存资料和文风。配置绑定现有通用 GM 能力，不为每张卡生成 runtime preset。示例对话是语气样例，不应直接记作已经发生的历史。开场被选中并开始故事之后，才成为该故事的正式起点。

群聊能力可在这个资产层补人物阵容、当前在场者与点名发言入口；继续由一个 GM 管理 NPC，无需每人独立 Agent 或 NPC ACL。

### 2. 正文修订、候选稿和定稿：高优先

ST 的 edit、swipe、regenerate、continue 都有消息级入口。现有 Studio 已有发送、停止、回退、分支和自动续写；LastStep 已有 failed/cancelled 且冻结材料完成后的 writer-only retry，但只能通过工具参数使用，没有专用按钮，也没有成功正文的候选稿比较、编辑和选版。

建议归属：LastStep 拥有稿件及定稿规则，Studio 呈现操作，Context 跟随被正式采用的文本。先补失败重试按钮，再考虑成功正文的“事实不变，只改表达”候选稿。改写玩家行动或已确认事实应走回退/分支，不能像普通聊天编辑那样直接改文字并留下不一致数据库。原文续写也应区分补完本段和推进新行动。

### 3. 多数据库组合与人物资料组织：随后

ST 可以组合 global、character、persona、chat lore，并配置来源顺序。当前 Database 每个会话固定一个 databaseId/version；重新绑定会重置会话覆盖。它能保存多个数据库，但不能让一个故事叠加多个固定来源。

建议归属：Database。支持“共享世界＋角色资料＋玩家身份＋本故事补充”的少量明确来源，条目引用带来源，列出同名/同 ID 冲突并采用显式顺序；不做复杂权限矩阵。各库仍固定版本，覆盖留在会话，Agent 不能重配人类来源。

### 4. 完整故事导出与再导入：随后

ST 提供可再导入 JSONL、纯文本导出、聊天管理和 checkpoint/branch。DSH/Studio 已有会话保存与分支；当前 README 要求分别备份宿主日志以及 database/context/last-step/loop 文件。没有五插件统一故事包，也没有将有效正文导出为可分享阅读稿的 Studio 按钮。

建议归属：Studio 编排，其他插件提供版本化导出片段。区分“只分享正文”和“可恢复故事”，后者包含来源版本引用、会话覆盖、上下文设置和正式稿关联。ST 旧聊天可作为待确认历史材料导入，但不能凭文本伪造之前没有发生的 DSH 工具结算。Worldbook 导回 ST 也未实现；若增加，应明确哪些高级行为仅保留原始元数据、哪些编辑无法无损往返。

### 5. 实际选材/提示词检查和本轮作者备注：高价值，随后

ST Prompt Manager 提供顺序、角色、触发类型、深度；Author’s Note 提供低摩擦的场景/文风干预。扩展目录另列可安装 Prompt Inspector，不应把第三方扩展当成 ST 默认内核。

当前 LastStep 有模块编辑/预览，Database 有检索理由，Context 有全文/摘要/索引与未决事项界面，Loop 有实际模型/状态/用量元数据。仍缺一个把“本次真正送给中间 GM 和 writer 的资料版本、选择顺序、历史表示、文风模块和大小”串起来的检查入口。Loop 明确不复制正文，这不是 Loop 故障。

建议归属：Context/LastStep 提供冻结快照检查，Studio 增加入口；Loop 继续负责阶段和模型元数据。展示候选得分与最终选择，不假装能提供模型未输出的思维过程。增加有明确寿命的“本轮写作指导”是产品入口，不需要复制 ST 任意深度插入规则。当前字符预算与真实 provider token 用量分开标记。

### 6. 文件资料入口与检索可扩展性：按资料规模推进

ST Data Bank 能管理文本、Markdown、HTML、PDF、ePUB 等转换后的文档，区分全局/角色/聊天范围；Vector Storage 保存索引并提供管理入口。部分格式和外部来源依赖额外插件。

当前五插件没有面向玩家的文件上传→提取→切块→来源定位→搜索引用流程；现有 Agent 若配置文件工具可以读取文件，仍不等于完整资料库入口。Database 向量检索每次按当前有效内容重新计算，尚无持久索引。

建议归属：先扩展 Database 的文件接入和有来源的片段；真正通用的解析再独立插件化。资料变大后采用条目内容版本/embedding 模型版本作为索引标识，只更新变化内容。不要因此引入新的外部数据库服务或大规模检索平台。传闻/考据资料不因导入自动升级为故事事实。

### 7. 多模态与沉浸呈现：可选，优先级低于文本闭环

ST 提供或列出 TTS、image captioning、image generation、expression sprites、动态背景/音频等扩展。现有 Studio 已有沉浸阅读与渲染，不是完全没有呈现层；但没有角色声线映射、朗读播放队列、立绘/表情资源绑定或场景媒体管理的完整 RP 流程。

建议归属：Studio 的可选呈现扩展，生成/语音/视觉处理复用实际可用的宿主工具与提供方；不存在的提供方需要另接，不能把“能调工具”当成已经支持。先做用户明确想要的一项，例如已定稿正文朗读，不同时复制整套多媒体生态。

## 已有或应继续采用现有范式的能力

| ST 能力 | 当前判断 |
|---|---|
| 模型/API 接入、聊天工具调用、本地模型 | DSH 宿主提供；Loop 已提供真实阶段模型路由。不要另造账号、凭据或服务层。 |
| 聊天保存、回退、分支、停止、连续游玩 | 宿主和 Studio 已有。可改善入口和导出组合，不从头开发会话系统。 |
| 提示词预设与动态资料激活 | LastStep+Database+Context 已有受控模块与主动选材。高级 ST 条件/递归/概率/位置/宏仅诊断保留，不宣称等价执行。 |
| 摘要、回忆、旧历史展开 | Context 已有实际摘要、来源引用和 full/summary/index；作用域是中间 GM 与 writer。主 Agent 全局压缩仍由 DSH/ACP 管理，不能宣传成已完成全局替代。 |
| 多角色同时出现 | 一个 GM 可组织多个 NPC；缺的是方便的人物资产/阵容操作，而非必需的多 Agent 调度器。 |
| STscript、Regex、TH 运行补丁 | 当前迁移为工具、插件、正文模板或显式模块，原脚本不执行。没有必要先写兼容整个脚本语言和 DOM 生态。重复具体需求出现时再考虑小而可测试的文本变换插件。 |
| 复杂世界书触发算法 | Agent 主动搜索与选择是有意替代，不按 ST 激活语义逐项补齐。作者依赖这些语义时，导入报告必须明确，不能静默声称兼容。 |
| 通用扩展机制 | DSH 已有插件基础，五插件已独立发布。现在缺的主要是故事资产交付，而非再造一个插件宿主。 |

## 下一步最值得做的闭环

建议下一轮做“导入一张普通角色卡→选玩家身份和开场→固定资料/文风版本→从 Studio 开始故事→重启后继续”。第一版覆盖 JSON v2/v3 和常见 PNG 元数据、基本人物描述、一个或多个开场、示例对话、内嵌世界书与迁移诊断，不支持任意脚本运行或每卡专用 engine。

它直接消除当前“插件全装好了，仍需要自己准备一个可玩 preset”的门槛，也把五插件连成用户看得懂的入口。通过这一闭环之后，进行真实模型 20–30 轮试玩，检查人物声音、开场事实、玩家自主权、承诺回收与回退一致性，再决定优先补改稿、多库还是文件资料。不要把本报告当作本轮必须全部实施的功能清单。

## 官方文档与固定源码链接

在线文档可能继续更新；本报告的离线正文以所列 docs revision 为准。

| 主题 | 官方网页 | 固定文档源码 |
|---|---|---|
| 角色字段/开场/示例 | https://docs.sillytavern.app/usage/core-concepts/characterdesign/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/Characters/characterdesign.md |
| Persona | https://docs.sillytavern.app/usage/core-concepts/personas/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/personas.md |
| 世界书组合 | https://docs.sillytavern.app/usage/core-concepts/worldinfo/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/worldinfo.md |
| 日常聊天/改稿 | https://docs.sillytavern.app/usage/chatting/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/Chatting/index.md |
| 聊天导出/分支 | https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/Characters/chatfilemanagement.md |
| 群聊 | https://docs.sillytavern.app/usage/core-concepts/groupchats/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/Characters/groupchats.md |
| 作者备注 | https://docs.sillytavern.app/usage/core-concepts/authors-note/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/Characters/Author%27s-Note.md |
| Prompt Manager | https://docs.sillytavern.app/usage/prompts/prompt-manager/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/Prompts/prompt-manager.md |
| 文件资料 | https://docs.sillytavern.app/usage/core-concepts/data-bank/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/Characters/data-bank.md |
| Regex | https://docs.sillytavern.app/extensions/regex/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/extensions/Regex.md |
| 聊天向量索引 | https://docs.sillytavern.app/extensions/chat-vectorization/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/extensions/Chat-vectorization.md |
| 多模态扩展目录 | https://docs.sillytavern.app/extensions/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/extensions/index.md |
| TTS | https://docs.sillytavern.app/extensions/tts/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/extensions/TTS.md |
| 图像生成 | https://docs.sillytavern.app/extensions/stable-diffusion/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/extensions/Stable-Diffusion.md |
| 图像描述 | https://docs.sillytavern.app/extensions/captioning/ | https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/extensions/captioning.md |

固定程序源码：

- https://github.com/SillyTavern/SillyTavern/tree/7e8663cd9c184a550b37238218bdd32c6efc68e9
- https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/character-card-parser.js
- https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/world-info.js
- https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/endpoints/worldinfo.js
- https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/extensions.js

## 本地核验点

- Database `src/store.mjs`：每故事一个 databaseId/version；绑定重置覆盖；版本和来源独立。
- Database `src/core.mjs` 及本轮 ST 导入模块：JSON 形态归一化和持久导入报告，未提取 PNG。
- Studio `packages/plugin/src/Workspace.jsx`：故事档案、现有 preset/bundle 入口、发送/停止/回退/分支/自动续写；没有消息级候选稿定稿、persona 和故事包导出。
- LastStep `README.md`、`src/receipts.mjs`、`src/PresetWorkspace.jsx`：冻结失败重试、模块预览和稿件页；完整冻结材料虽有内部存储，尚无跨阶段检查工作区。
- Context `README.md`、planner/host：GM/writer 输入范围、规范 rp_present 正文历史、主动读/搜/表示修改。
- Loop `docs/usage.md`、`docs/architecture.md`：实际阶段路由与元数据轨迹；明确不复制模型/工具正文。
