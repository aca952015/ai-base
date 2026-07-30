# AI Base 知识空间

这里是 AI Base 的初始知识文档，用于验证 LightRAG 的文档导入、分块、向量索引和知识图谱。

## 基础设施原则

- 所有功能服务通过全局能力网关访问。
- 大模型请求通过 Envoy AI Gateway 统一路由。
- LightRAG 的 KV、文档状态、向量和图数据统一保存在 PostgreSQL。
- pgvector 保存向量，Apache AGE 保存知识图谱。
- Open Connector 负责外部系统连接，MCP 访问网关负责员工身份认证和连接器隔离。
