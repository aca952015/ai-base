# AI Base

面向中小企业的轻量 Agent 基础设施工作区。默认运行面只使用 Docker Compose，外部模型负责推理，企业内部保留控制台、Agent Runtime、工具连接、知识、数据、评测与可观测边界。

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
| Bifrost | http://localhost:8080 | 外部大模型网关与路由 |
| Agent Runtime | http://localhost:18000/docs | FastAPI、PydanticAI、MCP 与 DBOS 运行边界 |
| Jaeger | http://localhost:16686 | OpenTelemetry Trace |
| PostgreSQL | `localhost:5432` | 控制面、审计与 pgvector |

查看日志或停止服务：

```bash
docker compose logs -f
docker compose down
```

`docker compose down` 会保留命名卷。只有明确希望删除本地数据时才使用 `docker compose down -v`。

AI Console 的 `/components` 是整套基础设施的统一组件门户：集中展示实时状态、能力标签和运行端点，并提供专业工作台、内部管理页及端点配置入口。Bifrost、OpenConnector、SilverBullet 和 Jaeger 仍在各自界面完成深度操作，Portal 不通过 iframe 复制这些能力。

## Console 真实数据面

AI Console 不使用演示指标兜底。Server Component 通过内部聚合层读取各组件的受限数据，再把经过白名单筛选的摘要提供给页面：

- Agent Runtime：Agent 注册、工具清单、Runtime 事件、PostgreSQL 大小与 pgvector 版本；
- Bifrost：供应商、模型、真实请求与成本摘要；
- OpenConnector：Provider、App、连接元数据与 Action 运行摘要；
- SilverBullet：只读 Space 中 Markdown 文件的路径、大小与修改时间；
- Jaeger：服务、Trace、Span、耗时与错误状态摘要；
- Promptfoo：按需容器的运行状态；没有评测产物时显示真实空状态。

聚合接口为 `GET /api/overview`；本机排障时可使用 `GET /api/overview?refresh=1` 跳过 10 秒缓存。OpenConnector Token 只注入 Console 服务端，知识目录只读挂载；接口不会返回 SaaS 凭证、知识正文、Prompt/Output 或任意 Span 日志。

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
- Bifrost、OpenConnector 和 Promptfoo 在调用真实外部模型/SaaS 前仍需配置对应供应商凭据。

## 工程验证

```bash
npm install
npm run check
docker compose config --quiet
curl -fsS 'http://localhost:3000/api/overview?refresh=1'
```

- 基础设施方案与组件边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
- 控制台设计与交互约束见 [`DESIGN.md`](./DESIGN.md)。
