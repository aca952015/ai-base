import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export function MetricCard({
  label,
  value,
  detail,
  trend,
  trendDirection = "flat",
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  trend: string;
  trendDirection?: "up" | "down" | "flat";
  icon: LucideIcon;
  tone?: "default" | "positive" | "warning";
}) {
  const TrendIcon = trendDirection === "up" ? ArrowUpRight : trendDirection === "down" ? ArrowDownRight : Minus;

  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__topline">
        <span>{label}</span>
        <span className="metric-card__icon">
          <Icon size={17} aria-hidden="true" />
        </span>
      </div>
      <div className="metric-card__value">{value}</div>
      <div className="metric-card__footer">
        <span className={`metric-trend metric-trend--${trendDirection}`}>
          <TrendIcon size={14} aria-hidden="true" />
          {trend}
        </span>
        <span>{detail}</span>
      </div>
    </article>
  );
}
