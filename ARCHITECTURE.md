# AI Base 基础架构

- Status: Active
- Last refreshed: 2026-08-19
- Scope: 项目结构、运行组件、入口路由、信任边界、数据所有权和变更落点

本文档是 AI Base 结构与架构的统一事实源。运行命令、环境变量和操作流程见 [`README.md`](./README.md)，Console 体验见 [`DESIGN.md`](./DESIGN.md)，可观测字段见 [`docs/observability-schema.md`](./docs/observability-schema.md)。`.omx/plans` 仅表示提案。

## 目标与不变量

AI Base 为中小企业提供单机 Docker Compose 可运行、组件可替换的 Agent 基础设施。外部模型负责推理，企业内部保留身份、策略、工具、知识、评测和审计控制。

- Caddy 是唯一宿主机入口，不承载协议或业务逻辑。
- Pomerium 保护普通浏览器和首次平台登录；已绑定企微工作台用户可经受限 Relay 引导入口恢复 Console 会话。MCP Access Gateway 保护公共 MCP；Envoy 负责内部模型/MCP 注册与路由。
- 外部 OIDC/Dex 是身份源，稳定员工身份使用已验证的 `issuer + subject`。
- 客户端身份头、Session、连接名、群组、Action 和资源 ID 均不可信；授权在服务端重新解析，异常时关闭失败。
- 外部 SaaS 凭据由 Open Connector 持有；AI Base 只保存身份映射和治理策略。
- Secret、Token、敏感正文和完整工具参数不得进入浏览器响应、Prompt、Trace 或普通日志。
- LightRAG 复用 PostgreSQL + pgvector + AGE；不增加独立向量库或图数据库。
- 没有容量或隔离证据前，不引入 Kubernetes、Kafka、Redis、ClickHouse 等重型基础设施。

## 总体拓扑

```text
浏览器 ── Caddy :8443 ── Pomerium ── AI Console / 管理工作台
                                      │ 配置与治理
                                      ▼
MCP 客户端 ── Caddy :8080 ── MCP Access Gateway ── Envoy MCP
模型客户端 ── Caddy :8080 /v1 ──────────────────── Envoy Model
Agent 客户端 ── Caddy :8080 /runtime ── Agent Runtime
                                                    │
                       ┌────────────────────────────┼──────────────┐
                       ▼                            ▼              ▼
                 外部大模型                 Open Connector     RAG MCP
                                                 │                │
                                                 ▼                ▼
                                              外部 SaaS        LightRAG
                                                                  │
                                                                  ▼
                                                     PostgreSQL + pgvector + AGE

Agent Runtime / MCP Gateway / Envoy ── OTel Collector ── Jaeger / Prometheus

企微工作台 ── Caddy /auth/wework ── Console ── 公网 ai-auth-relay ── 企业微信 API
                                      ▲              │
                                      └── 加密一次性身份结果 ──┘
                                      │
                         已绑定 ── 短期 Console 会话
                         未绑定 ── Pomerium/Dex ── 首次关联
```

## 组件与项目结构

| 组件/路径 | 职责 | 边界或持久状态 |
| --- | --- | --- |
| `compose.yaml` | 单机拓扑、网络、卷、健康检查和依赖 | 只有 `global-gateway` 映射 loopback 宿主机端口 |
| `deploy/global-gateway/` / `global-gateway` | Caddy 路由、请求头边界、企微引导入口分流 | 无业务状态；只按路径/Cookie 是否存在分流，不验证身份或解析 MCP JSON-RPC |
| `deploy/pomerium/` / `pomerium` | 浏览器 SSO 和路由策略 | 会话写入 PostgreSQL Data Broker；不是 IdP |
| `ai-console/` / `ai-console` | 管理 UI、服务端配置、身份映射、策略和 Envoy 配置生成 | PostgreSQL 与 `console-data`；Secret 不进入浏览器 |
| `mcp-access-gateway/` | MCP OAuth/OIDC、Session、JSON-RPC 边界、公共工具名和员工授权 | Token 哈希写入 `mcp-auth-data`；员工 Token 不透传 Envoy |
| `deploy/llm-gateway/` / `llm-gateway` | Envoy 模型路由、协议转换、内部 MCP 注册和聚合 | 配置由 Console 生成；监听器只在 Compose 网络开放 |
| `agent-runtime/` | PydanticAI Agent 编排、结构化输出和业务策略 | PostgreSQL；不保存 SaaS 凭据 |
| `vendor/open-connector/` / `open-connector` | Provider、OAuth、具名连接、凭据和 Action 执行 | `open-connector-data`；固定上游边界，默认不修改 |
| `open-connector-admin-proxy` | 为 Pomerium 后的管理工作台注入内部 Admin Token | 无业务状态 |
| `rag-mcp/` | 将 LightRAG 只读能力适配为 Streamable HTTP MCP | 独立容器；不修改 LightRAG 镜像 |
| `deploy/lightrag/` / `lightrag` | 文档、检索、图谱和引用查询 | PostgreSQL、LightRAG 数据卷和配置卷 |
| `deploy/postgres/` / `postgres` | 控制面、身份映射、策略、关系、向量和图数据 | migration 必须兼容空库、已有库和重复执行 |
| `egress-dns` | Envoy/Open Connector 公网 DoH 与企业内网 DNS 分流 | 仅 Compose 网络；SSRF 私网保护保持开启 |
| `deploy/otel-collector/`、`deploy/jaeger/`、`deploy/prometheus/` | Trace 净化、存储、SpanMetrics 和规则 | 遥测失败不影响业务；Trace/Metrics 不替代审计 |
| `promptfoo` | 回归、安全和发布评测 | 仅 `quality` profile 按需运行 |
| `../ai-auth-relay/` | 固定公网出口上的企业微信网页授权中继 | 仓库外独立部署；不持久化 CorpID、Secret、Token 或 UserID |
| `deploy/silverbullet/space/` | Agent、外部连接和知识治理规范 | 规范文档，不是运行服务 |
| `docs/`、`scripts/`、`.omx/plans/` | Schema、验证脚本和提案 | plans 不能作为已实现事实 |

启动期的 `pomerium-database-init`、`lightrag-input-init` 和 `jaeger-storage-init` 只执行幂等初始化，不是长期业务入口。

## 公共入口

| 入口 | 上游 | 说明 |
| --- | --- | --- |
| `GET /health` | Caddy | 全局入口存活 |
| `GET /ready` | Envoy 管理端 | 模型/MCP 网关就绪 |
| `/v1/*` | Envoy 模型监听器 | 模型别名、Provider 和协议转换由 Envoy 管理 |
| `/mcp/*`、`/oauth/*`、相关 `/.well-known/*` | MCP Access Gateway | MCP OAuth、Session、工具表示和员工授权 |
| `/rag/*` | LightRAG | Caddy 注入容器内 API Key |
| `/runtime/*`、`runtime.localhost:8080` | Agent Runtime | 去除能力前缀后转发 |
| `/connector/*` | Open Connector Runtime | 管理工作台另走 Pomerium |
| `/knowledge/*`、`knowledge.localhost:8080` | LightRAG | 知识 API 与 Web UI |
| `/llm-admin/*` | Envoy 管理端 | Console 使用的内部配置控制路径 |
| `/promptfoo/*`、`promptfoo.localhost:8080` | Promptfoo | 仅 quality profile 可用 |
| `ai-console.localhost.pomerium.io:8443` | Pomerium / AI Console | 默认走 Pomerium；`/auth/wework` 引导路径和带企微 Console 会话的请求由 Console 自行验证 |
| `authenticate`、`jaeger`、`open-connector`.localhost.pomerium.io:8443 | Pomerium | 平台认证及管理员工作台入口 |
| `/WW_verify_*.txt` | Caddy 静态目录 | 企业微信域名验证，不转发到 Relay 或 Console |

Prometheus、OTLP、PostgreSQL 及各服务原生管理端口只在 Compose 网络内可达。Jaeger 只经管理员 Pomerium 策略开放。

## 关键信任链路

### 公共 MCP

链路为：MCP Client → Caddy → MCP Access Gateway → Envoy → MCP 上游。

- Gateway 提供发现、动态客户端注册、Authorization Code + S256 PKCE、Token 和 JWKS，并通过独立 OIDC Client 委托员工登录。
- 每次请求验证 Access Token 的 issuer、audience、有效期和 scope；Refresh Token 仅以哈希持久化并支持撤销和滑动续期。
- 外部 MCP Session 由 Gateway 签名并绑定 `issuer + subject + client_id`，不能跨员工复用；内部 Envoy Session 不直接暴露。
- Envoy 内部工具名保持 `mcp-open-connector__*` 和 `mcp-rag__*`。Gateway 仅在 `tools/list`/`tools/call` 边界映射为 `connector__*` 和 `kb__*`，不改写参数、结果、其他上游或 Envoy 配置。
- Gateway 的 `connector__apps` 与 `connector__connections` 均从当前 `issuer + subject` 实时生成，只展示该员工的个人、受控共享和免认证连接；Action 查询必须先以这里返回的 service 限定范围。执行时再次解析员工连接并覆盖客户端连接名；无授权、歧义或解析服务失败时拒绝。
- 员工 Access Token、Cookie 和浏览器身份头在进入 Envoy 前移除；公网 TraceContext 被清除后建立新的平台 Trace。

### Connector 与共享连接

- Agent Runtime 以 HTTP `/v1/actions/*` 作为内部编排主路径；MCP 用于通用客户端兼容。
- Open Connector 加密保存凭据和个人 OAuth Token；PostgreSQL 只保存 `issuer + subject` 到具名连接的映射以及共享授权策略。
- `no_auth`、`account_bound`、`controlled_shared` 和 `global` 分别处理。需要凭据的 Provider 不得使用共享 `default`。
- `controlled_shared` 必须同时通过员工/群组、连接、Action 和资源约束；动态入口 `wecom_bot.call_tool` 固定拒绝。
- 企微机器人归属一个明确的企微认证组织，并通过该组织的可信 CorpID/UserID 摘要和 `get_userlist` 校验可见性；不同组织中的同名 UserID 不共享授权。查询失败、身份域不匹配、组织停用或缓存过期时不可见。只有管理员显式加入白名单的静态 Action 才可调用。
- 已完成企微身份绑定的员工也可在账号页发起官方机器人扫码：Console 创建五分钟会话并轮询企业微信结果，取得 Bot ID/Secret 后先以二维码来源完成企业微信 `get_cli_config` 鉴权引导，再仅在服务端写入 Open Connector；随后以有限重试的 `get_userlist` 等待权限传播，按已认证 UserID 精确定位当前成员并确认其位于机器人可使用成员中。个人连接默认显示为“绑定成员姓名绑定的企微机器人 · 连接短标识”，员工可修改显示名；稳定 `connection_name` 和凭据不随改名变化。员工也可逐连接解绑；服务端必须校验当前稳定主体是该个人连接所有者。PostgreSQL 只保存员工主体、具名连接、显示名、Bot ID 指纹和服务端发现出的只读 Action 白名单，扫码完成或过期即清除临时会话码。
- 管理员维护的企微机器人仍是 `controlled_shared`，员工扫码创建的机器人是 `account_bound`，两者不互相降级。同一员工可拥有多个个人机器人；调用未指定连接且存在多个候选时，Gateway 返回 `connector_selection_required`，指定连接后仍逐 Action 校验。
- 管理 UI 经 Pomerium 后由内部代理注入 Admin Token；Runtime/Admin Token 不进入 Prompt、Trace 或浏览器响应。

### 企业微信身份绑定与自动恢复

企业微信不是平台账号源，也不能创建或任意选择平台账号。管理员在 `/integrations/wecom-authentication` 按组织维护 CorpID、App Secret 和 Relay 地址；每个组织生成带稳定 `organization` ID 的独立应用首页。Secret 使用 AES-256-GCM 存入 PostgreSQL，浏览器、Pomerium、Dex 和 MCP Broker 均不接触明文。

链路为：指定组织的企微工作台应用首页 → Console 将组织 ID 固化到一次性事务 → Relay 完成企微网页授权与 `gettoken/getuserinfo` → Console 先从认证票据读取事务令牌，再按事务回查组织凭据并验证 CorpID。已有绑定时，Console 签发 12 小时 HttpOnly 会话并按绑定的 `issuer + subject` 恢复用户；没有绑定时，才进入 Pomerium/Dex 确认平台账号并完成首次关联。

- Console 与 Relay 只交换短期 AEAD 票据和随机授权 ID；企业微信只回调 Relay 的固定 `/callbacks/wecom`。
- Relay 使用固定公网出口，不接受浏览器指定回调，不持久化 CorpID、Secret、Access Token 或 UserID。
- Console 只保存平台 `issuer + subject`、认证组织 ID、派生企微 Subject 及 CorpID/UserID 哈希；一个平台账号可在多个组织各绑定一个企微身份，同一具体企微身份仍只能归属一个平台账号。
- 企微 Console 会话使用从服务端配置密钥域分离派生的 HMAC 密钥签名，并记录触发会话的具体绑定 ID；Caddy 只按 Cookie 是否存在分流，Console 每次请求都验证签名、固定有效期，并重新查询该绑定。解除其他组织绑定不影响当前会话，解除当前绑定后立即失效。
- `/auth/wework/link` 固定经过 Pomerium，已有企微会话也不能绕过首次平台账号确认。过期、篡改、重放、企业不匹配、身份冲突、中继不可用或企微 API 失败均关闭失败。

### 知识与可观测

- LightRAG 的 KV、文档状态、向量和图统一写入 PostgreSQL/pgvector/AGE，并以 `WORKSPACE=ai_base` 隔离。Embedding 维度变化必须迁移或重建索引。
- RAG MCP 只读调用 LightRAG；Console 只读取文档状态和统计，不读取知识正文。
- Agent Runtime、MCP Gateway 和 Envoy 发送 OTLP；Collector 先移除正文、凭据、异常内容和高基数字段，再写入 Jaeger/Prometheus。
- Jaeger/Prometheus 只提供有界诊断证据。需要长期逐调用账单、零丢失或合规审计时，应单独设计 PostgreSQL 账本。

## 身份、凭据与数据所有权

| 对象 | 权威所有者 | 约束 |
| --- | --- | --- |
| 平台员工身份 | 外部 OIDC/Dex | 授权键为 `issuer + subject`；邮箱只展示或用于无歧义迁移 |
| 普通浏览器会话 | Pomerium + PostgreSQL Data Broker | 只用于浏览器入口，不替代 MCP OAuth |
| 已绑定企微 Console 会话 | AI Console + PostgreSQL 身份映射 | 12 小时签名 Cookie；每次请求重查绑定；只适用于 Console 域名 |
| MCP Token/Session | MCP Access Gateway | Refresh Token 只存哈希；外部 Session 绑定员工和客户端 |
| 模型 Provider Key | AI Console 服务端配置 | 以文件进入 Envoy 生成流程，不写入路由 YAML 或浏览器响应 |
| SaaS 凭据、个人 OAuth Token 和企微个人机器人凭据 | Open Connector | 使用其静态加密键保存；企微 Bot Secret 不写入 Console 数据库或浏览器响应 |
| 员工连接和共享授权 | AI Console + PostgreSQL | Gateway 每次调用重新解析，异常关闭失败 |
| 企业微信认证 Secret | AI Console + PostgreSQL | 按组织配置，AES-256-GCM 加密；Relay 仅在对应一次性事务中短期使用 |
| 企业微信员工映射 | AI Console + PostgreSQL | 平台主体到多个组织身份的一对多映射；只保存组织 ID、派生 Subject 和 CorpID/UserID 哈希 |
| 知识数据 | LightRAG + PostgreSQL/pgvector/AGE | RAG MCP 只读，Console 不读取正文 |
| Trace 和指标 | OTel Collector → Jaeger/Prometheus | 先净化，只作诊断，不作审计账本 |

## 变更落点

| 变更 | 首选位置 |
| --- | --- |
| 公共路径、域名、静态验证文件或转发 | `deploy/global-gateway/Caddyfile` |
| MCP OAuth、Session、公共工具名、连接选择或 Action 授权 | `mcp-access-gateway/` |
| 模型 Provider、模型别名、内部 MCP 注册与路由 | `ai-console/` 的 Envoy 配置生成逻辑、`deploy/llm-gateway/` |
| Connector Provider、认证字段或 Action Schema | Open Connector 上游 Schema；默认不修改 `vendor/open-connector` |
| 个人绑定、共享授权和 Action 白名单 | `ai-console/`、PostgreSQL migration、`mcp-access-gateway/` |
| Agent 编排和写操作业务策略 | `agent-runtime/` |
| 知识 MCP 工具 | `rag-mcp/` |
| LightRAG 摄取、检索、图谱或运行参数 | `deploy/lightrag/`、LightRAG、Console 配置控制面 |
| 浏览器登录和路由策略 | `deploy/pomerium/`、`deploy/global-gateway/Caddyfile`、`ai-console/`、外部 OIDC/Dex |
| 企业微信身份绑定 | `ai-console/`、`../ai-auth-relay/` |
| 数据表 | `deploy/postgres/init/` 和对应服务 migration |
| Trace、指标和脱敏 | 产生遥测的服务、`deploy/otel-collector/`、Jaeger、Prometheus |

## 演进条件

- pgvector 出现明确召回或吞吐瓶颈后，再评估独立向量库。
- 单机容量、容灾或团队隔离成为实际问题后，再评估 k3s/Kubernetes。
- Agent 需要复杂图状态后，再评估 LangGraph。
- 对象级 ABAC/RBAC 超出当前服务端策略后，再引入专门 PDP。
