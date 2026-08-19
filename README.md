# AI Base

面向中小企业的轻量 Agent 基础设施工作区，使用 Docker Compose 部署控制台、Agent Runtime、工具连接、知识库、数据、评测与可观测组件。

## Docker 一键启动

```bash
git submodule update --init --recursive
docker compose up -d --build
docker compose ps
```

OpenConnector 从 `vendor/open-connector` 中固定的上游正式版 `v1.3.5`（`5719a69468c698c7cb8108e062ff64ecef8a2e65`）构建本地镜像。该版本已实装命名连接和多连接管理；AI Base 只在 `mcp-access-gateway` 将上游 MCP 工具适配为 `connector__apps`、`connector__connections`、`connector__search`、`connector__guide` 和 `connector__execute`，不再维护 OpenConnector 本地补丁。首次拉取和构建需要几分钟。只有 `global-gateway` 映射宿主机端口，其他组件仅在 Compose 网络内开放：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| AI Console | https://ai-console.localhost.pomerium.io:8443 | 经 Pomerium 与外部 OIDC 认证的一站式 Portal |
| 企业微信身份绑定 | https://ai-console.localhost.pomerium.io:8443/auth/wework | 先确认当前平台账号，再通过公网认证中继建立身份映射并返回账号管理 |
| LightRAG | http://knowledge.localhost:8080/webui | 文档、混合检索与知识图谱工作台 |
| OpenConnector | https://open-connector.localhost.pomerium.io:8443 | 经 Pomerium 单点登录的外部连接管理入口 |
| 本地 OIDC | http://dex.localtest.me:5556/dex | 独立部署的 Dex 认证中心，不属于 AI Base Stack |
| 全局网关 | http://localhost:8080 | 模型、MCP、RAG、Runtime、Connector、知识库与可观测统一入口 |
| MCP Access Gateway | http://127.0.0.1:8080/mcp | Go 实现的 OAuth 保护 MCP 接口 |
| Envoy AI Gateway | 仅容器内访问 | 模型路由，以及内部 `/mcp` 上的外部 MCP 注册、聚合与工具路由 |
| RAG MCP | 仅容器内访问 | 将 LightRAG 只读查询封装为内置 MCP 工具，不修改 LightRAG |
| Agent Runtime | http://runtime.localhost:8080/docs | FastAPI、PydanticAI、MCP 与 DBOS 运行边界 |
| Jaeger | https://jaeger.localhost.pomerium.io:8443 | 经 Pomerium 管理员保护的 OpenTelemetry Trace 工作台 |
| PostgreSQL | 仅容器内访问 | 控制面、审计、pgvector 与 Apache AGE |

查看日志或停止服务：

```bash
docker compose logs -f
docker compose down
```

`docker compose down` 会保留命名卷。只有明确希望删除本地数据时才使用 `docker compose down -v`。

AI Console 的 `/components` 是统一组件门户，提供组件状态、运行端点和管理入口。常用的 OpenConnector 连接生命周期直接在 Console 管理；Action 调试、运行令牌和策略等深度操作仍在 OpenConnector 自身界面完成。

### 独立 OIDC 单点登录

AI Base Stack 不内置认证中心。本机开发使用相邻目录中的轻量 Dex，单独启动：

```bash
docker compose -f ../local-oidc/compose.yaml up -d
```

Pomerium 使用 Dex 保护 Console 与 OpenConnector 管理页面：

```dotenv
POMERIUM_IDP_PROVIDER_URL=http://dex.localtest.me:5556/dex
POMERIUM_IDP_CLIENT_ID=ai-base-pomerium
POMERIUM_IDP_CLIENT_SECRET=replace-with-the-real-client-secret
```

Dex 中的 `ai-base-pomerium` 客户端登记 `https://authenticate.localhost.pomerium.io:8443/oauth2/callback`。Pomerium 只负责确认当前内网平台账号；企业微信不会作为 Dex 登录方式，也没有第二套 Pomerium。当前 Pomerium 策略只允许 `bluetron.cn` 邮箱域，Jaeger 进一步只允许默认管理员 `admin@bluetron.cn`；更换企业域名或 `AI_CONSOLE_ADMIN_EMAILS` 时必须同步修改 [`deploy/pomerium/config.example.yaml`](./deploy/pomerium/config.example.yaml)。Pomerium 本机入口使用开发证书和仓库内的本地签名键；正式部署必须替换签名键，并配置受信任证书、正式域名和企业 OIDC。AI Console 验证 Pomerium 签名、有效期和精确 audience，不信任客户端可伪造的身份头。

普通入口请求 Dex 的 `offline_access`，浏览器会话采用 90 天固定上限，并通过 PostgreSQL Data Broker 写入 `ai_base_pomerium`。Pomerium 在会话期内使用 Dex 刷新令牌续签上游身份；只有浏览器继续保留 Pomerium Cookie 时才能跨重开复用。超过 90 天、清除 Cookie、删除 PostgreSQL 或 Dex 数据卷、轮换 Pomerium Cookie/Shared Secret、刷新令牌失效、主动退出或策略撤权都会终止会话。企微内置浏览器不依赖该 Cookie 长期持久化，而使用下述绑定恢复链路。

### 企业微信身份中继

管理员先在“集成管理 / 企业微信认证”新增组织，再把页面为该组织生成的 `https://ai-console.localhost.pomerium.io:8443/auth/wework?organization=<组织 ID>` 配置为对应企业微信应用首页。该受限入口先由固定公网出口的 `ai-auth-relay` 完成网页授权和身份交换：已有绑定时自动恢复平台用户，尚未绑定时才进入 Pomerium/Dex。企业微信只与中继交换身份，不直接回调内网 AI Base。

管理员在 Console 的“集成管理 / 企业微信认证”中按组织维护系统认证配置：

- “企业 ID（CorpID）”填写企业微信管理后台的企业 ID；
- “App Secret”填写该自建应用的 Secret；
- 自建应用的可见范围应包含允许登录 AI Base 的员工；
- “公网认证中继回调地址”填写 Relay 的固定 `/callbacks/wecom` 地址，例如 `http://tn1.cofly-ai.cn/callbacks/wecom`；
- 在企业微信后台把可信域名和网页授权回调配置为该中继，并把中继主机的固定公网出口加入应用可信 IP；
- 域名验证文件只部署到 Relay；AI Base 全局网关不再提供企微回调或域名验证路径。

AI Base 在每次工作台登录开始时把组织 ID 固化到 30 分钟的平台关联事务，并把最长 10 分钟的加密授权票据暂存到 Relay。完成页先从认证票据取得事务令牌，再按事务回查组织配置并验证 CorpID、HttpOnly nonce 和有效期。若该组织的 CorpID/UserID 摘要已有映射，Console 签发绑定到具体映射记录的最长 12 小时安全 Cookie；若无映射，`/auth/wework/link` 强制经过 Pomerium 确认平台身份。一个平台账号可在多个组织各绑定一个企微身份，同一具体企微身份不能绑定多个平台账号。

两端共享密钥属于启动信任根，不能放进登录后的管理页面：

```dotenv
AI_CONSOLE_PUBLIC_URL=https://ai.example.com
WECOM_RELAY_SHARED_KEY=replace-with-base64url-32-byte-secret-shared-with-relay
```

Relay 使用同一个值配置 `AI_BASE_WECOM_RELAY_SHARED_KEY`，并把公共回调配置为 `AI_BASE_WECOM_PUBLIC_CALLBACK_URL`。当前部署按用户要求支持 HTTP 中继；加密票据保护应用凭据和身份结果，但 HTTP 不提供完整的传输层防窃听与抗劫持能力。启用 HTTPS 时同步修改 Relay 与 Console 中的回调地址即可。

OpenConnector 的管理请求由独立内部代理注入 Admin Token，Token 不进入浏览器。OpenConnector 不再映射宿主机端口；管理入口经 Pomerium，Agent 功能流量经全局网关 `/connector`，分别使用 Admin Token 与 Runtime Token。

MCP Access Gateway 内置轻量 OAuth Broker，面向兼容 MCP OAuth 的客户端提供标准发现、动态客户端注册、Authorization Code + S256 PKCE 和令牌端点；Dex 只作为员工登录上游，不要求 Dex 支持动态客户端注册。WorkBuddy 是常用客户端示例，但不是唯一入口：

```dotenv
MCP_PUBLIC_RESOURCE_URL=http://127.0.0.1:8080/mcp
MCP_OIDC_ISSUER=http://127.0.0.1:8080/oauth
MCP_OIDC_AUDIENCE=http://127.0.0.1:8080/mcp
MCP_OIDC_REQUIRED_SCOPES=ai-base:mcp
MCP_LOGIN_OIDC_ISSUER=http://dex.localtest.me:5556/dex
MCP_LOGIN_OIDC_CLIENT_ID=ai-base-mcp-broker
MCP_LOGIN_OIDC_REDIRECT_URL=http://127.0.0.1:8080/oauth/callback
MCP_OAUTH_ALLOWED_REDIRECT_URIS=workbuddy://workbuddy/mcp/custom-mcp%3Aai-base/oauth/callback
MCP_OAUTH_ACCESS_TOKEN_LIFETIME=1h
MCP_OAUTH_REFRESH_TOKEN_LIFETIME=2160h
MCP_SESSION_SIGNING_KEY=replace-with-at-least-32-random-bytes
MCP_SESSION_LIFETIME=2160h
MCP_ADMIN_TOKEN=replace-with-a-random-admin-token
```

以 WorkBuddy 为例，只需配置 MCP URL：

```json
{
  "mcpServers": {
    "ai-base": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

客户端点击“连接”后，从 `/.well-known/oauth-protected-resource/mcp` 发现 AI Base OAuth Broker，完成客户端注册后跳转 Dex 登录。Broker 使用 Dex 的稳定用户 ID 派生内部员工 ID，签发 audience 为 MCP Resource、包含 `ai-base:mcp` scope 的 1 小时短期 JWT；员工令牌进入 Envoy 前会被移除。刷新令牌默认 90 天滑动有效，并只以 SHA-256 哈希形式原子保存到 `mcp-auth-data` Volume。同一刷新令牌可由客户端的多个本地进程重复使用，避免凭证文件同步延迟导致旧令牌立即失效；每次成功刷新都会把有效期顺延 90 天。员工电脑关机、休眠或网关正常重启都不会丢失刷新状态，只要 90 天内至少使用一次，就可以持续刷新而无需重新登录。MCP Session 同样默认 90 天且绑定员工与客户端身份。

从旧的内存刷新令牌版本升级时，已有客户端需要重新连接一次；新令牌写入持久化存储后，后续网关重启不再要求重新登录。不要通过延长 Access Token 来实现长期登录，长期能力由可复用、可撤销并滑动续期的 Refresh Token 提供。

需要个人 OAuth 的 Connector 仍由员工在 AI Console 的 [账号绑定页面](https://ai-console.localhost.pomerium.io:8443/account) 完成授权。管理员维护的企业微信 API 模式机器人不做逐机器人绑定：员工完成一次“当前平台账号 ↔ 企业微信身份”关联后，MCP 解析器通过每个共享机器人的 `wecom_bot.get_userlist` 自动筛选可见连接。已关联企微身份的员工还可在企微卡片抽屉扫码创建自己的机器人；这类机器人直接成为 `account_bound` 个人连接，不改变管理员共享机器人的 `controlled_shared` 语义。

个人机器人扫码使用企业微信官方五分钟会话。Console 服务端轮询结果，使用回调机器人名称作为个人连接显示名，先以二维码来源完成 `get_cli_config` 鉴权引导，再把 Bot ID/Secret 直接写入 OpenConnector，并通过有限重试的 `get_userlist` 等待权限传播、确认当前已绑定 UserID 位于机器人可使用成员中；浏览器不接收 Bot ID/Secret，PostgreSQL 只保存员工主体、具名连接、机器人显示名、Bot ID 指纹和实际发现出的只读 Action 白名单。写入、删除、旧 Webhook 发送和动态 `call_tool` 不会自动开放。同一员工可创建多个个人机器人，MCP 调用存在多个候选时必须先通过连接清单取得并明确传入 `connectionName`。个人机器人可在企微权限抽屉逐连接解绑，操作会删除 OpenConnector 中的凭据连接并撤销当前员工绑定；共享机器人不提供此入口。

用于身份映射的原始 UserID 不进入 Broker Token、解析器请求、浏览器响应或普通日志；管理员显式授权 `wecom_bot.get_userlist` 时，企微返回的可见成员 UserID、姓名和别名会作为该次 MCP 工具结果交给调用方，但仍不进入普通日志。查询失败、身份域不匹配或员工不在可见范围时关闭失败。

从旧版本升级后，员工可以打开一次企微工作台应用主页建立平台映射，已有 MCP 客户端便不必为了每个机器人重复绑定。尚未建立映射时，重新通过企微完成 MCP 登录仍可让新 Token 自带可信 UserID 摘要；旧 Refresh Token 不会被补写该身份声明。

MCP Access Gateway 会按 Broker JWT 的 `issuer + subject` 查询个人映射和受控共享策略。`connector__apps` 与 `connector__connections` 都只返回当前员工可用的个人、受控共享和免认证连接，客户端应先从这两个入口确定 service 和具名连接，再查询或执行 Action。执行时 Gateway 覆盖客户端提交的 `connectionName`；需要凭据的 Connector 在没有个人绑定或共享授权、连接已失效、可见范围查询失败或映射服务不可用时不会回退到共享 `default`，上游明确声明为 `no_auth` 的虚拟公共 Connector 才可以按系统 `default` 连接使用。

`http://127.0.0.1:8080` 只用于本机验证。共享环境必须改用同一个正式 HTTPS 主机，并同步更新 MCP Resource、OAuth Issuer、Dex 回调地址和允许的客户端回调白名单。

### 全局工具入口

宿主机只开放全局网关的 `127.0.0.1:8080` 和 `127.0.0.1:8443`。功能 API 使用路径路由，带独立前端资源的工作台使用 `*.localhost:8080` 域名路由，SSO 管理入口在 8443 上转发到 Pomerium：

| 路径 | 上游能力 | 路径处理 |
| --- | --- | --- |
| `/v1`、`/v1/*` | Envoy AI Gateway 模型 API | 保留路径，支持流式响应 |
| `/mcp`、`/mcp/*` | MCP Access Gateway | OIDC 验证后转发到内部 Envoy MCP；Access Gateway 在外部协议边界将内置工具命名空间缩短为 `kb` 和 `connector` |
| `/.well-known/oauth-protected-resource/mcp` | MCP Access Gateway | OAuth Protected Resource Metadata |
| `/oauth/*`、OAuth well-known 路径 | MCP Access Gateway | MCP 客户端 OAuth、DCR、PKCE、Token 与 JWKS |
| `/rag/*` | LightRAG API | 移除 `/rag` 前缀；提供文档、检索和知识图谱 API |
| `/runtime/*` | Agent Runtime API | 移除 `/runtime` 前缀 |
| `/llm-admin/*` | Envoy AI Gateway 管理 API | 移除 `/llm-admin` 前缀，仅供控制台内部使用 |
| `/connector/*` | Open Connector 功能 API | 移除 `/connector` 前缀 |
| `/knowledge/*` | LightRAG | 移除 `/knowledge` 前缀；浏览器使用 `knowledge.localhost:8080/webui` |
| `/promptfoo/*` | Promptfoo | 移除 `/promptfoo` 前缀；仅在 `quality` profile 启动后可用 |

LightRAG 通过 Envoy AI Gateway 使用 `qwen` 完成实体关系抽取与查询，通过 `BAAI/bge-m3` 生成 1024 维向量。KV、文档状态、向量和知识图谱统一复用 PostgreSQL；pgvector 承载向量索引，Apache AGE 承载图数据。

管理员可在 [系统设置 / LightRAG 配置](https://ai-console.localhost.pomerium.io:8443/settings/lightrag) 中调整运行模型、Embedding、切片和并发参数。LLM 与 Embedding 下拉项只读取大模型网关中启用渠道发布的模型；保存时 AI Console 会验证模型仍可用、探测 Embedding 维度、持久化配置并重新加载 LightRAG。加载失败时自动恢复上一份配置。`.env` 中的 `LIGHTRAG_LLM_MODEL`、`LIGHTRAG_EMBEDDING_MODEL` 和 `LIGHTRAG_EMBEDDING_DIM` 仅作为首次初始化默认值；修改 Embedding 模型或维度后必须迁移或重建已有向量索引。

### 大模型网关配置

网关使用 Envoy AI Gateway v1.0.0 standalone，不需要 Kubernetes 或独立数据库。推荐打开独立的 [大模型渠道页面](https://ai-console.localhost.pomerium.io:8443/model-channels)，通过卡片管理 OpenAI、Anthropic 或 OpenAI 兼容渠道：

- 渠道名称、Provider 与 Base URL；
- API Key（单独保存在 Console 数据卷，API 和页面均不回显）；
- 对外模型名与上游模型名映射；
- 启用/停用、服务端连通性测试和保存后自动重载。

未配置启用渠道时，网关保持健康但不转发模型请求。仅在不使用 Console 配置时，才需要通过 `.env` 提供 standalone 凭据：

```dotenv
OPENAI_API_KEY=...
# 或 ANTHROPIC_API_KEY=...
# 或 AZURE_OPENAI_API_KEY=... 与 AZURE_OPENAI_ENDPOINT=...
```

应用将 OpenAI SDK 的 `base_url` 指向 `http://localhost:8080/v1`，并使用 Console 中配置的“对外模型名”。请求先进入全局能力网关，再由 Envoy AI 完成协议转换和模型路由。企业 SaaS 的 OAuth 工具连接经过 OpenConnector，已有 MCP 服务可以通过 Envoy AI 聚合。

### MCP 配置

打开 [MCP配置页面](https://ai-console.localhost.pomerium.io:8443/mcp)，可以管理 Envoy AI Gateway v1.0 的 MCP Gateway：

- Open Connector 的 `/mcp` 默认接入统一入口，使用系统 Runtime Token，控制台以只读卡片展示 `apps`、`connections`、`search`、`guide` 和 `execute` 五个元工具；外部客户端看到 `connector__*`，Envoy 内部仍使用 `mcp-open-connector__*`；
- 独立 `rag-mcp` 容器默认接入统一入口，提供 `answer`、`retrieve`、`list_documents`、`search_entities` 和 `get_entity_graph` 五个知识库只读工具；外部客户端看到 `kb__*`，Envoy 内部仍使用 `mcp-rag__*`；
- 上游 Streamable HTTP MCP URL 和工具命名空间；
- 可选 API Key 与注入请求头；
- 工具允许/排除列表、启停和真实 `tools/list` 连接测试；
- 保存后生成原生 `MCPRoute`、`Backend`、TLS 和 Secret 资源，并触发网关自动重载。

Agent 连接 `http://127.0.0.1:8080/mcp`，通过 OAuth 登录后即可使用 Envoy 注册的 Open Connector、企业知识库 RAG 和其他 Streamable HTTP MCP 服务。MCP Access Gateway 在协议边界映射内置工具名；其中 `connector__apps` 和 `connector__connections` 由 Gateway 按当前员工身份直接生成，其余请求继续转发 Envoy，工具参数和 Envoy 配置不被改写。RAG MCP 通过 Compose 内网调用 LightRAG API，不修改或扩展 LightRAG 镜像。员工 Access Token 只在 MCP Access Gateway 验证，不会透传给 Envoy 或外部 MCP；Envoy 使用各上游自身的服务凭据。

`/mcp` 是受 OIDC 保护的 Streamable HTTP 协议端点，不是管理页面。未认证请求返回 `401` 和标准 `WWW-Authenticate` 发现信息。网关把外部 MCP Session 签名并绑定到 `issuer + subject + client_id`，不同员工不能复用彼此会话。管理页面位于 `https://ai-console.localhost.pomerium.io:8443/mcp`。

### 认证管理

打开 [认证管理页面](https://ai-console.localhost.pomerium.io:8443/authentication)，可以查看最近 24 小时内通过 MCP Access Gateway 完成员工身份校验的客户端：

- 员工名称与邮箱、不可逆的 Subject 摘要；
- OAuth `client_id`、Issuer、首次与最近访问时间；
- 已认证请求次数和最近 15 分钟活跃状态。

该页面为只读运行视图，不记录或展示 Access Token、Refresh Token 与原始 Subject。Console 使用 `MCP_ADMIN_TOKEN` 读取仅 Compose 内网可访问的管理端点；全局网关不代理该端点。

### 连接器配置

打开 [连接器配置页面](https://ai-console.localhost.pomerium.io:8443/connectors)，可以通过卡片和右侧抽屉管理 OpenConnector 的受控共享与全局连接。员工个人授权形成的连接和 OpenConnector 提供的免认证公共连接不与管理员配置混排，分别从页面顶部进入 [用户连接二级页](https://ai-console.localhost.pomerium.io:8443/connectors/user-connections) 与 [无需认证二级页](https://ai-console.localhost.pomerium.io:8443/connectors/no-auth) 只读查看：

- 添加时搜索并选择 Connector，编辑时保持 Connector 类型不变；
- API Key、OAuth、Custom Credential 和免认证等认证方式由上游 Provider 定义；
- 表单字段、必填规则、输入类型和 OAuth Scope 直接读取 OpenConnector 的动态认证 Schema；
- API Key 与 Client Secret 只提交到 Console 服务端，不在读取接口和编辑表单中回显；
- OAuth 在独立窗口完成，Console 确认 OpenConnector 已生成连接后才展示新卡片；
- OpenConnector 自带的免认证连接以只读系统卡片展示。
- 管理员可以把具名凭据连接设置为“受控共享”，按员工账号、OIDC Subject 或用户组授权，并限制可调用的 Action；
- `wecom_bot` 的 Bot ID/Secret 也在本页按具名连接维护，不进入“集成管理”；保存机器人时必须同时选择员工可调用的静态 Action；
- 管理员配置的企微机器人固定使用“企业身份自动筛选”策略，并必须选择所属企微认证组织；共享 Bot 只与同组织身份匹配。员工扫码创建的机器人仍独立记录为个人连接；
- 受控共享策略只在 AI Base 的 PostgreSQL 与 MCP Access Gateway 中生效，OpenConnector 仍负责保存凭据和执行 Action，不修改上游代码。

新增或编辑只有在 OpenConnector 校验并保存成功后才会更新卡片列表。受控共享连接必须使用非 `default` 的具名连接；MCP 网关根据已经验证的员工 OIDC 身份选择连接并校验 Action 白名单，客户端提交的连接名不能越权。`wecom_bot.get_userlist` 始终用于服务端可见性判定，并且只有管理员把它加入机器人 Action 白名单后才作为员工可调用的只读通讯录 Action 出现在授权连接中；`wecom_bot.call_tool` 及旧 Webhook 发送入口继续固定拒绝员工授权。可见性结果只缓存 60 秒且不使用过期结果，员工移出机器人可见范围后会自动撤权。

升级时，旧“集成管理 / 企微机器人”记录会在首次读取 Console 管理数据时迁移为 `wecom_bot_<应用 UUID>` 具名共享连接，Bot ID/Secret 写入 OpenConnector，Action 白名单写入 PostgreSQL；迁移成功后删除旧员工绑定和旧集成记录。OpenConnector 校验或数据库写入失败时保留旧记录并报错，不会把机器人降级成全局连接。

### 集成管理

[集成管理页面](https://ai-console.localhost.pomerium.io:8443/integrations) 仅供管理员使用。企业微信进入独立的 [认证二级页](https://ai-console.localhost.pomerium.io:8443/integrations/wecom-authentication)，按组织维护 CorpID、App Secret、中继回调、启用状态和各自的应用首页；飞书与钉钉分别进入独立二级页。企微机器人的 Bot ID/Secret 与 Action 策略仍在“连接器配置”维护。

企业微信认证组织保存在 `wecom_authentication_organizations`，员工映射由 `wecom_identity_links.organization_id` 归属组织；旧单例配置与既有绑定会迁移为“默认组织”。共享企微 Bot 的 `shared_connector_resources.wecom_organization_id` 同步迁移并作为可见性边界。所有 App Secret 均使用 `AI_CONSOLE_SECRET_ENCRYPTION_KEY` 执行 AES-256-GCM 加密，读取接口和编辑表单不回显明文。

普通员工登录 Console 后只进入 [账号绑定页面](https://ai-console.localhost.pomerium.io:8443/account)。页面同时维护个人 OAuth 连接和多个企微组织身份；企微身份只能从对应工作台应用首页建立，并在企微抽屉逐组织解绑。页面不展示明文 UserID。完成任一企微身份认证后，员工可创建个人机器人；管理员共享机器人由 MCP 按组织和可见范围自动筛选。个人连接建立后：

1. OpenConnector 在自己的加密 SQLite 数据中保存 OAuth Token；
2. PostgreSQL 的 `employee_connector_bindings` 只保存员工 OIDC 主体与命名连接的映射、状态和安全摘要；
3. MCP 客户端通过 AI Base OAuth 登录后，请求由服务端选择该员工的命名连接；
4. 客户端伪造的连接名会被覆盖，员工不能读取或调用其他员工的连接。

## Console 数据接口

- `GET /api/overview`：获取组件状态和运行摘要；本机排障时可使用 `?refresh=1` 跳过 10 秒缓存。
- `GET/PUT /api/llm-gateway/channels`：读取或保存渠道配置。
- `POST /api/llm-gateway/channels`：测试渠道连接并发现可用模型。
- `GET/PUT /api/llm-gateway/mcp-servers`：读取或保存 Envoy AI MCP 服务配置。
- `POST /api/llm-gateway/mcp-servers`：执行 MCP 初始化并读取真实工具列表。
- `GET /api/open-connector/providers`、`GET /api/open-connector/providers/:service`：搜索 Connector 并读取动态认证 Schema。
- `GET/PUT/DELETE /api/open-connector/connections`：读取安全摘要，并在服务端创建、更新或删除真实连接。
- `GET/PUT /api/open-connector/oauth-configs/:service`、`POST /api/open-connector/oauth-authorizations`：管理 OAuth Client 配置并启动授权。
- `GET/PUT /api/connector-access/shared-resources`、`DELETE /api/connector-access/shared-resources/:id`：管理具名 Connector 的受控共享资源、身份授权和 Action 白名单。
- `GET/POST /api/integrations`、`PUT/DELETE /api/integrations/:id`：读取并管理飞书和钉钉应用凭据。
- `POST /api/integrations/:id/activate`：将应用设为平台唯一启用配置，并同步支持的 OAuth Client。
- `GET/POST/PUT/DELETE /api/integrations/wecom-authentication`：仅管理员读取、新增、编辑或删除企业微信认证组织；存在引用时只能停用。
- `GET /api/account/integrations`、`POST/DELETE /api/account/integrations/:applicationId/authorize`：读取、发起或解除当前员工个人应用绑定。
- `POST /api/account/wecom-bots/authorize`、`GET /api/account/wecom-bots/authorize?request=...`：为已认证企微身份创建官方机器人扫码会话并轮询，成功后建立个人连接；Bot ID/Secret 不进入浏览器响应。
- `GET /auth/wework?organization=<UUID>`：按组织创建一次性企微身份识别事务并进入公网中继；省略参数只兼容恰好一个已配置组织的部署。
- `GET /auth/wework/complete`：验证中继加密结果、同浏览器 HttpOnly nonce、未过期事务和当前 CorpID；已有绑定时自动恢复用户，未绑定时转入平台登录。
- `GET /auth/wework/link`：固定经过 Pomerium，在首次平台登录后消费已验证企微事务并建立该组织映射。
- `DELETE /api/account/wecom-identity?id=<绑定 UUID>`：只解除当前平台账号的指定组织身份；不会删除其他组织身份或管理员共享机器人。
- `GET /api/observability/summary?range=15m|1h|24h|7d`：仅管理员读取模型与 MCP 的固定 PromQL 摘要；未被 capability probe 证明的模型错误率和 TTFT 明确返回“不可用”。
- `GET /api/observability/calls`：仅管理员读取最多 24 小时、扫描最多 100 条 Trace 的安全诊断样本；结果可截断，不提供稳定 cursor，也不是调用账本。
- `GET /api/observability/traces/:traceId`：仅管理员读取服务端白名单处理后的 Trace 时间线，不透传任意 tag、event 或上游错误正文。

OpenConnector Token、模型渠道 Key、MCP 上游 Key、LightRAG API Key 与企业应用 Secret 保存在服务端。Console 只读取 LightRAG 文档状态，不返回知识正文。

## 模型与 MCP 可观测性

[可观测性页面](https://ai-console.localhost.pomerium.io:8443/observability) 使用两类独立数据面：Envoy AI Gateway 的规范 GenAI metrics 与 Jaeger MCP-only SpanMetrics 进入 Compose 内网 Prometheus，逐次诊断 Trace 进入 Jaeger 2.19 Badger。默认 Trace 保留 14 天、Metrics 保留 15 天；两者均为诊断数据，不替代 PostgreSQL 审计或零丢失调用账本。

- 公网 `/v1` 和 `/mcp` 会删除 W3C、B3、Envoy request/debug、会话及身份传播载体；平台重新建立 100% head-sampled root。内部服务只传播平台生成的 W3C context，并用服务端 `traffic.origin` 排除管理探测和下游重复计数。
- 模型指标当前只采用 capability probe 已证明的调用量、P95 延迟和输入/输出 Token；模型错误率与 TTFT 暂不猜测指标名或补算。
- MCP 每条可解析 JSON-RPC message 产生一个规范 `mcp.server.message` span，记录 method、安全 server/tool/action、allow/deny、枚举原因、结果、耗时和 HMAC 身份摘要；batch、notification、SSE、未匹配响应与 observer 上限都有确定状态。
- Agent Runtime 把真实 `trace_id`、`span_id` 与 `run_id` 写入 `runtime_events`，并提供可复用的模型/MCP client span 传播边界；当前 demo runtime 没有制造虚假业务调用。
- Prompt、模型输出、工具参数/返回值、Token、Secret、完整 URL/资源 URI、异常正文与原始 OIDC Subject 在采集源和固定版本 OTel Collector 中删除；Collector 还删除全部 Span Event 并清空状态文本，Jaeger 在存储和 SpanMetrics 前重复事件与属性过滤。Console 只映射固定 DTO 字段。

本地契约检查不会启动或修改运行中的服务：

```bash
scripts/observability-probe.sh
scripts/test-observability-probe.sh
```

完整集成门禁要求默认 Compose 已启动且已配置可用模型渠道；它会发送最小模型/MCP fixture、查询 Jaeger/Prometheus/Console、检查普通日志，并重启一次 Jaeger 证明 Badger 持久化（不删除数据卷）：

```bash
scripts/test-observability-integration.sh
```

生产环境必须为 `OBSERVABILITY_IDENTITY_HMAC_KEY` 配置至少 32 字节、独立且稳定的随机密钥，并为 `OBSERVABILITY_IDENTITY_HMAC_KEY_VERSION` 配置可审计版本。轮换版本后，新旧身份摘要不会自动关联。完整字段、PromQL、基数预算和 HMAC fixture 见 [`docs/observability-schema.md`](./docs/observability-schema.md)。

## 可选运行面

Promptfoo 镜像较大，因此默认不常驻；仍由 Docker `quality` profile 或 CI 按需执行：

```bash
docker compose --profile quality up -d promptfoo
```

启动后访问 `http://promptfoo.localhost:8080`。Pomerium 属于默认管理面，随普通 `docker compose up` 启动；外部 OIDC 服务独立运行。

## 本机验证与生产边界

Compose 内置的数据库密码、OpenConnector token、Pomerium Client Secret、开发签名键和加密键只用于 loopback 本机验证。共享主机或正式环境必须从 [`.env.example`](./.env.example) 创建 `.env` 并替换全部值，同时替换 `deploy/pomerium/dev-signing-key.pem` 及对应公钥挂载；OpenConnector 与 AI Console 的加密键都必须稳定备份，丢失后无法恢复已经加密的凭据。Pomerium Data Broker 同样属于敏感认证状态，必须限制数据库访问、加密静态存储并纳入备份策略。

- OpenConnector 默认禁止通用 provider proxy，避免 Agent 绕过审阅过的 Action。
- `MCP_CONNECTOR_BINDING_RESOLVER_TOKEN` 只用于 MCP Access Gateway 到 AI Console 的 Compose 内网查询，正式环境必须替换默认值。
- Promptfoo 没有内建企业认证；Jaeger 只通过管理员 Pomerium 路由开放，Prometheus 与 OTLP 接收端不开放公共路由。
- Jaeger 使用持久化 Badger 与 14 天 TTL；普通容器重启保留有效期内 Trace。删除命名卷仍会删除数据，且 Trace 始终不作为合规账本。

## 工程验证

```bash
npm install
npm run check
docker compose config --quiet
scripts/test-observability-probe.sh
curl -fsS 'http://localhost:8080/health'
curl -fsS 'http://runtime.localhost:8080/health'
```

- 项目目录、Compose 服务、入口路由、完整调用链、安全边界与演进条件见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
- 控制台设计与交互约束见 [`DESIGN.md`](./DESIGN.md)。
