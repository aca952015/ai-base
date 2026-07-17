"use client";

import { FlaskConical, RefreshCw, ScanSearch } from "lucide-react";
import { useState } from "react";

import type { ConsoleAction } from "@/lib/control-plane/types";

const actions: Array<{ id: ConsoleAction; label: string; icon: typeof RefreshCw }> = [
  { id: "check-health", label: "健康检查", icon: ScanSearch },
  { id: "sync-knowledge", label: "同步知识", icon: RefreshCw },
  { id: "run-evaluation", label: "运行评测", icon: FlaskConical },
];

export function QuickActions() {
  const [running, setRunning] = useState<ConsoleAction | null>(null);
  const [message, setMessage] = useState("");

  async function runAction(action: ConsoleAction) {
    setRunning(action);
    setMessage("");

    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { message?: string; detail?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.message ?? payload.error ?? "操作未完成");
      }
      setMessage(payload.message ?? payload.detail ?? "操作已提交");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="quick-action-wrap">
      <div className="quick-action-row">
        {actions.map((action, index) => {
          const Icon = action.icon;
          const isRunning = running === action.id;
          return (
            <button
              className={index === 0 ? "button button--primary" : "button button--secondary"}
              type="button"
              key={action.id}
              onClick={() => runAction(action.id)}
              disabled={running !== null}
            >
              <Icon className={isRunning ? "is-spinning" : ""} size={16} aria-hidden="true" />
              {isRunning ? "处理中" : action.label}
            </button>
          );
        })}
      </div>
      <span className="action-message" aria-live="polite">
        {message}
      </span>
    </div>
  );
}
