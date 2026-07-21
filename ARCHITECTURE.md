# AI Base 基础架构

## 目标

为中小企业提供一套轻量、可替换、以开源组件为主的 Agent 基础设施。外部大模型负责推理，企业内部保留身份、策略、工具、知识、评测、审计和成本控制。

首期坚持单机 Docker Compose 可运行，不引入 Kubernetes、Kafka、Redis、ClickHouse 或独立向量数据库。

## 推荐拓扑

```text
独立企业 OIDC
   │
Pomerium ── AI Console / Component Portal (Next.js)
   │              │ 配置、健康检查、运行摘要
   │              ▼
   │      全局能力网关 (Caddy :8080)
   │       │ /v1,/mcp  │ /rag,/runtime │ /connector │ /otel
   │       ▼           ▼               ▼            ▼
   │  Envoy AI GW  Agent Runtime   Open Connector  Jaeger
   │       │       (FastAPI +          │
   │       │        PydanticAI)        │
   │       ▼           │               ▼
   │   外部大模型       │            外部 SaaS
   │                   ▼
   └──────────── SilverBullet ── PostgreSQL + pgvector
                    Markdown          全文/向量

Promptfoo：使用 Docker `quality` profile 或 CI 按需运行，结果进入发布门禁，不常驻默认生产环境。
```

## 组件职责

| 能力 | 主选 | 首期职责 | 轻量化边界 |
| --- | --- | --- | --- |
| 控制台与组件 Portal | Next.js 16 + React 19 | 统一打开专业工作台、管理端点、查看状态、触发安全占位动作、汇总运行证据 | 不直接控制 Docker/Kubernetes，不复制专业组件界面 |
| 全局网关 | Caddy 2.11 | 统一代理模型、MCP、RAG、Runtime、Connector、知识库、可观测与 SSO 管理入口 | 不承载业务逻辑、密钥管理或数据存储 |
| Agent Runtime | FastAPI + `pydantic-ai-slim` | Agent 运行、结构化输出、身份上下文、业务策略 | 不保存外部 SaaS 密钥 |
| 持久工作流 | DBOS | 审批、队列、定时和恢复 | 复用 PostgreSQL，不加消息队列 |
| AI 网关 | Envoy AI Gateway standalone | OpenAI 兼容模型入口；MCP 服务聚合、工具路由与过滤 | 网关本身无 UI/数据库；Console 生成 `AIGatewayRoute` 与 `MCPRoute` 原生资源 |
| 内部工具 | 官方 MCP SDK + 薄注册层 | JSON Schema、版本、作用域、风险等级、幂等和审计 | MCP 是协议，不当作安全沙箱 |
| 外部系统 | Open Connector | OAuth、连接凭证、Action 目录和执行 | HTTP 为主接入，MCP 为兼容入口 |
| 知识工作台 | SilverBullet | 类 Obsidian 的 Markdown、双向链接和人工审阅 | Markdown 是知识源，不将向量库当主数据 |
| 数据与 RAG | PostgreSQL 17 + pgvector | 控制面、审计、全文、向量与 ACL 过滤 | 首期不增加专用向量库 |
| 评测 | Promptfoo | 黄金集、回归、安全、红队与发布门禁 | Docker profile / CI 按需运行 |
| 可观测 | OpenTelemetry + Jaeger v2 | Agent、模型、检索、工具的统一 Trace | Trace 不替代合规审计账本 |
| 外部认证中心 | 企业 OIDC / 独立轻量 IdP | 用户、凭据、MFA 与 OIDC Client | 不属于 AI Base Stack，由身份团队独立部署和运维 |
| 身份边界 | Pomerium Core + 外部 OIDC | 登录、反向代理和路由策略 | Pomerium 不是 IdP，不保存用户密码 |
| 密钥配置 | Console 数据卷；生产发布可接 SOPS + age | 模型渠道与 MCP 上游 Key 独立文件、版本化配置和受控发布 | API/控制台不回显明文；生产环境加密静态存储 |

## Open Connector 边界

Agent Runtime 通过 HTTP `/v1/actions/*` 调用 Open Connector。HTTP 路径支持连接别名和 `Idempotency-Key`，适合作为内部编排主路径；`/mcp` 用于兼容通用 MCP Host。

- 默认关闭 provider proxy，仅开放审阅过的 Action。
- 强制设置静态加密密钥、Admin Token 和 Runtime Token/JWT；管理 UI 通过 Pomerium 登录后由内部代理注入 Admin Token。
- Agent 日志、Prompt 和 Trace 不记录 OAuth access/refresh token。
- 写操作由 Agent Runtime 做身份、审批、风险和审计判断，Open Connector 只负责凭证与调用。
- 自托管运行时不应视为完整多租户 IAM；默认每个客户组织或高隔离域部署独立实例、数据卷和加密键。

## 全局能力网关边界

全局网关是 AI Base 唯一的宿主机网络入口。Caddy 映射 `127.0.0.1:8080` 与 `127.0.0.1:8443`：`/v1` 与 `/mcp` 保持 Envoy AI 原始路径，`/rag` 保留给 Agent Runtime，`/runtime`、`/connector`、`/knowledge`、`/jaeger`、`/promptfoo` 与 `/otel` 在转发前移除能力前缀；工作台使用 `*.localhost:8080` 域名路由，SSO 入口在 8443 上转发至 Pomerium。

Envoy AI Gateway、AI Console、Agent Runtime、Open Connector、SilverBullet、Jaeger、Promptfoo、PostgreSQL 和 Pomerium 均不直接暴露宿主机端口。PostgreSQL 只允许 Compose 内部访问；Open Connector 与 AI Console 管理入口经过 Pomerium，其余 HTTP 工具均由全局网关反向代理。

RAG 当前只具备 PostgreSQL/pgvector 存储基础，`/rag/health` 会改写为 Runtime `/ready` 并返回真实就绪状态。知识分块、Embedding、ACL 检索和引用返回尚未实现，其他 `/rag/*` 路径仅为后续 API 保留并原样透传。

## 知识库设计

SilverBullet 提供浏览器内 Markdown 编辑、Wiki Link、双向链接和插件扩展，承担类似 Obsidian 的员工知识工作台。同步服务将 Markdown 派生为 PostgreSQL 中的全文与向量索引，并保存：

- 来源 URI、文档版本、更新时间和内容哈希；
- 空间 ACL、部门或角色范围；
- 分块策略、Embedding 模型和索引版本；
- 删除传播与索引重建状态。

检索顺序为 ACL 预过滤 → 全文/向量混合召回 → 可选重排 → 带来源返回。删除 Markdown 后必须删除对应切片。

## 控制台边界

当前 `ai-console` 是可运行的控制面 MVP：

- 一站式组件 Portal、基础设施管理页面和 Agent 详情页；
- 为每个组件提供实时状态、工作台入口、内部管理入口和端点配置入口；
- 通过独立卡片页面管理大模型渠道、Provider/Base URL、服务端 Key、模型别名和启停状态，并原子生成 Envoy AI Gateway 原生资源；
- 默认将 Open Connector `/mcp` 以系统托管、只读配置接入 Envoy AI，并通过与模型配置并列的 MCP 配置页面管理其他 Streamable HTTP 上游、工具命名空间、允许/排除列表和可选密钥；
- 通过连接器配置页面管理 OpenConnector 的连接生命周期；Connector 搜索、认证方式和动态字段读取真实 Provider Schema，凭证只经服务端 Admin API 写入且不回显，OAuth 授权成功后才创建卡片；
- 通过单独修订文件触发网关进程重载，Key 以文件替换方式注入生成过程，不写入路由 YAML 或浏览器响应；
- 服务端聚合全局能力网关、Agent Runtime、Envoy AI Gateway、OpenConnector、SilverBullet、Jaeger 与 Promptfoo 的真实运行摘要；
- JSON 配置读取、字段白名单校验和原子写入；
- HTTP/TCP 服务健康探测；
- 知识同步、评测等动作采用安全占位实现，不执行外部命令；
- 未接入或无结果的能力显示“未配置”或真实空状态，不以演示数据补齐。

聚合层使用短超时和 10 秒内存缓存，避免单个组件拖慢整个控制台。OpenConnector Runtime/Admin Token、大模型渠道 Key 与 MCP 上游 Key 仅存在于服务端环境；SilverBullet Space 以只读目录挂载，默认只读取文件元数据；网关请求/响应、知识正文、外部凭证与 Jaeger Span 日志均不进入浏览器响应。`GET /api/overview` 是页面统一读取面，`refresh=1` 只用于主动刷新和排障。

Portal 负责发现、导航和常用配置治理，专业组件负责 Action 调试、运行策略等深度操作。外部工作台使用明确的新窗口链接，不通过 iframe 嵌入，以保留认证、路由和升级边界。

默认 Compose 启动 AI Console、Caddy 全局网关、Agent Runtime、Envoy AI Gateway standalone、OpenConnector、SilverBullet、PostgreSQL/pgvector、Jaeger 和 Pomerium；Promptfoo 位于 `quality` profile。认证中心不属于 AI Base Stack，Pomerium 使用环境变量连接外部 OIDC。只有全局网关映射 loopback 宿主机端口。

下一阶段可补充 Promptfoo 结果导出、SilverBullet 分块/Embedding 索引、发布审批与审计表；不在当前浏览器控制台中添加容器管理权限。

## 演进触发条件

- pgvector 出现明确的召回或吞吐瓶颈后，再评估 Qdrant。
- 单机容量、容灾或多团队隔离成为实际问题后，再评估 k3s/Kubernetes。
- Agent 需要复杂图状态时，再评估 LangGraph；默认维持 PydanticAI 的线性、可测试运行模型。
- 对象级 ABAC/RBAC 超出 Pomerium 路由策略后，再引入专门 PDP。

## 上游资料

- [Open Connector](https://github.com/oomol-lab/open-connector)
- [SilverBullet](https://github.com/silverbulletmd/silverbullet)
- [PydanticAI](https://github.com/pydantic/pydantic-ai)
- [Envoy AI Gateway](https://github.com/envoyproxy/ai-gateway)
- [Caddy](https://github.com/caddyserver/caddy)
- [Model Context Protocol Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [pgvector](https://github.com/pgvector/pgvector)
- [OpenTelemetry Python](https://github.com/open-telemetry/opentelemetry-python)
- [Jaeger](https://github.com/jaegertracing/jaeger)
- [Promptfoo](https://github.com/promptfoo/promptfoo)
