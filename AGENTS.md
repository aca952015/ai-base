# AI Base 项目协作约定

本文件适用于 `ai-base` Git 仓库。它只记录项目特定约束；通用 Codex/OMX 运行规则由用户环境维护，不在这里复制。

## 开始工作前

1. 先运行 `git status --short`，保留用户已有的未提交修改，不覆盖、不回滚无关文件。
2. 按任务类型阅读对应文档，不要只读 `README.md`：
   - 部署、配置、端点和当前可用能力：`README.md`
   - 系统拓扑、组件职责、安全边界和演进条件：`ARCHITECTURE.md`
   - Console 信息架构、视觉、交互和可访问性：`DESIGN.md`
   - Agent、外部连接和知识治理规范：`deploy/silverbullet/space/*.md`
   - 尚在讨论的方案：`.omx/plans/*.md`
3. `.omx/plans` 是设计提案，不是已实现事实。先检查状态、代码、测试和 Git 历史，再描述能力是否已经落地。
4. `.omx/state`、`.omx/context` 和 `.omx/artifacts` 是运行状态或过程证据，不是产品事实来源。

## 仓库与文档边界

- 外层 `..` 是 AI-FDE 研究工作区；本目录 `ai-base` 是独立 Git 仓库和可运行实现。
- 外层 `../.omx/plans/sme-agent-infrastructure-v0.1.md` 提供产品背景，但实现边界以本仓库的 `ARCHITECTURE.md`、`DESIGN.md`、代码和测试为准。
- `vendor/open-connector` 是固定上游提交的 vendored/submodule 边界。除非任务明确要求升级或修补上游，否则不要修改；进入该目录后还必须遵守其自己的 `AGENTS.md`。
- 文档发生冲突时，按关注点选择事实来源：运行方式看 `README.md`，架构与安全看 `ARCHITECTURE.md`，Console 体验看 `DESIGN.md`，提案看对应 plan。若已验证代码与规范文档不一致，不能静默选择一边；完成改动时同步文档，或明确报告差异。

## 项目结构

- `ai-console/`：Next.js 16、React 19、TypeScript 控制面；默认 Server Component，仅交互区域使用 Client Component。
- `mcp-access-gateway/`：Go OAuth Broker、MCP 身份验证、连接解析与策略执行边界。
- `../ai-auth-relay/`：外部部署的企业微信身份认证代理；AI Base 通过短期加密协议暂存授权，企微网页授权与身份交换只在 Relay 完成。
- `agent-runtime/`：FastAPI + PydanticAI 的 Agent 运行边界。
- `rag-mcp/`：LightRAG 的只读 MCP 适配器。
- `deploy/` 与 `compose.yaml`：数据库、网关、认证、知识库和本机部署配置。

## 架构不变量

- 首期保持单机 Docker Compose、薄平台、可替换组件；没有实际容量或隔离证据时，不引入 Kubernetes、Kafka、Redis、ClickHouse、独立向量库或新的重型平台。
- 全局 Caddy 是唯一宿主机能力入口；其他服务默认只暴露在 Compose 网络。新增端口前先更新架构和生产边界说明。
- 外部 OIDC/Dex 是独立身份系统。Pomerium 负责浏览器入口，MCP Access Gateway 负责 MCP OAuth；二者不得退化为信任客户端可伪造的身份头。
- 员工稳定身份使用已验证的 `issuer + subject`。邮箱只用于展示或受限的无歧义兼容匹配，不作为长期授权主键。
- 客户端提交的 `connectionName`、群组、Action 和资源 ID 都不可信；连接选择与授权必须在服务端重新解析和校验。
- 需要凭据的 Connector 在无绑定、无授权、歧义、策略服务失败或参数无法识别时一律失败关闭，不得回退到共享 `default`。
- `no_auth`、`account_bound`、`controlled_shared`、`global` 的语义必须分开。企业级高权限机器人不得为了省事标记为 `global`。
- 模型提示词不是安全边界。写入、删除、批量发送等动作必须经过确定性 Schema、权限、风险、审批/确认、幂等和审计逻辑。
- Token、Secret、敏感业务正文和完整工具参数不得进入浏览器响应、Prompt、Trace 或普通日志。审计只保留追责所需的身份摘要、策略、Action、资源标识摘要、结果和 Trace ID。
- LightRAG 继续复用 PostgreSQL + pgvector + AGE；切换 Embedding 模型或维度前必须迁移或重建向量索引。

## 企业微信与共享连接

必须区分已经落地的基线与近期会话确定的下一步验收目标。

当前基线：

- `controlled_shared`、按员工/群组授权、Action 白名单和 `wecom_bot.call_tool` 硬拒绝已经进入当前代码、测试和 `README.md`。`.omx/plans/wecom-shared-bot-access-control.md` 的“待评审”状态已经滞后；其中资源级 ABAC、完整审计和分阶段交付项仍需逐项用代码与测试确认，不能因 plan 存在就宣称完成。
- 企业微信登录应用的 `CorpID + App Secret` 与 API 模式智能机器人的 `Bot ID + Secret` 是两套独立凭据，不能混用。

近期会话确定的下一步验收目标：

- API 模式智能机器人是企业共享身份，不提供员工个人 OAuth。Console 中的“账号绑定/启用”表示把已验证员工授权到某个机器人，不得宣称为员工向企业微信授予个人 Token。
- 员工启用机器人前必须通过公网 Relay 获得可信的 `CorpID + UserID`，并与当前已登录的平台 OIDC 身份绑定；普通 OIDC 登录本身不足以证明其属于对应企业或机器人可见范围。
- AI Base 只能处理管理员已经配置的机器人，不能声称发现企业内全部机器人。
- 机器人可见性应使用该机器人的 `get_userlist` 与可信 `UserID` 做服务端校验：只展示和允许绑定包含该员工的机器人；查询失败按不可见处理；绑定时再次校验，并为移出可见范围后的禁用/撤权保留刷新机制。
- 企微侧“可见范围”只限制机器人最多能看到什么，不能替代 AI Base 的用户级授权。网关仍需执行“员工/群组 → 机器人连接 → Action → 资源”的逐层判定。
- `wecom_bot.call_tool` 等动态入口不能绕过静态 Action 白名单。对尚不能可靠约束或审计资源的 Action，保持关闭。
- 多个机器人对应不同安全域时使用不同具名连接；无显式选择且授权集合不唯一时返回明确选择错误，不随机路由。

在身份映射、`get_userlist` 校验、撤权刷新、测试和正式文档全部完成前，上述“下一步验收目标”不得写成当前能力。

## Console 与产品体验

- `DESIGN.md` 是 Console 的当前设计源；修改路由、导航、卡片、抽屉、状态语义、视觉 token 或交互时先阅读并同步它。
- 保持“精确、安静、可信”的 macOS 系统设置式体验，不复制 Apple 标志或系统图标，不引入赛博霓虹、营销渐变、玻璃拟态或无层级仪表盘。
- 使用现有组件和 `globals.css` 中的语义 token；卡片使用 `--card-*`，不在页面散落新的阴影、边框和圆角值，不引入 Tailwind 或重量级 UI 依赖。
- 状态必须诚实且可解释：区分健康、异常、离线、未配置、无结果和权限不足，不用演示数据填充空状态，也不只依赖颜色。
- 密钥字段只显示“已配置/未配置”，编辑接口和表单不回显明文。
- 外部专业工作台在新窗口打开；AI Console 负责发现、治理和高频配置，不复制 OpenConnector、LightRAG、Jaeger 或 Promptfoo 的专业界面。
- 管理员与普通员工的导航和 API 权限必须同时隔离；仅隐藏前端控件不构成权限控制。
- 保持 WCAG 2.2 AA、键盘访问、清晰焦点、`aria-live`、Escape 关闭抽屉与焦点恢复；移动端触控目标至少 44px。

## 实现与变更约定

- 优先复用已有函数、组件、Schema 和测试模式；保持差异小且可回滚。未经明确要求不新增依赖。
- OpenConnector Provider 的认证字段和 Action 以真实上游 Schema 为准，不在 Console 复制一份会漂移的静态定义。
- 不通过修改 vendored OpenConnector 来规避 AI Base 的身份、策略或审计责任；AI Base 的企业授权应落在 Console/PostgreSQL/MCP Gateway 边界。
- 数据库变更必须兼容空库和已有库，支持重复安全执行；先落 migration，再发布依赖它的 Console/网关代码。
- 任何认证、Connector、MCP 或企微变更都要覆盖成功路径、未授权、伪造别名、策略不可用、撤权和已有飞书/no-auth 回归。
- 任何 UI 行为变更都要覆盖 loading、empty、error、disabled、success 和慢网络状态；新增或编辑资源成功前保持为草稿，不提前进入正式列表。

## 文档同步规则

- 改变部署命令、环境变量、端点、当前可用能力或操作流程：更新 `README.md`。
- 改变组件职责、网络、身份、凭证、数据、安全或失败策略：更新 `ARCHITECTURE.md`。
- 改变 Console 路由、信息架构、视觉、交互或可访问性：更新 `DESIGN.md`，并刷新日期与 evidence。
- 实现 `.omx/plans` 中的设计时，更新其状态/完成项，并把稳定结论迁入上述正式文档；不要让 plan 长期成为唯一说明。
- 新增治理规范时，将其纳入 README 或明确索引，不再增加无人发现的孤立 Markdown。

## 验证

按风险从小到大验证；没有新鲜证据时不要宣称完成。

```bash
# Console（仅覆盖 ai-console workspace）：Node.js >= 22
npm run check

# Compose 配置
docker compose config --quiet

# Go（仓库要求的 Go 版本，以各 go.mod 为准）
(cd mcp-access-gateway && go test ./...)
(cd ../ai-auth-relay && go test ./...)

# RAG MCP
(cd rag-mcp && python3 -m unittest test_server.py)
```

- 小改动先跑直接相关测试，再跑上述完整检查。
- UI 改动还需对受影响路由做桌面浏览器 smoke test；认证、密钥不回显、抽屉焦点和真实空状态属于必查项。
- 本机工具版本不足时，明确记录未运行项、实际版本和替代验证；不能把环境失败写成测试通过。
- `docker compose down -v` 会删除本地数据卷，除非用户明确要求清空数据，否则禁止使用。
