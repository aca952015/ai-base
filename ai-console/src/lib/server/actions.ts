import type { ConsoleAction, ConsoleConfig, ServiceSnapshot } from "../control-plane/types";
import { checkServices } from "./services";

const SUPPORTED_ACTIONS = [
  "check-health",
  "sync-knowledge",
  "run-evaluation",
] as const satisfies readonly ConsoleAction[];

export type SupportedAction = (typeof SUPPORTED_ACTIONS)[number];

export type ActionResult = {
  action: SupportedAction;
  status: "completed" | "accepted" | "skipped";
  message: string;
  startedAt: string;
  completedAt: string;
  data?: { services: ServiceSnapshot[] } | { mode: "safe-placeholder"; target: string };
};

export function parseActionRequest(input: unknown):
  | { ok: true; action: SupportedAction }
  | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const action = (input as Record<string, unknown>).action;
  return typeof action === "string" && SUPPORTED_ACTIONS.includes(action as SupportedAction)
    ? { ok: true, action: action as SupportedAction }
    : { ok: false, error: `action must be one of: ${SUPPORTED_ACTIONS.join(", ")}` };
}

export async function runAction(
  action: SupportedAction,
  config: ConsoleConfig,
): Promise<ActionResult> {
  const startedAt = new Date().toISOString();
  if (action === "check-health") {
    const services = await checkServices(config);
    return {
      action,
      status: "completed",
      message: "服务健康检查已完成",
      startedAt,
      completedAt: new Date().toISOString(),
      data: { services },
    };
  }

  const isEnabled = action === "sync-knowledge"
    ? config.services.silverbullet?.enabled !== false
    : config.services.promptfoo?.enabled !== false;
  const target = action === "sync-knowledge" ? "silverbullet" : "promptfoo";
  return {
    action,
    status: isEnabled ? "accepted" : "skipped",
    message: isEnabled
      ? "请求已记录；轻量控制面不会启动容器或执行外部命令"
      : "目标服务已禁用，未执行操作",
    startedAt,
    completedAt: new Date().toISOString(),
    data: { mode: "safe-placeholder", target },
  };
}
