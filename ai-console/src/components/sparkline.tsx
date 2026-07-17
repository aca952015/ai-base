export function Sparkline({
  values,
  tone = "teal",
  label,
}: {
  values: number[];
  tone?: "teal" | "amber" | "blue";
  label: string;
}) {
  const width = 132;
  const height = 38;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 6) - 3;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      className={`sparkline sparkline--${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
