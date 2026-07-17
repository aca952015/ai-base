import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleOff,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";

import type { ServiceStatus } from "@/lib/control-plane/types";

const labels: Record<ServiceStatus, string> = {
  healthy: "运行正常",
  degraded: "需要关注",
  offline: "服务离线",
  unconfigured: "尚未配置",
  idle: "按需运行",
  checking: "检测中",
};

const icons = {
  healthy: CircleCheck,
  degraded: TriangleAlert,
  offline: CircleOff,
  unconfigured: CircleMinus,
  idle: CircleDashed,
  checking: LoaderCircle,
};

export function StatusPill({ status, compact = false }: { status: ServiceStatus; compact?: boolean }) {
  const Icon = icons[status];

  return (
    <span className={`status-pill status-pill--${status}${compact ? " status-pill--compact" : ""}`}>
      <Icon size={compact ? 13 : 14} aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
