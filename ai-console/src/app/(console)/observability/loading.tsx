export default function ObservabilityLoading() {
  return <div className="page-stack" aria-live="polite" aria-busy="true">
    <div className="observability-loading-block observability-loading-block--header"><span>正在读取模型与 MCP 观测数据…</span></div>
    <section className="metric-grid" aria-label="正在读取指标">
      {Array.from({ length: 4 }, (_, index) => <div className="observability-loading-block observability-loading-block--metric" key={index} />)}
    </section>
    <div className="observability-loading-block observability-loading-block--table" />
    <div className="observability-loading-block observability-loading-block--table" />
  </div>;
}
