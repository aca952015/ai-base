# AI Base

面向中小企业的轻量 Agent 基础设施工作区，使用 Docker Compose 部署控制台、Agent Runtime、工具连接、知识库、数据、评测与可观测组件。

## Docker 一键启动

```bash
git submodule update --init --recursive
docker compose up -d --build
docker compose ps
```

OpenConnector 从 `vendor/open-connector` 中固定的上游提交构建本地镜像，当前固定为 `27b111b50b80db83cf472ed5290372eda2cd0130`。这个提交包含 MCP 命名连接能力；浮动 `main` 和旧的 `v1.3.0` 镜像都不会在部署时使用。首次拉取和构建需要几分钟。只有 `global-gateway` 映射宿主机端口，其他组件仅在 Compose 网络内开放：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| AI Console | https://ai-console.localhost.pomerium.io:8443 | 经 Pomerium 与外部 OIDC 认证的一站式 Portal |
| 企业微信直达登录 | https://ai-console.localhost.pomerium.io:8443/auth/wework | 跳过认证方式选择，直接进入企业微信认证后打开账号管理 |
| LightRAG | http://knowledge.localhost:8080/webui | 文档、混合检索与知识图谱工作台 |
| OpenConnector | https://open-connector.localhost.pomerium.io:8443 | 经 Pomerium 单点登录的外部连接管理入口 |
| 本地 OIDC | http://dex.localtest.me:5556/dex | 独立部署的 Dex 认证中心，不属于 AI Base Stack |
| 全局网关 | http://localhost:8080 | 模型、MCP、RAG、Runtime、Connector、知识库与可观测统一入口 |
| MCP Access Gateway | http://127.0.0.1:8080/mcp | Go 实现的 OAuth 保护 MCP 接口 |
| 企业微信认证桥接 | http://127.0.0.1:8080/wecom-oidc | 将企业微信网页授权转换为 Dex 可接入的标准 OIDC；仅认证端点，无管理 UI |
| Envoy AI Gateway | 仅容器内访问 | 模型路由，以及内部 `/mcp` 上的外部 MCP 注册、聚合与工具路由 |
| RAG MCP | 仅容器内访问 | 将 LightRAG 只读查询封装为内置 MCP 工具，不修改 LightRAG |
| Agent Runtime | http://runtime.localhost:8080/docs | FastAPI、PydanticAI、MCP 与 DBOS 运行边界 |
| Jaeger | http://jaeger.localhost:8080 | OpenTelemetry Trace |
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

Dex 中的 `ai-base-pomerium` 客户端需要同时登记 `https://authenticate.localhost.pomerium.io:8443/oauth2/callback` 和 `https://authenticate-wework.localhost.pomerium.io:8443/oauth2/callback`。普通入口保留 Dex 的认证方式选择；`/auth/wework` 转到隔离的 Pomerium 入口，由静态 `connector_id=wecom` 直接进入企业微信认证。当前 Pomerium 策略只允许 `bluetron.cn` 邮箱域；更换企业域名时同步修改 [`deploy/pomerium/config.example.yaml`](./deploy/pomerium/config.example.yaml) 和 [`deploy/pomerium/wework-config.example.yaml`](./deploy/pomerium/wework-config.example.yaml)。Pomerium 本机入口使用开发证书和仓库内的本地签名键；正式部署必须替换签名键，并配置受信任证书、正式域名和企业 OIDC。AI Console 会验证 Pomerium 签名的 JWT Assertion、有效期和两个受信入口的 audience，不信任可由客户端直接伪造的身份头。

### 企业微信登录桥接

`wecom-auth-bridge` 是独立 Go 容器，作为 Dex 的上游 OIDC Provider。员工从 Console 或 MCP 登录时在 Dex 选择“企业微信”，桥接服务执行企业微信 `snsapi_base` 网页授权，使用返回的企业 `UserID` 生成稳定 OIDC Subject，再由 Dex 统一签发 AI Base 身份。Pomerium、MCP Access Gateway 与账号绑定仍只信任 Dex，因此同一员工在浏览器与 MCP 客户端中保持同一身份边界。

管理员在 Console 的“集成管理 / 企微”中登记并启用应用：

- “企业 ID（CorpID）”填写企业微信管理后台的企业 ID；
- “App Secret”填写该自建应用的 Secret；
- 自建应用的可见范围应包含允许登录 AI Base 的员工；
- 在“系统设置 / 企业微信认证”中维护 AI Base 公开认证入口、企业邮箱域和回调方式；企业微信后台把可信域名与网页授权回调配置为页面展示的“当前生效回调”；正式公网部署可直接使用本地网关，开发机/内网部署则可使用独立公网回调中继；
- 不使用 Relay 时，将下载的 `WW_verify_*.txt` 原文件放入 `deploy/global-gateway/wecom-verification/`；使用 Relay 时，按其 README 配置校验文件名与内容；
- 工作台应用主页指向 AI Console 的 `/auth/wework`；该入口不展示认证方式选择页，认证完成后直接进入 `/account`。

桥接服务在每次新登录时通过内网接口读取 Console 中的公开路由设置与启用应用，保存后无需重启；Secret 不返回浏览器。只有内部接口 Token、Dex 上游客户端密钥和身份拓扑仍属于启动信任根：

```dotenv
WECOM_AUTH_BRIDGE_CONFIG_TOKEN=replace-with-a-long-random-internal-token
WECOM_OIDC_CLIENT_SECRET=replace-with-a-random-dex-upstream-client-secret
WECOM_DEX_REDIRECT_URI=https://id.example.com/dex/callback
```

相邻 `local-oidc` 的 Dex 配置已包含 `wecom` OIDC Connector，本地桥接客户端密钥必须与 AI Base 的 `WECOM_OIDC_CLIENT_SECRET` 相同。正式环境需把桥接 `issuer` 和 Dex 回调统一替换为部署对应的稳定地址。OIDC Client Secret、内部配置 Token、签名密钥、issuer/client 绑定不能移入登录后的管理页面，否则会形成认证自举死锁并扩大信任根暴露面。

系统设置默认使用 `http://127.0.0.1:8080/wecom-oidc` 并直接回调其 `/callback`，仅适合本机验证。使用公网中继时，把“回调方式”改为“通过公网认证中继”并填写稳定 HTTPS 回调地址；中继仍不持有企微 Secret 或用户身份，只把白名单参数交还浏览器，因此页面中的 AI Base 公开认证入口必须能被发起登录的浏览器访问。

外部 Dex 的 Connector 配置如下；`redirectURI` 必须是 Dex 自身 issuer 下的 `/callback`：

```yaml
connectors:
  - type: oidc
    id: wecom
    name: 企业微信
    config:
      issuer: http://wecom-auth-bridge:8082
      clientID: ai-base-dex
      clientSecret: $WECOM_OIDC_CLIENT_SECRET
      redirectURI: http://dex.localtest.me:5556/dex/callback
      getUserInfo: true
      insecureSkipEmailVerified: true
      scopes: [profile, email, groups, offline_access]
```

桥接服务的 Access Token 默认 1 小时，Dex 上游 Refresh Token 使用持久卷保存、90 天滑动续期；刷新凭据只保存 SHA-256 哈希。企业微信通讯录权限允许时使用成员企业邮箱；读取受限或邮箱域不匹配时，按系统设置中的企业邮箱域生成 `UserID@<domain>` 稳定登录邮箱。修改该域时还应同步检查 Pomerium 的邮箱域策略。

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

员工还需要在 AI Console 的 [账号绑定页面](https://ai-console.localhost.pomerium.io:8443/account) 完成个人企业账号授权。MCP Access Gateway 会按 Broker JWT 的 `issuer + subject` 查询 PostgreSQL 映射，覆盖客户端提交的 `connectionName`，并只向当前员工的 MCP 客户端返回该员工自己的有效连接。需要凭据的 Connector 在没有绑定、连接已失效或映射服务不可用时会关闭失败，不会回退到共享 `default` 连接；上游明确声明为 `no_auth` 的虚拟公共 Connector 可以按系统 `default` 连接使用。

`http://127.0.0.1:8080` 只用于本机验证。共享环境必须改用同一个正式 HTTPS 主机，并同步更新 MCP Resource、OAuth Issuer、Dex 回调地址和允许的客户端回调白名单。

### 全局工具入口

宿主机只开放全局网关的 `127.0.0.1:8080` 和 `127.0.0.1:8443`。功能 API 使用路径路由，带独立前端资源的工作台使用 `*.localhost:8080` 域名路由，SSO 管理入口在 8443 上转发到 Pomerium：

| 路径 | 上游能力 | 路径处理 |
| --- | --- | --- |
| `/v1`、`/v1/*` | Envoy AI Gateway 模型 API | 保留路径，支持流式响应 |
| `/mcp`、`/mcp/*` | MCP Access Gateway | OIDC 验证后转发到内部 Envoy MCP，支持 Streamable HTTP |
| `/.well-known/oauth-protected-resource/mcp` | MCP Access Gateway | OAuth Protected Resource Metadata |
| `/oauth/*`、OAuth well-known 路径 | MCP Access Gateway | MCP 客户端 OAuth、DCR、PKCE、Token 与 JWKS |
| `/wecom-oidc/*` | 企业微信认证桥接 | Dex 上游 OIDC 的公开授权与企业微信回调；Token、UserInfo 和 JWKS 走 Compose 内网 |
| `/rag/*` | LightRAG API | 移除 `/rag` 前缀；提供文档、检索和知识图谱 API |
| `/runtime/*` | Agent Runtime API | 移除 `/runtime` 前缀 |
| `/llm-admin/*` | Envoy AI Gateway 管理 API | 移除 `/llm-admin` 前缀，仅供控制台内部使用 |
| `/connector/*` | Open Connector 功能 API | 移除 `/connector` 前缀 |
| `/knowledge/*` | LightRAG | 移除 `/knowledge` 前缀；浏览器使用 `knowledge.localhost:8080/webui` |
| `/jaeger/*` | Jaeger 查询 API | 移除 `/jaeger` 前缀；浏览器使用 `jaeger.localhost:8080` |
| `/promptfoo/*` | Promptfoo | 移除 `/promptfoo` 前缀；仅在 `quality` profile 启动后可用 |
| `/otel/*` | Jaeger OTLP HTTP | 移除 `/otel` 前缀，例如 `/otel/v1/traces` |

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

- Open Connector 的 `/mcp` 默认接入统一入口，使用系统 Runtime Token，控制台以只读卡片展示；
- 独立 `rag-mcp` 容器默认接入统一入口，提供知识问答、上下文检索、文档状态和知识图谱只读工具；
- 上游 Streamable HTTP MCP URL 和工具命名空间；
- 可选 API Key 与注入请求头；
- 工具允许/排除列表、启停和真实 `tools/list` 连接测试；
- 保存后生成原生 `MCPRoute`、`Backend`、TLS 和 Secret 资源，并触发网关自动重载。

Agent 连接 `http://127.0.0.1:8080/mcp`，通过 OAuth 登录后即可使用 Envoy 注册的 Open Connector、企业知识库 RAG 和其他 Streamable HTTP MCP 服务。RAG MCP 通过 Compose 内网调用 LightRAG API，不修改或扩展 LightRAG 镜像。员工 Access Token 只在 MCP Access Gateway 验证，不会透传给 Envoy 或外部 MCP；Envoy 使用各上游自身的服务凭据。

`/mcp` 是受 OIDC 保护的 Streamable HTTP 协议端点，不是管理页面。未认证请求返回 `401` 和标准 `WWW-Authenticate` 发现信息。网关把外部 MCP Session 签名并绑定到 `issuer + subject + client_id`，不同员工不能复用彼此会话。管理页面位于 `https://ai-console.localhost.pomerium.io:8443/mcp`。

### 认证管理

打开 [认证管理页面](https://ai-console.localhost.pomerium.io:8443/authentication)，可以查看最近 24 小时内通过 MCP Access Gateway 完成员工身份校验的客户端：

- 员工名称与邮箱、不可逆的 Subject 摘要；
- OAuth `client_id`、Issuer、首次与最近访问时间；
- 已认证请求次数和最近 15 分钟活跃状态。

该页面为只读运行视图，不记录或展示 Access Token、Refresh Token 与原始 Subject。Console 使用 `MCP_ADMIN_TOKEN` 读取仅 Compose 内网可访问的管理端点；全局网关不代理该端点。

### 连接器配置

打开 [连接器配置页面](https://ai-console.localhost.pomerium.io:8443/connectors)，可以通过卡片和右侧抽屉管理 OpenConnector 连接：

- 添加时搜索并选择 Connector，编辑时保持 Connector 类型不变；
- API Key、OAuth、Custom Credential 和免认证等认证方式由上游 Provider 定义；
- 表单字段、必填规则、输入类型和 OAuth Scope 直接读取 OpenConnector 的动态认证 Schema；
- API Key 与 Client Secret 只提交到 Console 服务端，不在读取接口和编辑表单中回显；
- OAuth 在独立窗口完成，Console 确认 OpenConnector 已生成连接后才展示新卡片；
- OpenConnector 自带的免认证连接以只读系统卡片展示。
- 管理员可以把具名凭据连接设置为“受控共享”，按员工账号、OIDC Subject 或用户组授权，并限制可调用的 Action；
- 受控共享策略只在 AI Base 的 PostgreSQL 与 MCP Access Gateway 中生效，OpenConnector 仍负责保存凭据和执行 Action，不修改上游代码。

新增或编辑只有在 OpenConnector 校验并保存成功后才会更新卡片列表。受控共享连接必须使用非 `default` 的具名连接；MCP 网关根据已经验证的员工 OIDC 身份选择连接并校验 Action 白名单，客户端提交的连接名不能越权。高风险通用调用 `wecom_bot.call_tool` 固定拒绝共享授权，企微共享能力应按具体 Action 开放。

### 集成管理

[集成管理页面](https://ai-console.localhost.pomerium.io:8443/integrations) 仅供管理员使用，固定提供飞书、企微和钉钉三个分组。每个分组可以登记多个企业应用，但同一平台只有一个启用应用；员工开始授权前，AI Base 会把启用应用的 OAuth Client 配置同步到 OpenConnector。

应用配置独立保存在 PostgreSQL 的 `integration_applications` 表中。`App Secret` 使用 `AI_CONSOLE_SECRET_ENCRYPTION_KEY` 在服务端执行 AES-256-GCM 加密，读取接口和编辑表单均不回显明文。OpenConnector 当前只有飞书 Provider 提供用户级 OAuth；企微和钉钉现有 Provider 是机器人/API Key 模式，因此控制台保留企业应用配置，但个人授权按钮保持不可用，直到上游提供用户 OAuth。

普通员工登录 Console 后只进入 [账号绑定页面](https://ai-console.localhost.pomerium.io:8443/account)。飞书授权成功后：

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
- `GET/POST /api/integrations`、`PUT/DELETE /api/integrations/:id`：读取并管理飞书、企微和钉钉应用凭据。
- `POST /api/integrations/:id/activate`：将应用设为平台唯一启用配置，并同步支持的 OAuth Client。
- `GET/PUT /api/settings/wecom-auth`：仅管理员读取或保存企微公开认证入口、回调方式和企业邮箱域。
- `GET /api/internal/wecom-auth/config`：仅供桥接容器以内网 Bearer Token 读取企微运行设置以及启用的 CorpID 与 Secret，不由全局网关代理。
- `GET /api/account/integrations`、`POST/DELETE /api/account/integrations/:platform/authorize`：读取、发起或解除当前员工个人绑定。

OpenConnector Token、模型渠道 Key、MCP 上游 Key、LightRAG API Key 与企业应用 Secret 保存在服务端。Console 只读取 LightRAG 文档状态，不返回知识正文。

## 可选运行面

Promptfoo 镜像较大，因此默认不常驻；仍由 Docker `quality` profile 或 CI 按需执行：

```bash
docker compose --profile quality up -d promptfoo
```

启动后访问 `http://promptfoo.localhost:8080`。Pomerium 属于默认管理面，随普通 `docker compose up` 启动；外部 OIDC 服务独立运行。

## 本机验证与生产边界

Compose 内置的数据库密码、OpenConnector token、Pomerium Client Secret、开发签名键和加密键只用于 loopback 本机验证。共享主机或正式环境必须从 [`.env.example`](./.env.example) 创建 `.env` 并替换全部值，同时替换 `deploy/pomerium/dev-signing-key.pem` 及对应公钥挂载；OpenConnector 与 AI Console 的加密键都必须稳定备份，丢失后无法恢复已经加密的凭据。

- OpenConnector 默认禁止通用 provider proxy，避免 Agent 绕过审阅过的 Action。
- `MCP_CONNECTOR_BINDING_RESOLVER_TOKEN` 只用于 MCP Access Gateway 到 AI Console 的 Compose 内网查询，正式环境必须替换默认值。
- Promptfoo 和 Jaeger UI 没有内建企业认证；正式环境应放在 Pomerium 或等价身份边界后。
- Jaeger 默认使用内存存储，容器重启后 Trace 会清空；审计数据保存在 PostgreSQL，Trace 不作为合规账本。

## 工程验证

```bash
npm install
npm run check
docker compose config --quiet
curl -fsS 'http://localhost:8080/health'
curl -fsS 'http://runtime.localhost:8080/health'
```

- 基础设施方案与组件边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
- 控制台设计与交互约束见 [`DESIGN.md`](./DESIGN.md)。
