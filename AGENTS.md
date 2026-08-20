# AI Base 项目协作约定

本文件只记录 `ai-base` 的项目级执行约束；系统事实以代码、测试和对应正式文档为准。

## 开始工作前

1. 运行 `git status --short`，保留用户已有修改，不覆盖或回滚无关文件。
2. 完整阅读 `ARCHITECTURE.md`，从入口、协议边界、身份与策略校验一直追踪到执行器和数据所有者，再选择实现位置。
3. 按任务继续阅读：运行与端点看 `README.md`，Console 体验看 `DESIGN.md`，治理规范看 `deploy/silverbullet/space/*.md`。
4. `.omx/plans` 只表示提案；`.omx/state`、`.omx/context` 和 `.omx/artifacts` 只表示过程状态。描述当前能力前必须核对代码、测试和 Git 历史。

## 仓库与架构边界

- 本目录是独立 Git 仓库；外层 `..` 是研究工作区。`../ai-auth-relay` 是独立部署边界，不属于 AI Base Compose。
- `vendor/open-connector` 是固定上游边界。除非任务明确要求升级或修补上游，否则不要修改；进入后遵守其 `AGENTS.md`。
- Caddy 只负责宿主机入口与路由；普通浏览器和首次平台登录由 Pomerium 保护。企微工作台的受限引导与已绑定会话恢复属于 `ARCHITECTURE.md` 明确记录的 Console 例外，Caddy 不验证身份。MCP Access Gateway 负责公共 MCP OAuth、Session、工具表示和员工授权；Envoy 负责内部模型/MCP 注册与路由。不得互相替代。
- 全局 Caddy 是唯一宿主机能力入口，其他服务默认只在 Compose 网络内可达。
- 外部 OIDC/Dex 是身份源；稳定员工身份使用已验证的 `issuer + subject`，邮箱不作为长期授权主键。
- 客户端提交的身份头、Session、连接名、群组、Action 和资源 ID 均不可信，必须在服务端重新解析。无授权、歧义、策略不可用或参数无法识别时关闭失败。
- `no_auth`、`account_bound`、`controlled_shared` 和 `global` 必须保持不同语义；需要凭据的 Connector 不得回退到共享 `default`。
- Prompt 不是安全边界。写入、删除和批量发送必须经过确定性 Schema、权限、风险、确认/审批、幂等和审计。
- Token、Secret、敏感正文和完整工具参数不得进入浏览器响应、Prompt、Trace 或普通日志。
- LightRAG 复用 PostgreSQL + pgvector + AGE；Embedding 模型或维度变化前必须迁移或重建向量索引。

## 实现与同步

- 优先复用现有函数、Schema、组件和测试模式；未经明确要求不新增依赖。
- Open Connector 的认证字段和 Action 以真实上游 Schema 为准；AI Base 的身份、策略和审计留在 Console/PostgreSQL/MCP Gateway。
- 数据库变更必须兼容空库、已有库和重复执行；先发布 migration，再发布依赖代码。
- 认证、Connector、MCP 或企微改动至少覆盖成功、未授权、伪造输入、策略不可用、撤权和既有 no-auth/飞书回归。
- Console 改动遵守 `DESIGN.md`，同时落实服务端权限、密钥不回显以及 loading、empty、error、disabled、success 和慢网络状态。
- 目录职责、服务、路由、调用链、身份/数据所有者或安全策略变化时更新 `ARCHITECTURE.md`；部署和操作变化更新 `README.md`；Console 体验变化更新 `DESIGN.md`。
- 实现 plan 后更新其状态，并把稳定结论迁入正式文档。

## 验证

先运行直接相关测试，再按风险扩大范围：

```bash
npm run check
docker compose config --quiet
(cd mcp-backend-adapter && go test ./...)
(cd mcp-access-gateway && go test ./...)
(cd ../ai-auth-relay && go test ./...)
(cd rag-mcp && python3 -m unittest test_server.py)
```

凡代码改动会进入 Docker 镜像，完成标准必须包含重建并部署受影响服务；只通过源码测试或 `docker compose config` 不代表运行环境已更新。单服务代码改动默认执行：

```bash
docker compose build <service>
docker compose up -d --no-deps <service>
docker compose ps <service>
docker compose logs --tail=100 <service>
```

部署后必须确认容器使用新镜像、服务达到 healthy/ready，并对受影响的 API 或页面执行 smoke test。涉及 Compose 拓扑、依赖服务、共享基础镜像、migration 或环境变量时，按实际影响范围重建和部署相关服务，不使用 `--no-deps` 掩盖必要的依赖更新；执行前核对影响范围，执行后检查所有被重建服务的健康状态和数据迁移结果。环境不允许部署时，将其明确记录为验证缺口，不得宣称变更已在运行环境生效。

UI 改动还需对受影响路由执行桌面浏览器 smoke test。环境不满足时记录实际版本和替代证据，不得把未运行写成通过。禁止未经用户明确要求执行 `docker compose down -v`。
