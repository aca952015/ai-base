# AI Base 基础架构

## 目标

为中小企业提供一套轻量、可替换、以开源组件为主的 Agent 基础设施。外部大模型负责推理，企业内部保留身份、策略、工具、知识、评测、审计和成本控制。

首期坚持单机 Docker Compose 可运行，不引入 Kubernetes、Kafka、Redis、ClickHouse 或独立向量数据库。

## 推荐拓扑

```text
企业 OIDC
   │
Pomerium ── AI Console / Component Portal (Next.js)
   │              │ 统一入口、配置、健康检查、运行摘要
   │              ▼
   └──── Agent Runtime (FastAPI + PydanticAI + DBOS)
                    │
        ┌───────────┼──────────────┬──────────────┐
        ▼           ▼              ▼              ▼
 Envoy AI GW    MCP 工具层    Open Connector   SilverBullet
        │           │              │              │ Markdown
   外部大模型    内部业务 API     外部 SaaS        ▼
        │           │              │        PostgreSQL + pgvector
        └───────────┴──────────────┴──────────────┘
                            │ OpenTelemetry
                            ▼
                         Jaeger

Promptfoo：使用 Docker `quality` profile 或 CI 按需运行，结果进入发布门禁，不常驻默认生产环境。
```

## 组件职责

| 能力 | 主选 | 首期职责 | 轻量化边界 |
| --- | --- | --- | --- |
| 控制台与组件 Portal | Next.js 16 + React 19 | 统一打开专业工作台、管理端点、查看状态、触发安全占位动作、汇总运行证据 | 不直接控制 Docker/Kubernetes，不复制专业组件界面 |
| Agent Runtime | FastAPI + `pydantic-ai-slim` | Agent 运行、结构化输出、身份上下文、业务策略 | 不保存外部 SaaS 密钥 |
| 持久工作流 | DBOS | 审批、队列、定时和恢复 | 复用 PostgreSQL，不加消息队列 |
| 大模型网关 | Envoy AI Gateway standalone | OpenAI 兼容入口、供应商协议转换、模型路由与流式转发 | 网关本身无 UI/数据库；Console 生成原生资源配置；不启用 MCP Route |
| 内部工具 | 官方 MCP SDK + 薄注册层 | JSON Schema、版本、作用域、风险等级、幂等和审计 | MCP 是协议，不当作安全沙箱 |
| 外部系统 | Open Connector | OAuth、连接凭证、Action 目录和执行 | HTTP 为主接入，MCP 为兼容入口 |
| 知识工作台 | SilverBullet | 类 Obsidian 的 Markdown、双向链接和人工审阅 | Markdown 是知识源，不将向量库当主数据 |
| 数据与 RAG | PostgreSQL 17 + pgvector | 控制面、审计、全文、向量与 ACL 过滤 | 首期不增加专用向量库 |
| 评测 | Promptfoo | 黄金集、回归、安全、红队与发布门禁 | Docker profile / CI 按需运行 |
| 可观测 | OpenTelemetry + Jaeger v2 | Agent、模型、检索、工具的统一 Trace | Trace 不替代合规审计账本 |
| 身份边界 | Pomerium Core + 企业 OIDC | 登录、反向代理和路由策略 | Pomerium 不是 IdP |
| 密钥配置 | Console 数据卷；生产发布可接 SOPS + age | 渠道 Key 独立文件、版本化配置和受控发布 | API/控制台不回显明文；生产环境加密静态存储 |

## Open Connector 边界

Agent Runtime 通过 HTTP `/v1/actions/*` 调用 Open Connector。HTTP 路径支持连接别名和 `Idempotency-Key`，适合作为内部编排主路径；`/mcp` 用于兼容通用 MCP Host。

- 默认关闭 provider proxy，仅开放审阅过的 Action。
- 强制设置静态加密密钥、Admin Token 和 Runtime Token/JWT。
- Agent 日志、Prompt 和 Trace 不记录 OAuth access/refresh token。
- 写操作由 Agent Runtime 做身份、审批、风险和审计判断，Open Connector 只负责凭证与调用。
- 自托管运行时不应视为完整多租户 IAM；默认每个客户组织或高隔离域部署独立实例、数据卷和加密键。

## 知识库设计

SilverBullet 提供浏览器内 Markdown 编辑、Wiki Link、双向链接和插件扩展，承担类似 Obsidian 的员工知识工作台。同步服务将 Markdown 派生为 PostgreSQL 中的全文与向量索引，并保存：

- 来源 URI、文档版本、更新时间和内容哈希；
- 空间 ACL、部门或角色范围；
- 分块策略、Embedding 模型和索引版本；
- 删除传播与索引重建状态。

检索顺序为 ACL 预过滤 → 全文/向量混合召回 → 可选重排 → 带来源返回。删除 Markdown 后必须删除对应切片。

## 控制台边界

当前 `ai-console` 是可运行的控制面 MVP：

- 一站式组件 Portal、七个管理页面和 Agent 详情页；
- 为每个组件提供实时状态、工作台入口、内部管理入口和端点配置入口；
- 通过独立卡片页面管理大模型渠道、Provider/Base URL、服务端 Key、模型别名和启停状态，并原子生成 Envoy AI Gateway 原生资源；
- 通过单独修订文件触发网关进程重载，Key 以文件替换方式注入生成过程，不写入路由 YAML 或浏览器响应；
- 服务端聚合 Agent Runtime、Envoy AI Gateway、OpenConnector、SilverBullet、Jaeger 与 Promptfoo 的真实运行摘要；
- JSON 配置读取、字段白名单校验和原子写入；
- HTTP/TCP 服务健康探测；
- 知识同步、评测等动作采用安全占位实现，不执行外部命令；
- 未接入或无结果的能力显示“未配置”或真实空状态，不以演示数据补齐。

聚合层使用短超时和 10 秒内存缓存，避免单个组件拖慢整个控制台。OpenConnector Runtime/Admin Token 与大模型渠道 Key 仅存在于服务端环境；SilverBullet Space 以只读目录挂载，默认只读取文件元数据；大模型网关的请求/响应、知识正文、外部凭证与 Jaeger Span 日志均不进入浏览器响应。`GET /api/overview` 是页面统一读取面，`refresh=1` 只用于主动刷新和排障。

Portal 负责发现、导航和治理，专业组件负责深度操作。外部工作台使用明确的新窗口链接，不通过 iframe 嵌入，以保留认证、路由和升级边界。

默认 Compose 启动 AI Console、Agent Runtime、Envoy AI Gateway standalone、OpenConnector、SilverBullet、PostgreSQL/pgvector 和 Jaeger。Promptfoo 位于 `quality` profile；Pomerium 位于需要企业 OIDC 凭据的 `oidc` profile。所有宿主机端口仅绑定 loopback。

下一阶段再接入企业 OIDC、Promptfoo 结果导出、SilverBullet 分块/Embedding 索引、发布审批与审计表，不在当前浏览器控制台中添加容器管理权限。

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
- [Model Context Protocol Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [pgvector](https://github.com/pgvector/pgvector)
- [OpenTelemetry Python](https://github.com/open-telemetry/opentelemetry-python)
- [Jaeger](https://github.com/jaegertracing/jaeger)
- [Promptfoo](https://github.com/promptfoo/promptfoo)
