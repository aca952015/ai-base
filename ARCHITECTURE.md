# AI Base 基础架构

## 目标

为中小企业提供一套轻量、可替换、以开源组件为主的 Agent 基础设施。外部大模型负责推理，企业内部保留身份、策略、工具、知识、评测、审计和成本控制。

首期坚持单机 Docker Compose 可运行，不引入 Kubernetes、Kafka、Redis、ClickHouse 或独立向量数据库。

## 推荐拓扑

```text
企业微信工作台 ── /auth/wework ── 普通 Pomerium ── 当前平台身份
                                      │ 一次性绑定请求 + 同浏览器 nonce
                                      ▼
                               AI Console 服务端 ── 加密短期请求 ── tn1 Relay
                                      ▲                                  │
                                      │ 加密身份结果                      │ gettoken/getuserinfo
                                      └──────── 浏览器回程 ───────────────┤
                                                                         ▼
普通浏览器入口 ─────────────── 普通 Pomerium ─────────────── 企业微信网页授权
                                      │
                                      ▼
                                  AI Console / Component Portal (Next.js)
   │              │ 配置、健康检查、运行摘要
   │              ▼
   │      全局能力网关 (Caddy :8080)
   │       │ /v1       │ /mcp,/oauth        │ /rag,/runtime │ /connector
   │       ▼           ▼                    ▼               ▼
   │  Envoy AI GW  MCP Access GW        Agent Runtime   Open Connector
   │       │        (Go + OAuth Broker)  (FastAPI +          │
   │       │             │                PydanticAI)        │
   │       │◀────────────┘                                   │
   │       ├──────── RAG MCP ────────┐      ▼
   │       ▼           │             ▼   外部 SaaS
   │   外部大模型       │         LightRAG
   │                   ▼          文档/RAG
   ├──────────────────────────── PostgreSQL + pgvector + AGE
   │                                  KV/向量/图
   └── 安全查询 ── Jaeger 2.19 + Badger ── SpanMetrics ── Prometheus
                         ▲ 已净化 Trace             ▲ GenAI metrics
                 OTel Collector（事件/正文脱敏）
                         ▲ OTLP Trace
                Agent Runtime / MCP GW / Envoy AI Gateway

Promptfoo：使用 Docker `quality` profile 或 CI 按需运行，结果进入发布门禁，不常驻默认生产环境。
```

## 组件职责

| 能力 | 主选 | 首期职责 | 轻量化边界 |
| --- | --- | --- | --- |
| 控制台与组件 Portal | Next.js 16 + React 19 | 统一打开专业工作台、管理端点、查看状态、触发安全占位动作、汇总运行证据 | 不直接控制 Docker/Kubernetes，不复制专业组件界面 |
| 全局网关 | Caddy 2.11 | 统一代理模型、MCP、RAG、Runtime、Connector、知识库、可观测与 SSO 管理入口 | 不承载业务逻辑、密钥管理或数据存储 |
| 出口 DNS | AdGuard dnsproxy | 为 Envoy AI Gateway 与 Open Connector 提供分流解析；公网域名走 DoH，企业内网域名走本机 DNS | 不映射宿主机端口，不通过关闭 SSRF 校验兼容 Fake-IP |
| Agent Runtime | FastAPI + `pydantic-ai-slim` | Agent 运行、结构化输出、身份上下文、业务策略 | 不保存外部 SaaS 密钥 |
| MCP 访问网关 | Go + `net/http` + OAuth/OIDC | 面向兼容 OAuth 的 MCP 客户端提供发现、DCR、PKCE、员工登录、MCP 鉴权、身份绑定会话和访问策略 | Dex 仅作登录上游；不注册 MCP 上游、不向 Envoy 透传员工 Token、不执行 Agent |
| 企业微信认证中继 | 外部 Go 服务 + AES-256-GCM 协议 | 在固定公网出口完成企微网页授权、`gettoken/getuserinfo`，返回短期加密身份结果 | 不持久化 CorpID、Secret、Token 或 UserID；不替代平台 OIDC；不接受浏览器指定回调目标 |
| 持久工作流 | DBOS | 审批、队列、定时和恢复 | 复用 PostgreSQL，不加消息队列 |
| AI 网关 | Envoy AI Gateway standalone | OpenAI 兼容模型入口；内部 MCP 注册、聚合、工具路由与过滤 | MCP API 不直接暴露；Console 生成 `AIGatewayRoute` 与 `MCPRoute` 原生资源 |
| 内部工具 | 官方 MCP SDK + 薄注册层 | JSON Schema、版本、作用域、风险等级、幂等和审计 | MCP 是协议，不当作安全沙箱 |
| 外部系统 | Open Connector | OAuth、连接凭证、Action 目录和执行 | HTTP 为主接入，MCP 为兼容入口 |
| 知识与 RAG | LightRAG | 文档导入、分块、混合检索、知识图谱和引用查询 | 复用大模型网关与 PostgreSQL，不增加独立向量或图数据库 |
| RAG MCP 适配器 | Python 标准库 | 将 LightRAG 问答、上下文、文档状态和知识图谱读取封装为 Streamable HTTP MCP 工具 | 独立容器、只读调用；不修改 LightRAG 镜像或代码 |
| 数据基础设施 | PostgreSQL 17 + pgvector + Apache AGE | 控制面、审计、LightRAG KV、文档状态、向量与图数据 | 单一数据库基础设施，使用 workspace 隔离 LightRAG 数据 |
| 评测 | Promptfoo | 黄金集、回归、安全、红队与发布门禁 | Docker profile / CI 按需运行 |
| 可观测 | OpenTelemetry + Jaeger 2.19 + Prometheus 3 | Agent/模型/MCP Trace、安全诊断样本、规范调用量/延迟/Token 与 MCP 决策分析 | Badger/Prometheus 仅适合单机诊断；Trace/Metrics 不替代合规审计账本 |
| 外部认证中心 | 企业 OIDC / 独立轻量 IdP | 用户、凭据、MFA 与 OIDC Client | 不属于 AI Base Stack，由身份团队独立部署和运维 |
| 身份边界 | Pomerium Core + 外部 OIDC | 当前平台登录、持久化浏览器会话、反向代理和路由策略 | Pomerium 不是 IdP，不保存用户密码；企微身份只用于与既有平台账号建立映射 |
| 密钥配置 | Console 数据卷；生产发布可接 SOPS + age | 模型渠道与 MCP 上游 Key 独立文件、版本化配置和受控发布 | API/控制台不回显明文；生产环境加密静态存储 |

## Open Connector 边界

Agent Runtime 通过 HTTP `/v1/actions/*` 调用 Open Connector。HTTP 路径支持连接别名和 `Idempotency-Key`，适合作为内部编排主路径；`/mcp` 用于兼容通用 MCP Host。

- 默认关闭 provider proxy，仅开放审阅过的 Action。
- 强制设置静态加密密钥、Admin Token 和 Runtime Token/JWT；管理 UI 通过 Pomerium 登录后由内部代理注入 Admin Token。
- Agent 日志、Prompt 和 Trace 不记录 OAuth access/refresh token。
- 写操作由 Agent Runtime 做身份、审批、风险和审计判断，Open Connector 只负责凭证与调用。
- 自托管运行时不应视为完整多租户 IAM；默认每个客户组织或高隔离域部署独立实例、数据卷和加密键。

## MCP 身份边界

Envoy AI Gateway 是内部外部 MCP 注册中心。Console 管理 `MCPRoute`、Backend、上游密钥和工具过滤；Envoy 的 MCP 监听端口只在 Compose 网络中开放。

Open Connector 与 RAG MCP 是系统托管的内置上游。RAG MCP 运行在独立 `rag-mcp` 容器中，通过 API Key 调用 LightRAG 内网接口，只暴露查询类工具；LightRAG 本身不承载 MCP 协议，也不因该适配层发生代码或镜像改动。

公共 `/mcp` 与 `/oauth` 由独立 Go 服务 MCP Access Gateway 接管：

- OAuth Broker 面向兼容 OAuth 的 MCP 客户端提供 RFC 8414 发现、动态客户端注册、Authorization Code + S256 PKCE、Token 与 JWKS；
- Broker 通过独立 OIDC Client 将员工登录委托给 Dex/企业 IdP，并校验 state、nonce 与上游 PKCE；
- Access Token 保持 1 小时短有效期；Refresh Token 默认 90 天滑动有效，服务端只将 Token 哈希原子持久化到 `mcp-auth-data`，因此员工设备休眠和网关重启不会中断长期登录；
- 网关在内存中保留最近 24 小时的成功鉴权客户端摘要，按员工 Subject、Issuer 与 OAuth Client 绑定聚合；Console 通过独立管理令牌读取，外部能力网关不暴露该管理端点；
- 每个 MCP 请求都验证 Broker JWT Access Token 的 issuer、audience、有效期和必需 scope；
- 保护 OpenConnector 的 `execute_action`、`get_action_guide` 与 `list_connections`：网关按 `issuer + subject` 查询员工绑定和受控共享策略，覆盖客户端连接名，并在本地过滤连接列表；
- 企业微信共享机器人身份来自 `wecom_identity_links` 中已验证的平台账号映射；Broker Token 不携带明文 UserID，解析器只读取 CorpID/UserID 摘要；
- 发布 RFC 9728 Protected Resource Metadata，并在 `401` 响应中返回 `WWW-Authenticate` 发现地址；
- 员工 Access Token 在进入 Envoy 前移除，禁止 Token passthrough；
- Envoy Session ID 经 HMAC 签名并绑定 `issuer + subject + client_id`，避免跨员工会话复用；
- MCP 客户端回调地址使用明确白名单，Refresh Token 一次性轮换；服务重启后安全失效并要求重新登录；
- Go 网关只做身份、个人连接选择与协议边界，Agent 运行仍由 Agent Runtime 承担。
- 公网入口在任何 TraceContext 提取前清除 W3C、B3、Envoy request/debug、会话与身份载体，由 Go 建立新的 100% sampled root；每条可解析 JSON-RPC message 使用一个 `mcp.server.message` span，响应观察器只保留 ID、数值错误码、枚举结果和耗时。
- 授权日志带平台 Trace ID；员工身份使用独立、版本化 HMAC 对 `issuer + subject` 的无歧义长度前缀编码，原始身份与被拒绝的伪造连接别名不进入 Trace、指标或普通日志。

个人 Connector Token 由 OpenConnector 加密保存；AI Base PostgreSQL 保存稳定 `issuer + subject` 到命名连接的映射。Console 与 MCP Broker 使用相同的 `usr_ + SHA-256(login issuer + upstream subject)` opaque subject 契约；旧版个人绑定只允许通过 Broker 已验证的企业邮箱在同一 issuer 下做一次无歧义迁移，冲突时关闭失败。受控共享资源保存具名连接引用、授权模式与 Action 白名单，不复制 Bot Secret。`wecom_visibility` 资源只能用于 `wecom_bot`：解析器优先使用 Broker Token 中的企微摘要；Token 没有该声明时，读取当前平台主体在 `wecom_identity_links` 中的一次性企微身份映射，再用唯一企微认证配置中的 CorpID 校验身份域，调用对应具名机器人的 `get_userlist` 并只比较 UserID 哈希。60 秒缓存到期或查询异常后不使用旧结果。客户端不得决定 OpenConnector `connectionName`，服务端映射是唯一可信来源；需要凭据的 Connector 不得回退到共享 `default`，只有上游声明为 `no_auth` 的虚拟公共 Connector 可以使用系统 `default`。内部映射查询使用独立 Bearer Token，查询服务异常时关闭失败。

企业微信不是平台登录 IdP。CorpID、App Secret 和 Relay 回调由管理员在 `/integrations/wecom-authentication` 的唯一表单维护，并保存在 PostgreSQL 单例表 `wecom_authentication_configuration`；Secret 使用 Console 既有 AES-256-GCM 静态加密。浏览器、Pomerium、Dex 和 MCP Broker 均不接触 App Secret。`WECOM_RELAY_SHARED_KEY` 是 AI Base 与单租户 Relay 之间的协议启动信任根，使用独立部署密钥提供，不能依赖登录后的 Console 页面。

企业微信工作台首页使用主 Console 的 `/auth/wework`。主 Pomerium 先确认当前平台账号，Console 创建 10 分钟、一次性、只保存 SHA-256 请求/nonce 摘要的绑定事务，并设置主站 host-only 的 `Secure`、`HttpOnly`、`SameSite=Lax` Cookie。Console 服务端把 CorpID、App Secret、请求令牌、内网完成地址和期限封装成 AES-256-GCM 短期票据，通过 `POST /api/wecom/authorizations` 暂存到 Relay；浏览器只得到随机授权 ID。

Relay 在内存中一次性消费授权 ID，生成企微 state 与 HttpOnly Cookie，并把浏览器送入 `snsapi_base`。企业微信只回调 Relay 的固定 `/callbacks/wecom`；Relay 从自己的固定公网出口调用 `gettoken/getuserinfo`，要求返回企业 UserID，然后签发 5 分钟加密结果。结果经浏览器返回主站 `/auth/wework/complete`，完成页再次验证主 Pomerium 身份、同浏览器 nonce、未过期未消费数据库请求、结果 AEAD、Relay issuer 和当前 CorpID。成功后只保存平台 `issuer + subject`、Relay issuer、派生的稳定企微 Subject，以及 CorpID/UserID 哈希；同一企微身份不能绑定两个平台账号。

Relay 不持久化 CorpID、Secret、Access Token 或 UserID，重启会使在途请求安全失效。篡改、过期、重放、Cookie 丢失、中继不可用、企业不匹配或企微 API 失败都关闭失败。当前 HTTP 中继按用户部署约束受支持，AEAD 保护票据内容与完整性，但不等价于 TLS 的完整传输层保护；未来启用 HTTPS 不改变协议。企业微信应用可信 IP 必须配置 Relay 的固定公网出口，而不是 AI Base 内网出口。

普通 Pomerium 会话为 14 小时固定上限，通过 PostgreSQL Data Broker 写入 `ai_base_pomerium`。绑定流程复用同一平台会话，不创建第二套 Pomerium 或 Dex 企微 Connector。数据库由一次性 `pomerium-database-init` 服务幂等创建；删除 PostgreSQL 数据卷、轮换 Cookie/Shared Secret、上游 Token 刷新失败、主动退出或策略撤权仍会提前终止会话。

## 出口 DNS 与 SSRF

宿主机代理启用 Fake-IP 时，Docker 默认 DNS 可能把公网域名解析到 `198.18.0.0/15` 或 ULA。Open Connector 会按 SSRF 策略拒绝这些保留地址，因此 Envoy AI Gateway 与 Open Connector 共用内部 `egress-dns`：公网查询通过 DNS-over-HTTPS 获取真实地址，`AI_BASE_INTERNAL_DNS_ZONE` 指定的企业内网域名则分流到 Docker 继承的本机 DNS，默认值为 `bluetron.cn`。

`OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK` 保持为 `false`，不得用全局放开私网访问来规避 Fake-IP；新增企业内网域名时，应先确认调用方确实需要访问，再为 `egress-dns` 增加明确的域名分流规则。

## 全局能力网关边界

全局网关是 AI Base 唯一的宿主机网络入口。Caddy 映射 `127.0.0.1:8080` 与 `127.0.0.1:8443`：`/v1` 转发 Envoy 模型接口，`/mcp` 转发 MCP Access Gateway，`/rag` 转发 LightRAG，`/runtime`、`/connector`、`/knowledge` 与 `/promptfoo` 在转发前移除能力前缀；企微身份绑定只使用受主 Pomerium 保护的 Console `/auth/wework` 与 `/auth/wework/complete`，全局网关不再暴露 `/wecom-oidc`。工作台使用 `*.localhost:8080` 域名路由，SSO 入口在 8443 上转发至 Pomerium。Jaeger 只通过 `jaeger.localhost.pomerium.io:8443` 的管理员策略开放；OTLP 与 Prometheus 只在 Compose 网络内可达。

Envoy AI Gateway、AI Console、Agent Runtime、Open Connector、LightRAG、Jaeger、Promptfoo、PostgreSQL 和 Pomerium 均不直接暴露宿主机端口。PostgreSQL 只允许 Compose 内部访问；Open Connector 与 AI Console 管理入口经过 Pomerium，其余 HTTP 工具均由全局网关反向代理。

LightRAG 的 `/rag/*` API 和 `knowledge.localhost:8080/webui` 统一经过 Caddy，网关在容器内注入 LightRAG API Key。LightRAG 的对话和 Embedding 请求走 Envoy AI Gateway；默认分别使用 `qwen` 与 `BAAI/bge-m3`，不直接保存外部模型密钥。

AI Console 通过 LightRAG 容器内网的配置控制面管理运行参数。控制面不映射宿主机端口，也不接收外部模型凭证；它将配置原子写入独立数据卷，重启 LightRAG 子进程并等待健康检查，启动失败时回滚旧配置。管理员在 `/settings/lightrag` 只能选择 Envoy AI Gateway 已启用渠道发布的模型；保存前由 AI Console 通过网关发起最小 Embedding 请求，以确认模型能力并自动记录向量维度。

## 知识库设计

LightRAG 提供文档导入、分块、实体关系抽取、混合检索、知识图谱可视化和带上下文查询。四类存储统一复用 PostgreSQL：

- `PGKVStorage` 保存缓存、切片和文档信息；
- `PGDocStatusStorage` 保存文档索引状态；
- `PGVectorStorage` 通过 pgvector 保存实体、关系与切片向量；
- `PGGraphStorage` 通过 Apache AGE 保存实体关系图。

`WORKSPACE=ai_base` 隔离 LightRAG 数据。Embedding 维度在首次建表时固定，切换模型或维度必须执行向量数据迁移或重建，不能直接覆盖配置。

## 控制台边界

当前 `ai-console` 是可运行的控制面 MVP：

- 一站式组件 Portal、基础设施管理页面和 Agent 详情页；
- 为每个组件提供实时状态、工作台入口、内部管理入口和端点配置入口；
- 通过独立卡片页面管理大模型渠道、Provider/Base URL、服务端 Key、模型别名和启停状态，并原子生成 Envoy AI Gateway 原生资源；
- 默认将 Open Connector `/mcp` 与独立 RAG MCP 以系统托管、只读配置接入 Envoy AI，并通过与模型配置并列的 MCP 配置页面管理其他 Streamable HTTP 上游、工具命名空间、允许/排除列表和可选密钥；
- 通过连接器配置页面管理 OpenConnector 的连接生命周期；Connector 搜索、认证方式和动态字段读取真实 Provider Schema，凭证只经服务端 Admin API 写入且不回显，OAuth 授权成功后才创建卡片；
- 企业微信 API 模式智能机器人作为 `controlled_shared` 具名连接在连接器配置页面维护；保存时同时写入 `wecom_visibility` 与静态 Action 白名单，员工侧不创建机器人绑定；
- 通过管理员集成管理页面维护唯一企业微信系统认证配置，以及飞书和钉钉的企业应用；所有 App Secret 经 AES-256-GCM 加密后落 PostgreSQL；
- 普通员工通过账号绑定页面发起受支持平台的个人 OAuth，并可从企微工作台或页面建立/解除当前平台账号与企微身份映射；OpenConnector 保存个人 Token，PostgreSQL 保存 OIDC 主体到命名连接或企微身份摘要的映射，当前上游只有飞书支持用户 OAuth；
- 通过单独修订文件触发网关进程重载，Key 以文件替换方式注入生成过程，不写入路由 YAML 或浏览器响应；
- 通过系统设置的 LightRAG 二级页面选择网关已发布模型并管理切片、摘要和并发参数；保存后由内部配置控制面完成原子更新、健康等待与失败回滚；
- 企业微信认证的 CorpID、App Secret 和公网中继回调在集成管理的独立二级页维护；每次绑定由 Console 服务端读取并封装为短期加密请求，Relay 不持久化凭据，共享协议密钥不进入浏览器配置；
- 服务端聚合全局能力网关、Agent Runtime、Envoy AI Gateway、OpenConnector、LightRAG、RAG MCP、Jaeger 与 Promptfoo 的真实运行摘要；
- `/observability` 以管理员权限读取固定 PromQL 和 Jaeger v3 Query，提供模型/MCP 分区、最多 24 小时/100 Trace 的有界诊断样本及字段白名单 Trace 时间线；Pomerium 保护的 Jaeger 承担完整 waterfall，不在 Console 复制任意 tag/event 查询；
- JSON 配置读取、字段白名单校验和原子写入；
- HTTP/TCP 服务健康探测；
- “同步知识”调用 LightRAG 扫描接口并触发真实索引；评测仍由按需 profile 执行；
- 未接入或无结果的能力显示“未配置”或真实空状态，不以演示数据补齐。

聚合层使用短超时和 10 秒内存缓存，避免单个组件拖慢整个控制台。OpenConnector Runtime/Admin Token、大模型渠道 Key、MCP 上游 Key、LightRAG API Key 与企业应用 Secret 仅存在于服务端环境；集成管理 API 只返回应用 ID、平台、App ID 和时间戳。企业微信中继回调 URL 是管理员可见的非敏感设置，普通员工无页面或 API 权限。Console 通过 LightRAG API 读取文档状态、大小与切片数，不读取知识正文；可观测 API 只返回显式 DTO 白名单，不透传 Jaeger 任意 tag、event、异常正文、Prompt、输出或工具参数/结果。`GET /api/overview` 是页面统一读取面，`refresh=1` 只用于主动刷新和排障。

Portal 负责发现、导航和常用配置治理，专业组件负责 Action 调试、运行策略等深度操作。外部工作台使用明确的新窗口链接，不通过 iframe 嵌入，以保留认证、路由和升级边界。

默认 Compose 启动 AI Console、Caddy 全局网关、Go MCP Access Gateway、Agent Runtime、Envoy AI Gateway standalone、OpenConnector、LightRAG、独立 RAG MCP、PostgreSQL/pgvector/AGE、Jaeger、Prometheus 和 Pomerium；Promptfoo 位于 `quality` profile。认证中心不属于 AI Base Stack，Pomerium 与 MCP Access Gateway 通过 Dex 确认平台身份；企业微信身份由独立公网中继验证并关联到已登录的平台账号，不作为 Dex 登录方式。只有全局网关映射 loopback 宿主机端口。

## 可观测数据边界

模型调用的规范 KPI 只来自 Envoy AI Gateway capability probe 已证明的 GenAI metrics；MCP KPI 只来自过滤后的 `mcp.server.message`/内部 Envoy 协议 SpanMetrics，公网 MCP 下游 Envoy/HTTP span 不重复计数。当前模型错误率和 TTFT 没有通过固定版本 probe，因此 Console 明确显示不可用。Prometheus label 只允许低基数维度，Trace/Span ID、员工摘要、OAuth client、连接与资源摘要不得成为 label。

公网 `/v1` 与 `/mcp` 清除全部已识别传播和采样载体，平台再建立 root；Compose 内的 Agent Runtime 直连 Envoy 并传播可信 W3C context。首期 100% head sampling，但 exporter、网络和存储仍可能丢 Trace。Jaeger 使用 14 天 Badger TTL，Prometheus 使用 15 天保留；需要零丢失、长期逐调用账单或审计时必须单独设计 PostgreSQL 账本。

采集源关闭模型输入/输出、Embedding 和 invocation parameters，PydanticAI 额外用安全 tracer facade 删除当前版本仍会生成的 request parameters/tool definitions；固定版本的 OpenTelemetry Collector 在 Jaeger 前删除全部 Span Event、状态文本、正文、凭据、完整 URL、异常正文和敏感前缀，Jaeger 在存储和 SpanMetrics 前重复事件与属性过滤。字段与 PromQL 的唯一事实源是 `docs/observability-schema.md`，镜像或 SDK 升级必须重跑 probe/sentinel/基数门禁。

下一阶段可补充 LightRAG 的企业 ACL、Promptfoo 结果导出、发布审批与审计表；不在当前浏览器控制台中添加容器管理权限。

## 演进触发条件

- pgvector 出现明确的召回或吞吐瓶颈后，再评估 Qdrant。
- 单机容量、容灾或多团队隔离成为实际问题后，再评估 k3s/Kubernetes。
- Agent 需要复杂图状态时，再评估 LangGraph；默认维持 PydanticAI 的线性、可测试运行模型。
- 对象级 ABAC/RBAC 超出 Pomerium 路由策略后，再引入专门 PDP。

## 上游资料

- [Open Connector](https://github.com/oomol-lab/open-connector)
- [LightRAG](https://github.com/HKUDS/LightRAG)
- [Apache AGE](https://github.com/apache/age)
- [PydanticAI](https://github.com/pydantic/pydantic-ai)
- [Envoy AI Gateway](https://github.com/envoyproxy/ai-gateway)
- [Caddy](https://github.com/caddyserver/caddy)
- [Model Context Protocol Go SDK](https://github.com/modelcontextprotocol/go-sdk)
- [pgvector](https://github.com/pgvector/pgvector)
- [OpenTelemetry Python](https://github.com/open-telemetry/opentelemetry-python)
- [Jaeger](https://github.com/jaegertracing/jaeger)
- [Promptfoo](https://github.com/promptfoo/promptfoo)
