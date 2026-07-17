# Agent 运行规范

- Agent 使用稳定模型别名，不直接依赖供应商模型名称。
- 写操作必须经过身份、权限、风险与审批判断。
- 每次运行贯穿 `tenant_id`、`user_id`、`agent_id`、`run_id` 与 `tool_call_id`。
- Trace 用于诊断，审计表用于合规留痕，两者不能互相替代。
