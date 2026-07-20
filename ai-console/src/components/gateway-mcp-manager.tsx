"use client";

import {
  Blocks,
  CheckCircle2,
  FlaskConical,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Save,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SectionCard } from "@/components/section-card";
import type {
  GatewayMcpServer,
  GatewayMcpServerDraft,
  GatewayMcpServersSnapshot,
  GatewayMcpServerTestResult,
} from "@/lib/control-plane/mcp";

type RequestState = "idle" | "saving" | "saved" | "error";
type EditableMcpServer = Omit<GatewayMcpServer, "toolIncludes" | "toolExcludes"> & {
  toolIncludesText: string;
  toolExcludesText: string;
  apiKey: string;
  removeApiKey: boolean;
};

function parseLines(value: string) {
  return Array.from(new Set(value.split("\n").map((line) => line.trim()).filter(Boolean)));
}

function toEditable(server: GatewayMcpServer): EditableMcpServer {
  return {
    ...server,
    toolIncludesText: server.toolIncludes.join("\n"),
    toolExcludesText: server.toolExcludes.join("\n"),
    apiKey: "",
    removeApiKey: false,
  };
}

function toDraft(server: EditableMcpServer): GatewayMcpServerDraft {
  return {
    id: server.id,
    name: server.name,
    namespace: server.namespace,
    url: server.url,
    enabled: server.enabled,
    authHeader: server.authHeader,
    toolIncludes: parseLines(server.toolIncludesText),
    toolExcludes: parseLines(server.toolExcludesText),
    apiKey: server.apiKey || undefined,
    removeApiKey: server.removeApiKey,
  };
}

export function GatewayMcpManager({ initialServers }: { initialServers: GatewayMcpServer[] }) {
  const [servers, setServers] = useState<EditableMcpServer[]>(() => initialServers.map(toEditable));
  const [editingServer, setEditingServer] = useState<EditableMcpServer>();
  const [isCreatingServer, setIsCreatingServer] = useState(false);
  const [state, setState] = useState<RequestState>("idle");
  const [message, setMessage] = useState("");
  const [testingId, setTestingId] = useState<string>();
  const [toolsLoadingId, setToolsLoadingId] = useState<string>();
  const [testResults, setTestResults] = useState<Record<string, GatewayMcpServerTestResult>>({});
  const [toolsServer, setToolsServer] = useState<EditableMcpServer>();
  const [toolsResult, setToolsResult] = useState<GatewayMcpServerTestResult>();
  const drawerRef = useRef<HTMLElement>(null);
  const toolsRequestIdRef = useRef(0);
  const editingId = editingServer?.id;
  const activeDrawerId = editingId ? `editor:${editingId}` : toolsServer ? `tools:${toolsServer.id}` : undefined;
  const summary = useMemo(() => ({
    enabled: servers.filter((server) => server.enabled).length,
    filtered: servers.filter((server) => parseLines(server.toolIncludesText).length > 0 || parseLines(server.toolExcludesText).length > 0).length,
  }), [servers]);

  const closeEditor = useCallback(() => {
    setEditingServer(undefined);
    setIsCreatingServer(false);
  }, []);

  const closeTools = useCallback(() => {
    toolsRequestIdRef.current += 1;
    setToolsServer(undefined);
    setToolsResult(undefined);
    setToolsLoadingId(undefined);
  }, []);

  const closeActiveDrawer = useCallback(() => {
    closeEditor();
    closeTools();
  }, [closeEditor, closeTools]);

  useEffect(() => {
    let ignore = false;
    async function loadServers() {
      try {
        const response = await fetch("/api/llm-gateway/mcp-servers", { cache: "no-store" });
        if (!response.ok) throw new Error("读取 MCP 配置失败");
        const snapshot = await response.json() as GatewayMcpServersSnapshot;
        if (!ignore) {
          setServers(snapshot.servers.map(toEditable));
          setState("idle");
          setMessage("");
        }
      } catch (error) {
        if (!ignore) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "读取 MCP 配置失败");
        }
      }
    }
    loadServers();
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    if (!activeDrawerId) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>("[data-drawer-autofocus]")?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeActiveDrawer();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]",
      ));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [activeDrawerId, closeActiveDrawer]);

  function updateServer(id: string, patch: Partial<EditableMcpServer>) {
    if (editingServer?.id === id) {
      setEditingServer((current) => current?.id === id ? { ...current, ...patch } : current);
    } else {
      setServers((current) => current.map((server) => server.id === id ? { ...server, ...patch } : server));
    }
    setState("idle");
  }

  function addServer() {
    const now = new Date().toISOString();
    const suffix = crypto.randomUUID().slice(0, 8);
    setEditingServer({
      id: `mcp-${crypto.randomUUID()}`,
      name: "新 MCP 服务",
      namespace: `server-${suffix}`,
      url: "https://example.com/mcp",
      enabled: true,
      managed: false,
      authHeader: "Authorization",
      toolIncludesText: "",
      toolExcludesText: "",
      apiKey: "",
      removeApiKey: false,
      keyConfigured: false,
      createdAt: now,
      updatedAt: now,
    });
    setIsCreatingServer(true);
    closeTools();
    setState("idle");
    setMessage("");
  }

  function removeServer(id: string) {
    if (servers.some((server) => server.id === id && server.managed)) return;
    setServers((current) => current.filter((server) => server.id !== id));
    if (editingId === id) closeEditor();
    setState("idle");
    setMessage("MCP 服务已从草稿移除；保存后 Envoy AI 配置才会更新。");
  }

  function currentServers() {
    if (!editingServer) return servers;
    return isCreatingServer
      ? [...servers, editingServer]
      : servers.map((server) => server.id === editingServer.id ? editingServer : server);
  }

  async function saveServers() {
    setState("saving");
    setMessage("正在验证 MCP 服务并生成 Envoy AI 配置…");
    try {
      const response = await fetch("/api/llm-gateway/mcp-servers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ servers: currentServers().filter((server) => !server.managed).map(toDraft) }),
      });
      const payload = await response.json() as GatewayMcpServersSnapshot & { message?: string; error?: string; details?: string[] };
      if (!response.ok) throw new Error(payload.details?.join("；") || payload.error || "保存 MCP 配置失败");
      setServers(payload.servers.map(toEditable));
      setEditingServer(undefined);
      setIsCreatingServer(false);
      setState("saved");
      setMessage(payload.message || "MCP 配置已保存，Envoy AI 正在自动重载。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "保存 MCP 配置失败");
    }
  }

  async function testServer(server: EditableMcpServer) {
    setTestingId(server.id);
    setTestResults((current) => {
      const next = { ...current };
      delete next[server.id];
      return next;
    });
    try {
      const response = await fetch("/api/llm-gateway/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server: toDraft(server) }),
      });
      const payload = await response.json() as GatewayMcpServerTestResult & { error?: string; details?: string[] };
      if (!response.ok) throw new Error(payload.details?.join("；") || payload.error || "连接测试失败");
      setTestResults((current) => ({ ...current, [server.id]: payload }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [server.id]: {
          ok: false,
          latencyMs: 0,
          message: error instanceof Error ? error.message : "连接测试失败",
          discoveredTools: [],
          tools: [],
        },
      }));
    } finally {
      setTestingId(undefined);
    }
  }

  async function openTools(server: EditableMcpServer) {
    const requestId = toolsRequestIdRef.current + 1;
    toolsRequestIdRef.current = requestId;
    closeEditor();
    setToolsServer(server);
    setToolsResult(undefined);
    setToolsLoadingId(server.id);
    try {
      const response = await fetch("/api/llm-gateway/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server: toDraft(server) }),
      });
      const payload = await response.json() as GatewayMcpServerTestResult & { error?: string; details?: string[] };
      if (!response.ok) throw new Error(payload.details?.join("；") || payload.error || "工具列表读取失败");
      if (toolsRequestIdRef.current === requestId) setToolsResult(payload);
      setTestResults((current) => ({ ...current, [server.id]: payload }));
    } catch (error) {
      const result: GatewayMcpServerTestResult = {
        ok: false,
        latencyMs: 0,
        message: error instanceof Error ? error.message : "工具列表读取失败",
        discoveredTools: [],
        tools: [],
      };
      if (toolsRequestIdRef.current === requestId) setToolsResult(result);
      setTestResults((current) => ({ ...current, [server.id]: result }));
    } finally {
      if (toolsRequestIdRef.current === requestId) setToolsLoadingId(undefined);
    }
  }

  return (
    <>
      <section className="model-gateway-summary" aria-label="MCP 网关摘要">
        <article>
          <span><Blocks size={17} /></span>
          <div><strong>{servers.length}</strong><small>个 MCP 服务 · {summary.enabled} 个启用</small></div>
        </article>
        <article>
          <span><Route size={17} /></span>
          <div><strong>/mcp</strong><small>统一入口 · {summary.filtered} 个服务限制工具</small></div>
        </article>
      </section>

      <SectionCard
        title="MCP 服务管理"
        action={(
          <button className="button button--secondary" type="button" onClick={addServer} disabled={state === "saving"}>
            <Plus size={15} aria-hidden="true" />添加 MCP 服务
          </button>
        )}
      >
        <div className="gateway-channel-manager">
          {message ? (
            <p className={`gateway-channel-message${state === "error" ? " is-error" : ""}`} aria-live="polite">
              {state === "saved" ? <CheckCircle2 size={15} aria-hidden="true" /> : null}{message}
            </p>
          ) : null}

          <div className="gateway-channel-grid">
            {servers.map((server) => {
              const includes = parseLines(server.toolIncludesText);
              const excludes = parseLines(server.toolExcludesText);
              const testResult = testResults[server.id];
              return (
                <article className={`gateway-channel-tile${server.enabled ? " is-enabled" : ""}${server.managed ? " is-system-managed" : ""}`} key={server.id}>
                  <div className="gateway-channel-tile__top">
                    <span className="gateway-channel-tile__icon" aria-hidden="true"><Blocks size={18} /></span>
                    <div><strong>{server.name || "未命名 MCP 服务"}</strong><small>{server.namespace}__*</small></div>
                    <span className={`gateway-channel-state${server.managed ? " is-managed" : server.enabled ? " is-enabled" : ""}`}>{server.managed ? "系统内置" : server.enabled ? "参与聚合" : "已停用"}</span>
                  </div>

                  <p className="gateway-channel-endpoint" title={server.url}>{server.url}</p>

                  <div className="gateway-channel-metrics">
                    <span><strong>{includes.length || "全部"}</strong>{includes.length ? " 个允许工具" : " 工具"}</span>
                    <span>{server.keyConfigured && !server.removeApiKey ? <CheckCircle2 size={13} /> : <KeyRound size={13} />}{server.managed ? server.keyConfigured ? "Runtime Token 已托管" : "未配置 Runtime Token" : server.keyConfigured && !server.removeApiKey ? "密钥已保存" : "无固定密钥"}</span>
                  </div>

                  <div className="gateway-model-tags" aria-label="工具过滤">
                    {server.managed ? <em>由 AI Base 自动接入，配置只读</em> : (
                      <>
                        {includes.slice(0, 3).map((tool) => <span key={tool}>{tool}</span>)}
                        {includes.length > 3 ? <span>+{includes.length - 3}</span> : null}
                        {includes.length === 0 ? <em>公开上游全部工具{excludes.length ? `，排除 ${excludes.length} 个` : ""}</em> : null}
                      </>
                    )}
                  </div>

                  {testResult ? <p className={`gateway-test-result${testResult.ok ? " is-success" : " is-error"}`} role="status">{testResult.message}{testResult.latencyMs ? ` · ${testResult.latencyMs} ms` : ""}</p> : null}

                  <div className="gateway-channel-tile__actions">
                    {server.managed ? <span className="gateway-managed-lock"><LockKeyhole size={13} />只读配置</span> : (
                      <label className="switch-control">
                        <input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(server.id, { enabled: event.target.checked })} />
                        <span aria-hidden="true" />
                        <span className="sr-only">启用{server.name}</span>
                      </label>
                    )}
                    <button className="button button--secondary" type="button" onClick={() => openTools(server)} disabled={toolsLoadingId === server.id}>
                      {toolsLoadingId === server.id ? <RefreshCw className="is-spinning" size={14} /> : <Wrench size={14} />}
                      {toolsLoadingId === server.id ? "加载中" : "工具"}
                    </button>
                    <button className="button button--secondary" type="button" onClick={() => testServer(server)} disabled={testingId === server.id}>
                      {testingId === server.id ? <RefreshCw className="is-spinning" size={14} /> : <FlaskConical size={14} />}
                      {testingId === server.id ? "测试中" : "测试"}
                    </button>
                    {!server.managed ? <button className="button button--secondary" type="button" onClick={() => { setEditingServer({ ...server }); setIsCreatingServer(false); }}><Pencil size={14} />编辑</button> : null}
                    {!server.managed ? <button className="gateway-remove-button" type="button" onClick={() => removeServer(server.id)} aria-label={`移除${server.name}`}><Trash2 size={15} /></button> : null}
                  </div>
                </article>
              );
            })}

            <button className="gateway-channel-add-card" type="button" onClick={addServer} disabled={state === "saving"}>
              <span><Plus size={19} aria-hidden="true" /></span>
              <strong>{servers.length === 0 ? "添加第一个 MCP 服务" : "添加 MCP 服务"}</strong>
              <small>接入 Streamable HTTP MCP 服务</small>
            </button>
          </div>

          {toolsServer ? (
            <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTools(); }}>
              <aside className="gateway-channel-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="gateway-mcp-tools-title">
                <div className="gateway-channel-editor__header">
                  <div>
                    <span className="card-kicker">MCP 工具</span>
                    <h3 id="gateway-mcp-tools-title">{toolsServer.name || "未命名 MCP 服务"}</h3>
                    <p>从上游实时读取，只读展示当前服务公开的全部工具。</p>
                  </div>
                  <button type="button" data-drawer-autofocus onClick={closeTools} aria-label="关闭工具列表"><X size={17} /></button>
                </div>

                <div className="gateway-channel-drawer__body gateway-mcp-tools-drawer">
                  <div className="gateway-mcp-tools-summary">
                    <span><Wrench size={15} />工具列表</span>
                    <strong>{toolsResult?.ok ? toolsResult.tools.length : "—"}</strong>
                  </div>

                  {toolsLoadingId === toolsServer.id ? (
                    <div className="gateway-mcp-tools-state"><RefreshCw className="is-spinning" size={18} /><strong>正在读取工具</strong><p>正在连接 MCP 服务并获取完整工具列表…</p></div>
                  ) : toolsResult && !toolsResult.ok ? (
                    <div className="gateway-mcp-tools-state is-error"><Wrench size={18} /><strong>工具读取失败</strong><p>{toolsResult.message}</p></div>
                  ) : toolsResult?.tools.length ? (
                    <div className="gateway-mcp-tool-list">
                      {toolsResult.tools.map((tool, index) => (
                        <article key={tool.name}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <div><strong>{tool.name}</strong><p>{tool.description || "暂无工具说明"}</p></div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="gateway-mcp-tools-state"><Wrench size={18} /><strong>暂无工具</strong><p>该 MCP 服务当前没有公开可用工具。</p></div>
                  )}
                </div>

                <div className="gateway-channel-editor__footer gateway-mcp-tools-footer">
                  <span>{toolsResult?.ok ? `${toolsResult.message} · ${toolsResult.latencyMs} ms` : toolsServer.url}</span>
                  <button className="button button--secondary" type="button" onClick={() => openTools(toolsServer)} disabled={toolsLoadingId === toolsServer.id}>
                    <RefreshCw className={toolsLoadingId === toolsServer.id ? "is-spinning" : undefined} size={14} />刷新
                  </button>
                  <button className="button button--primary" type="button" onClick={closeTools}>关闭</button>
                </div>
              </aside>
            </div>
          ) : null}

          {editingServer ? (
            <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
              <aside className="gateway-channel-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="gateway-mcp-editor-title">
                <div className="gateway-channel-editor__header">
                  <div><span className="card-kicker">MCP 配置</span><h3 id="gateway-mcp-editor-title">{isCreatingServer ? "新增 MCP 服务" : `编辑 ${editingServer.name || "未命名 MCP 服务"}`}</h3><p>{isCreatingServer ? "保存并应用成功后，服务才会加入列表。" : "修改会保留在当前草稿中，保存后应用到 Envoy AI。"}</p></div>
                  <button type="button" data-drawer-autofocus onClick={closeEditor} aria-label="关闭 MCP 编辑"><X size={17} /></button>
                </div>

                <div className="gateway-channel-drawer__body">
                  <div className="gateway-channel-fields">
                    <label className="field-label"><span>服务名称</span><input value={editingServer.name} onChange={(event) => updateServer(editingServer.id, { name: event.target.value })} /></label>
                    <label className="field-label"><span>工具命名空间</span><input className="mono-input" value={editingServer.namespace} onChange={(event) => updateServer(editingServer.id, { namespace: event.target.value.toLowerCase() })} /></label>
                    <label className="field-label gateway-channel-field--wide"><span>上游 MCP URL</span><input className="mono-input" type="url" value={editingServer.url} onChange={(event) => updateServer(editingServer.id, { url: event.target.value })} /></label>
                    <label className="field-label"><span>密钥请求头</span><input className="mono-input" value={editingServer.authHeader} onChange={(event) => updateServer(editingServer.id, { authHeader: event.target.value })} /></label>
                    <label className="field-label"><span>API Key（可选）</span><input type="password" autoComplete="new-password" placeholder={editingServer.keyConfigured && !editingServer.removeApiKey ? "已配置；留空保持不变" : "公开服务可留空"} value={editingServer.apiKey} onChange={(event) => updateServer(editingServer.id, { apiKey: event.target.value, removeApiKey: false })} /></label>
                    <label className="field-label gateway-channel-field--wide"><span>允许工具（每行一个，留空表示全部）</span><textarea rows={5} placeholder={"search\nget_document"} value={editingServer.toolIncludesText} onChange={(event) => updateServer(editingServer.id, { toolIncludesText: event.target.value })} /></label>
                    <label className="field-label gateway-channel-field--wide"><span>排除工具（每行一个）</span><textarea rows={5} placeholder={"delete_document\nadmin_reset"} value={editingServer.toolExcludesText} onChange={(event) => updateServer(editingServer.id, { toolExcludesText: event.target.value })} /></label>
                  </div>

                  <div className="gateway-channel-drawer__secret">
                    <div className="gateway-key-state">
                      {editingServer.keyConfigured && !editingServer.removeApiKey ? <><CheckCircle2 size={14} />服务端已保存密钥</> : <><KeyRound size={14} />未保存固定密钥</>}
                      {editingServer.keyConfigured ? <button type="button" onClick={() => updateServer(editingServer.id, { removeApiKey: !editingServer.removeApiKey, apiKey: "" })}>{editingServer.removeApiKey ? "撤销清除" : "清除密钥"}</button> : null}
                    </div>
                    {testResults[editingServer.id] ? <p className={`gateway-test-result${testResults[editingServer.id].ok ? " is-success" : " is-error"}`} role="status">{testResults[editingServer.id].message}</p> : null}
                  </div>
                </div>

                <div className="gateway-channel-editor__footer">
                  <button className="button button--secondary" type="button" onClick={() => testServer(editingServer)} disabled={testingId === editingServer.id}>
                    {testingId === editingServer.id ? <RefreshCw className="is-spinning" size={14} /> : <FlaskConical size={14} />}{testingId === editingServer.id ? "测试中" : "测试连接"}
                  </button>
                  <button className="button button--secondary" type="button" onClick={closeEditor}>{isCreatingServer ? "取消" : "收起"}</button>
                  <button className="button button--primary" type="button" onClick={saveServers} disabled={state === "saving"}>
                    <Save size={14} />{state === "saving" ? "保存中" : isCreatingServer ? "添加并应用" : "保存并应用"}
                  </button>
                </div>
              </aside>
            </div>
          ) : null}

          <div className="settings-footer gateway-channel-savebar">
            <button className="button button--primary" type="button" onClick={saveServers} disabled={state === "saving"}>
              <Save size={15} aria-hidden="true" />{state === "saving" ? "保存并应用中" : "保存并应用 MCP 配置"}
            </button>
          </div>
        </div>
      </SectionCard>
    </>
  );
}
