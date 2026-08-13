"use client";

import { TriangleAlert } from "lucide-react";

export default function ObservabilityError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="empty-data empty-data--large" role="alert">
    <TriangleAlert size={22} aria-hidden="true" />
    <strong>可观测查询暂时不可用</strong>
    <span>Trace 或 Metrics 服务未响应。现有业务流量不受影响，可以稍后重试。</span>
    <button className="button button--secondary" type="button" onClick={reset}>重新查询</button>
  </div>;
}
