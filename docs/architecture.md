# 数据、权限与原生接口

数据库是可复用来源；会话只继承明确版本。人类保存创建新版本，Agent 变更进入当前故事的因果记录。源库的后续修订不会自动改变已开始的故事。

## 条目和 Agent 操作

条目字段为 id、title、content、keywords、tags、notes、readOnly、mode、version。mode 只能是 auto、required、disabled；人物知情在 notes 中自然表达，没有 NPC 身份表或强制公开/私密分类。

Agent 可 update 内容/索引/备注，add 自动且未锁的新条目，remove 未锁且非必开条目，或 note 附本次准备的临时备注。不能改 readOnly、mode、版本或来源；不能用新 ID 复用已继承/删除的 ID。每个批次全部通过后才提交。

关键词检索包括标题、ID、标签、正文和中文词项。配置向量服务后计算余弦相似度并与关键词排名融合，再调用配置的重排服务。禁用项在构造提供方请求前就排除。必开 ID 单独返回，不受 Top-K 截断影响。向量当前按检索时的有效条目计算，没有宣称持久向量索引或大库性能已验证。

## 因果来源与回退

每次会话修改记录规范 assistant message ID。宿主使用完整的授权历史、surface 替换关系及 compact-checkpoint 覆盖关系决定当前 active anchors。折叠后的事实仍有效，回退/替换后的事实不再生效。

分叉保留分叉点选中的因果变化，不将最终有效值不可逆地压成 baseline，因此子分支还可以回退到继承前缀内更早的位置。临时备注跟随创建它的准备步骤。所有来源文本和历史变更保留，检索只投影当前有效内容。

## 原生服务

rpDatabase 提供 state/database/source/create/import/save/bind、effective/catalog/read/search/patch。读会话时使用宿主 owner Remote；Agent 调用必须携带实际 exec.agent，不能指定另一会话。动态工具注册在 Agent 自己的作用域，分叉继承在首次请求前完成，未绑定后代不会继承父作用域能力。

上下文插件使用 applyToSnapshot/selectFromSnapshot 在程序内校验隔离工作副本，最后通过 patch 对捕获的 revision 提交一次。纯预览没有写入能力。state 中的检索状态只含 configured/model，不含密钥。

浏览器 POST api/rp-database/request 只接受精确动作和字段，GET api/rp-database/events 发送元数据失效通知。宿主来源变化、回退和新步骤会使打开的视图重新读取有效状态；隐藏、断线和卸载释放订阅。没有任意 URL/RPC 代理。

持久化为一个 state.json，通过同一进程内的目录写队列与原子 rename 更新。revision 冲突保留用户草稿，不静默重放。跨进程共同编辑同一个 DSH home 不属于当前写入约定。
