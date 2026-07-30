import { Blocks, Bot, BrainCircuit, Database, Network, NotebookTabs } from "lucide-react";

const nodes = [
  { label: "Agent", meta: "PydanticAI", icon: Bot, tone: "blue" },
  { label: "模型", meta: "Envoy AI Gateway", icon: BrainCircuit, tone: "teal" },
  { label: "工具", meta: "MCP", icon: Blocks, tone: "amber" },
  { label: "连接", meta: "Open Connector", icon: Network, tone: "teal" },
  { label: "知识", meta: "LightRAG", icon: NotebookTabs, tone: "blue" },
  { label: "数据", meta: "Postgres", icon: Database, tone: "teal" },
] as const;

export function StackFlow() {
  return (
    <div className="stack-flow" role="img" aria-label="Agent 依赖模型、工具、连接、知识和数据服务，当前连接层需要关注">
      {nodes.map((node, index) => {
        const Icon = node.icon;
        return (
          <div className="stack-node-wrap" key={node.label}>
            {index > 0 ? <span className="stack-connector" aria-hidden="true" /> : null}
            <div className={`stack-node stack-node--${node.tone}${node.label === "连接" ? " has-warning" : ""}`}>
              <span className="stack-node__icon">
                <Icon size={17} aria-hidden="true" />
              </span>
              <span>
                <strong>{node.label}</strong>
                <small>{node.meta}</small>
              </span>
              {node.label === "连接" ? <span className="warning-pip" title="一个授权即将过期" /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
