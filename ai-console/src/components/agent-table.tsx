import { ArrowRight, GitBranch } from "lucide-react";
import Link from "next/link";

import type { RuntimeAgentSnapshot } from "@/lib/control-plane/types";
import { formatDateTime, formatNumber } from "@/lib/format";

import { StatusPill } from "./status-pill";

export function AgentTable({ agents, limit }: { agents: RuntimeAgentSnapshot[]; limit?: number }) {
  const visibleAgents = typeof limit === "number" ? agents.slice(0, limit) : agents;

  if (visibleAgents.length === 0) {
    return <div className="empty-data"><strong>Agent Runtime 尚未注册 Agent</strong><span>注册后会在这里显示配置和实际运行事件。</span></div>;
  }

  return (
    <div className="table-scroll">
      <table className="data-table agent-table">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">模型策略</th>
            <th scope="col">实际事件</th>
            <th scope="col">注册工具</th>
            <th scope="col">最后运行</th>
            <th scope="col">状态</th>
            <th scope="col" aria-label="查看" />
          </tr>
        </thead>
        <tbody>
          {visibleAgents.map((agent) => (
            <tr key={agent.id}>
              <td data-label="Agent">
                <div className="agent-identity">
                  <span className="agent-avatar">{agent.name.slice(0, 1)}</span>
                  <span>
                    <strong>{agent.name}</strong>
                    <small className="cell-mono">{agent.id}</small>
                  </span>
                </div>
              </td>
              <td data-label="模型策略">
                <span className="version-label">
                  <GitBranch size={12} aria-hidden="true" /> {agent.modelAlias || "未配置"}
                </span>
              </td>
              <td data-label="实际事件" className="cell-mono">{formatNumber(agent.runCount)}</td>
              <td data-label="注册工具" className="cell-mono">{agent.tools.length}</td>
              <td data-label="最后运行">{formatDateTime(agent.latestRunAt)}</td>
              <td data-label="状态"><StatusPill status={agent.status === "ready" ? "healthy" : "idle"} compact /></td>
              <td className="table-actions">
                <Link className="icon-button" href={`/agents/${agent.id}`} aria-label={`查看${agent.name}`}>
                  <ArrowRight size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
