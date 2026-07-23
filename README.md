# AI Base

面向中小企业的轻量 Agent 基础设施工作区，使用 Docker Compose 部署控制台、Agent Runtime、工具连接、知识库、数据、评测与可观测组件。

## Docker 一键启动

```bash
docker compose up -d --build
docker compose ps
```

首次拉取和构建需要几分钟。只有 `global-gateway` 映射宿主机端口，其他组件仅在 Compose 网络内开放：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| AI Console | https://ai-console.localhost.pomerium.io:8443 | 经 Pomerium 与外部 OIDC 认证的一站式 Portal |
| SilverBullet | http://knowledge.localhost:8080 | 类 Obsidian 的 Markdown 知识库 |
| OpenConnector | https://open-connector.localhost.pomerium.io:8443 | 经 Pomerium 单点登录的外部连接管理入口 |
| 本地 OIDC | http://dex.localtest.me:5556/dex | 独立部署的 Dex 认证中心，不属于 AI Base Stack |
| 全局网关 | http://localhost:8080 | 模型、MCP、RAG、Runtime、Connector、知识库与可观测统一入口 |
| MCP Access Gateway | http://127.0.0.1:8080/mcp | Go 实现的 OAuth 保护 MCP 接口 |
| Envoy AI Gateway | 仅容器内访问 | 模型路由，以及内部 `/mcp` 上的外部 MCP 注册、聚合与工具路由 |
| Agent Runtime | http://runtime.localhost:8080/docs | FastAPI、PydanticAI、MCP 与 DBOS 运行边界 |
| Jaeger | http://jaeger.localhost:8080 | OpenTelemetry Trace |
| PostgreSQL | 仅容器内访问 | 控制面、审计与 pgvector |

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

Dex 中的 `ai-base-pomerium` 客户端回调地址是 `https://authenticate.localhost.pomerium.io:8443/oauth2/callback`。当前 Pomerium 策略只允许 `bluetron.cn` 邮箱域；更换企业域名时同步修改 [`deploy/pomerium/config.example.yaml`](./deploy/pomerium/config.example.yaml)。Pomerium 本机入口使用开发证书；正式部署必须配置受信任证书、正式域名和企业 OIDC。

OpenConnector 的管理请求由独立内部代理注入 Admin Token，Token 不进入浏览器。OpenConnector 不再映射宿主机端口；管理入口经 Pomerium，Agent 功能流量经全局网关 `/connector`，分别使用 Admin Token 与 Runtime Token。

MCP Access Gateway 内置轻量 OAuth Broker，面向 WorkBuddy 提供标准发现、动态客户端注册、Authorization Code + S256 PKCE 和令牌端点；Dex 只作为员工登录上游，不要求 Dex 支持动态客户端注册：

```dotenv
MCP_PUBLIC_RESOURCE_URL=http://127.0.0.1:8080/mcp
MCP_OIDC_ISSUER=http://127.0.0.1:8080/oauth
MCP_OIDC_AUDIENCE=http://127.0.0.1:8080/mcp
MCP_OIDC_REQUIRED_SCOPES=ai-base:mcp
MCP_LOGIN_OIDC_ISSUER=http://dex.localtest.me:5556/dex
MCP_LOGIN_OIDC_CLIENT_ID=ai-base-mcp-broker
MCP_LOGIN_OIDC_REDIRECT_URL=http://127.0.0.1:8080/oauth/callback
MCP_OAUTH_ALLOWED_REDIRECT_URIS=workbuddy://workbuddy/mcp/custom-mcp%3Aai-base/oauth/callback
MCP_SESSION_SIGNING_KEY=replace-with-at-least-32-random-bytes
```

WorkBuddy 只需配置 MCP URL：

```json
{
  "mcpServers": {
    "ai-base": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

点击“连接”后，WorkBuddy 从 `/.well-known/oauth-protected-resource/mcp` 发现 AI Base OAuth Broker，完成客户端注册后跳转 Dex 登录。Broker 使用 Dex 的稳定用户 ID 派生内部员工 ID，签发 audience 为 MCP Resource、包含 `ai-base:mcp` scope 的短期 JWT；员工令牌进入 Envoy 前会被移除。刷新令牌为服务内存中的一次性轮换凭据，Broker 重启后客户端需要重新登录。

`http://127.0.0.1:8080` 只用于本机验证。共享环境必须改用同一个正式 HTTPS 主机，并同步更新 MCP Resource、OAuth Issuer、Dex 回调地址和允许的客户端回调白名单。

### 全局工具入口

宿主机只开放全局网关的 `127.0.0.1:8080` 和 `127.0.0.1:8443`。功能 API 使用路径路由，带独立前端资源的工作台使用 `*.localhost:8080` 域名路由，SSO 管理入口在 8443 上转发到 Pomerium：

| 路径 | 上游能力 | 路径处理 |
| --- | --- | --- |
| `/v1`、`/v1/*` | Envoy AI Gateway 模型 API | 保留路径，支持流式响应 |
| `/mcp`、`/mcp/*` | MCP Access Gateway | OIDC 验证后转发到内部 Envoy MCP，支持 Streamable HTTP |
| `/.well-known/oauth-protected-resource/mcp` | MCP Access Gateway | OAuth Protected Resource Metadata |
| `/oauth/*`、OAuth well-known 路径 | MCP Access Gateway | WorkBuddy OAuth、DCR、PKCE、Token 与 JWKS |
| `/rag/*` | Agent Runtime RAG API | 保留路径；当前 `/rag/health` 返回数据库与 pgvector 的真实就绪状态 |
| `/runtime/*` | Agent Runtime API | 移除 `/runtime` 前缀 |
| `/llm-admin/*` | Envoy AI Gateway 管理 API | 移除 `/llm-admin` 前缀，仅供控制台内部使用 |
| `/connector/*` | Open Connector 功能 API | 移除 `/connector` 前缀 |
| `/knowledge/*` | SilverBullet | 移除 `/knowledge` 前缀；浏览器使用 `knowledge.localhost:8080` |
| `/jaeger/*` | Jaeger 查询 API | 移除 `/jaeger` 前缀；浏览器使用 `jaeger.localhost:8080` |
| `/promptfoo/*` | Promptfoo | 移除 `/promptfoo` 前缀；仅在 `quality` profile 启动后可用 |
| `/otel/*` | Jaeger OTLP HTTP | 移除 `/otel` 前缀，例如 `/otel/v1/traces` |

当前版本尚未实现知识分块、Embedding 和检索 API；除 `/rag/health` 外的 `/rag/*` 会原样转发给 Agent Runtime，待 RAG API 落地后无需再次调整统一入口。

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
- 上游 Streamable HTTP MCP URL 和工具命名空间；
- 可选 API Key 与注入请求头；
- 工具允许/排除列表、启停和真实 `tools/list` 连接测试；
- 保存后生成原生 `MCPRoute`、`Backend`、TLS 和 Secret 资源，并触发网关自动重载。

Agent 连接 `http://127.0.0.1:8080/mcp`，通过 OAuth 登录后即可使用 Envoy 注册的 Open Connector 和其他 Streamable HTTP MCP 服务。员工 Access Token 只在 MCP Access Gateway 验证，不会透传给 Envoy 或外部 MCP；Envoy 使用各上游自身的服务凭据。

`/mcp` 是受 OIDC 保护的 Streamable HTTP 协议端点，不是管理页面。未认证请求返回 `401` 和标准 `WWW-Authenticate` 发现信息。网关把外部 MCP Session 签名并绑定到 `issuer + subject + client_id`，不同员工不能复用彼此会话。管理页面位于 `https://ai-console.localhost.pomerium.io:8443/mcp`。

### 连接器配置

打开 [连接器配置页面](https://ai-console.localhost.pomerium.io:8443/connectors)，可以通过卡片和右侧抽屉管理 OpenConnector 连接：

- 添加时搜索并选择 Connector，编辑时保持 Connector 类型不变；
- API Key、OAuth、Custom Credential 和免认证等认证方式由上游 Provider 定义；
- 表单字段、必填规则、输入类型和 OAuth Scope 直接读取 OpenConnector 的动态认证 Schema；
- API Key 与 Client Secret 只提交到 Console 服务端，不在读取接口和编辑表单中回显；
- OAuth 在独立窗口完成，Console 确认 OpenConnector 已生成连接后才展示新卡片；
- OpenConnector 自带的免认证连接以只读系统卡片展示。

新增或编辑只有在 OpenConnector 校验并保存成功后才会更新卡片列表。Action 调试、运行令牌和策略仍在 OpenConnector 专业管理界面完成。

## Console 数据接口

- `GET /api/overview`：获取组件状态和运行摘要；本机排障时可使用 `?refresh=1` 跳过 10 秒缓存。
- `GET/PUT /api/llm-gateway/channels`：读取或保存渠道配置。
- `POST /api/llm-gateway/channels`：测试渠道连接并发现可用模型。
- `GET/PUT /api/llm-gateway/mcp-servers`：读取或保存 Envoy AI MCP 服务配置。
- `POST /api/llm-gateway/mcp-servers`：执行 MCP 初始化并读取真实工具列表。
- `GET /api/open-connector/providers`、`GET /api/open-connector/providers/:service`：搜索 Connector 并读取动态认证 Schema。
- `GET/PUT/DELETE /api/open-connector/connections`：读取安全摘要，并在服务端创建、更新或删除真实连接。
- `GET/PUT /api/open-connector/oauth-configs/:service`、`POST /api/open-connector/oauth-authorizations`：管理 OAuth Client 配置并启动授权。

OpenConnector Token、模型渠道 Key 与 MCP 上游 Key 保存在服务端，知识目录以只读方式挂载。

## 可选运行面

Promptfoo 镜像较大，因此默认不常驻；仍由 Docker `quality` profile 或 CI 按需执行：

```bash
docker compose --profile quality up -d promptfoo
```

启动后访问 `http://promptfoo.localhost:8080`。Pomerium 属于默认管理面，随普通 `docker compose up` 启动；外部 OIDC 服务独立运行。

## 本机验证与生产边界

Compose 内置的数据库密码、OpenConnector token、Pomerium Client Secret 和加密键只用于 loopback 本机验证。共享主机或正式环境必须从 [`.env.example`](./.env.example) 创建 `.env` 并替换全部值；OpenConnector 的加密键必须稳定备份，丢失后无法恢复已经加密的连接凭证。

- OpenConnector 默认禁止通用 provider proxy，避免 Agent 绕过审阅过的 Action。
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
