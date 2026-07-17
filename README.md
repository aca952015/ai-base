# AI Base

面向中小企业的轻量 Agent 基础设施工作区，使用 Docker Compose 部署控制台、Agent Runtime、工具连接、知识库、数据、评测与可观测组件。

## Docker 一键启动

```bash
docker compose up -d --build
docker compose ps
```

首次拉取和构建需要几分钟。默认端口只绑定 `127.0.0.1`：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| AI Console | http://localhost:3000 | 一站式组件 Portal、统一控制台与健康检查 |
| SilverBullet | http://localhost:3001 | 类 Obsidian 的 Markdown 知识库 |
| OpenConnector | http://localhost:3100 | 外部 SaaS 连接与 Action 管理 |
| 大模型网关（Envoy） | http://localhost:8080 | OpenAI 兼容 API、多供应商协议转换与模型路由 |
| Agent Runtime | http://localhost:18000/docs | FastAPI、PydanticAI、MCP 与 DBOS 运行边界 |
| Jaeger | http://localhost:16686 | OpenTelemetry Trace |
| PostgreSQL | `localhost:5432` | 控制面、审计与 pgvector |

查看日志或停止服务：

```bash
docker compose logs -f
docker compose down
```

`docker compose down` 会保留命名卷。只有明确希望删除本地数据时才使用 `docker compose down -v`。

AI Console 的 `/components` 是统一组件门户，提供组件状态、运行端点和管理入口；OpenConnector、SilverBullet 和 Jaeger 的深度操作仍在各自界面完成。

### 大模型网关配置

网关使用 Envoy AI Gateway v1.0.0 standalone，不需要 Kubernetes 或独立数据库。推荐打开独立的 [大模型渠道页面](http://localhost:3000/model-channels)，通过卡片管理 OpenAI、Anthropic 或 OpenAI 兼容渠道：

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

应用将 OpenAI SDK 的 `base_url` 指向 `http://localhost:8080/v1`，并使用 Console 中配置的“对外模型名”。工具连接统一经过 OpenConnector。

## Console 数据接口

- `GET /api/overview`：获取组件状态和运行摘要；本机排障时可使用 `?refresh=1` 跳过 10 秒缓存。
- `GET/PUT /api/llm-gateway/channels`：读取或保存渠道配置。
- `POST /api/llm-gateway/channels`：测试渠道连接并发现可用模型。

OpenConnector Token 与模型渠道 Key 保存在服务端，知识目录以只读方式挂载。

## 可选运行面

Promptfoo 镜像较大，因此默认不常驻；仍由 Docker `quality` profile 或 CI 按需执行：

```bash
docker compose --profile quality up -d promptfoo
```

启动后访问 `http://localhost:3002`。Pomerium 位于 `oidc` profile，但必须先在 `deploy/pomerium/config.example.yaml` 中配置企业 OIDC、域名与正式密钥：

```bash
docker compose --profile oidc up -d pomerium
```

## 本机验证与生产边界

Compose 内置的数据库密码、OpenConnector token 和加密键只用于 loopback 本机验证。共享主机或正式环境必须从 [`.env.example`](./.env.example) 创建 `.env` 并替换全部值；OpenConnector 的加密键必须稳定备份，丢失后无法恢复已经加密的连接凭证。

- OpenConnector 默认禁止通用 provider proxy，避免 Agent 绕过审阅过的 Action。
- Promptfoo 和 Jaeger UI 没有内建企业认证；正式环境应放在 Pomerium 或等价身份边界后。
- Jaeger 默认使用内存存储，容器重启后 Trace 会清空；审计数据保存在 PostgreSQL，Trace 不作为合规账本。

## 工程验证

```bash
npm install
npm run check
docker compose config --quiet
curl -fsS 'http://localhost:3000/api/overview?refresh=1'
```

- 基础设施方案与组件边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
- 控制台设计与交互约束见 [`DESIGN.md`](./DESIGN.md)。
