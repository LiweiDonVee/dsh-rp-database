# 导入 SillyTavern 世界书

Database 0.1.1 支持世界书的 JSON 数据迁入，不运行 SillyTavern 的激活引擎或第三方脚本。当前流程仍是“检索候选 → GM 主动查找与选材 → 冻结材料 → 正文”。

## 文件入口

| JSON 形态 | 处理 |
| --- | --- |
| 独立 ST 世界书：`{"entries":{"0":{...}}}` | 按条目映射导入 |
| 常见 ST 条目数组：`{"entries":[{"uid":0,"key":[],...}]}` | 归一化条目与 ID |
| 标准 Character Book：`{"name":"...","entries":[{"id":0,"keys":[],"enabled":true,...}]}` | 读取标准字段与扩展来源 |
| 角色卡 JSON 的 `character_book` 或 `data.character_book` | 只提取内嵌世界书；V2/V3 JSON 均可 |
| 本插件 `entries` 数组 | 保持现有原生导入，不将其误判为酒馆条目 |

PNG/APNG 角色卡、ZIP、其他软件的私有 lorebook 容器不在本版范围。角色卡没有内嵌世界书时会明确报错，请另行从 ST 导出它关联的世界书。角色描述、开场、示例对话和系统指令不是数据库条目，不会随提取被错误导入。

可使用 [合成 ST 世界书示例](../examples/sillytavern-worldbook.json) 或 [合成角色卡 JSON 示例](../examples/character-book-v3.json)。它们仅包含公开测试数据，不是可玩角色包。

## 字段映射

| 源字段 | Database 中的结果 |
| --- | --- |
| `uid` / `id` | 稳定文本 ID，数字 0 保留为 `"0"`；缺省使用来源键或数组下标，重复 ID 拒绝 |
| `comment` / `name` | 条目标题；没有标题时使用首个关键词或默认标题 |
| `content` | 正文原样保留 |
| `key` / `keys` | 检索关键词；正则表达式按字面文本保留，不执行 |
| `keysecondary` / `secondary_keys` | 正向次级键作为检索提示；NOT 条件的次级键不转为正向关键词；条件逻辑另作诊断 |
| `disable` / `enabled` | 任一明确禁用时映射为禁用 |
| `constant` | 启用且常驻时映射为必开；禁用优先 |
| `displayIndex` / `extensions.display_index` | 稳定整理导入条目，未指定时沿用文件条目顺序 |
| 世界书名称 | 人类输入的导入名称优先，其次源名称；内嵌名称空白时可回退到角色名称 |
| `forbid_overrides` 等作者标记 | 来源信息，不自动取得本系统人类设置的 Agent 只读权限 |

原件完整保存 `rawText`、SHA256 和解析后的来源数据。UTF-8 BOM、CRLF 与空白保留在原始文本及哈希中；浏览器 textarea 会按自身规则显示换行，持久化原件不因展示改变。

每个来源有 `importReport`：格式、条目数量、源条目路径、原 ID、导入顺序和诊断。它随原件保存，保存新版数据库或重启不会丢失；重新打开数据库会恢复报告，切换到其他来源不会混入旧报告。

## 不自动复现的行为

次级键的 AND/NOT、概率激活、递归扫描、深度与插入位置、消息角色、粘滞/冷却/延迟、分组互斥、角色/标签过滤、扫描大小写和整词选项、自动化、向量标记以及复杂宏，均保留来源并在报告中说明。它们不会隐式开启外部服务、执行代码或改变人类权限。

注入 `order` / `insertion_order` 仍保留在来源引用中；本轮实际顺序由 GM 选材决定。来源 `vectorized` 标记不等于已经配置 embedding 服务。未知扩展和脚本保留供回溯，不执行。

这意味着数据能够迁入，但作者依赖高级触发规则时仍需审阅：哪些规则改成叙事备注，哪些应由明确工具承担，哪些只是旧提示词注入位置的补丁。不要仅凭“导入成功”就假定旧卡的全部行为保持一致。

## 验证依据

核对版本：SillyTavern 1.19.0，固定源码 `7e8663cd9c184a550b37238218bdd32c6efc68e9`。依据包括 [标准 Character Book 转换](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/world-info.js#L5617)、[原生世界书文件导入](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/endpoints/worldinfo.js#L107) 和 [世界书文档快照](https://github.com/SillyTavern/SillyTavern-Docs/blob/ed5423d809c6b10b8c1e9ef4a0c8ddc7f2ef7f3d/Usage/worldinfo.md)。只读参考，没有执行上游源码。

回归测试覆盖以上形态、UID0、启停/常驻、否定键、空白名称、角色过滤、原件与报告重启保留。原生 smoke 实际安装 tgz、导入 ST 世界书和内嵌 Character Book，并验证模型工具、来源保护及原生报告显示。
