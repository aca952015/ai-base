"use client";

import { Check, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { serviceCatalog } from "@/lib/control-plane/catalog";
import type { ConsoleConfig, ServiceId } from "@/lib/control-plane/types";

const fallbackConfig: ConsoleConfig = {
  environment: "development",
  currency: "CNY",
  monthlyBudget: 20000,
  services: Object.fromEntries(
    serviceCatalog.map((service) => [
      service.id,
      { enabled: service.id !== "promptfoo", endpoint: service.defaultEndpoint },
    ]),
  ),
  authentication: {
    wecom: {
      publicBaseUrl: "http://127.0.0.1:8080/wecom-oidc",
      callbackMode: "direct",
      emailDomain: "bluetron.cn",
    },
  },
  updatedAt: new Date(0).toISOString(),
};

export function SettingsForm() {
  const [config, setConfig] = useState(fallbackConfig);
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [message, setMessage] = useState("正在读取本地控制面配置…");

  useEffect(() => {
    let ignore = false;

    async function loadConfig() {
      try {
        const response = await fetch("/api/config", { cache: "no-store" });
        if (!response.ok) throw new Error("读取配置失败");
        const payload = (await response.json()) as { config?: ConsoleConfig };
        const nextConfig = payload.config;
        if (!ignore && nextConfig) {
          setConfig(nextConfig);
          setState("idle");
          setMessage("配置保存在控制台本地数据目录；敏感值不会回显。 ");
        }
      } catch {
        if (!ignore) {
          setState("error");
          setMessage("当前使用默认配置，保存后将创建本地配置文件。");
        }
      }
    }

    loadConfig();
    return () => {
      ignore = true;
    };
  }, []);

  function updateService(id: ServiceId, patch: { endpoint?: string; enabled?: boolean }) {
    setConfig((current) => ({
      ...current,
      services: {
        ...current.services,
        [id]: {
          enabled: current.services[id]?.enabled ?? true,
          endpoint: current.services[id]?.endpoint,
          ...patch,
        },
      },
    }));
    setState("idle");
  }

  async function saveConfig() {
    setState("saving");
    setMessage("正在验证并保存配置…");

    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environment: config.environment,
          currency: config.currency,
          monthlyBudget: config.monthlyBudget,
          services: config.services,
        }),
      });
      const payload = (await response.json()) as { config?: ConsoleConfig; message?: string };
      if (!response.ok) throw new Error(payload.message ?? "保存失败");
      if (payload.config) setConfig(payload.config);
      setState("saved");
      setMessage(payload.message ?? "配置已保存；生产发布仍需单独确认。 ");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  }

  return (
    <div className="settings-form">
      <div className="settings-grid settings-grid--general">
        <label className="field-label">
          <span>运行环境</span>
          <select
            value={config.environment}
            onChange={(event) => setConfig((current) => ({ ...current, environment: event.target.value as ConsoleConfig["environment"] }))}
          >
            <option value="development">开发环境</option>
            <option value="staging">预发环境</option>
            <option value="production">生产环境</option>
          </select>
        </label>
        <label className="field-label">
          <span>成本币种</span>
          <select
            value={config.currency}
            onChange={(event) => setConfig((current) => ({ ...current, currency: event.target.value as ConsoleConfig["currency"] }))}
          >
            <option value="CNY">人民币 CNY</option>
            <option value="USD">美元 USD</option>
          </select>
        </label>
        <label className="field-label">
          <span>月度模型预算</span>
          <input
            min="0"
            step="100"
            type="number"
            value={config.monthlyBudget}
            onChange={(event) => setConfig((current) => ({ ...current, monthlyBudget: Number(event.target.value) }))}
          />
        </label>
      </div>

      <div className="settings-service-list">
        {serviceCatalog.map((service) => {
          const serviceConfig = config.services[service.id] ?? { enabled: false, endpoint: service.defaultEndpoint };
          return (
            <div className="settings-service-row" key={service.id} id={`service-${service.id}`}>
              <div className="settings-service-copy">
                <strong>{service.name}</strong>
                <span>{service.product} · {service.description}</span>
              </div>
              <label className="field-label field-label--endpoint">
                <span className="sr-only">{service.name}端点</span>
                <input
                  type="url"
                  placeholder={service.defaultEndpoint ?? "由环境变量提供"}
                  value={serviceConfig.endpoint ?? ""}
                  disabled={!service.endpointEnv || !serviceConfig.enabled}
                  onChange={(event) => updateService(service.id, { endpoint: event.target.value })}
                />
              </label>
              <label className="switch-control">
                <input
                  type="checkbox"
                  checked={serviceConfig.enabled}
                  onChange={(event) => updateService(service.id, { enabled: event.target.checked })}
                />
                <span aria-hidden="true" />
                <span className="sr-only">启用{service.name}</span>
              </label>
            </div>
          );
        })}
      </div>

      <div className="settings-footer">
        <p aria-live="polite" className={state === "error" ? "form-message form-message--error" : "form-message"}>
          {state === "saved" ? <Check size={15} aria-hidden="true" /> : null}
          {message}
        </p>
        <button className="button button--primary" type="button" onClick={saveConfig} disabled={state === "saving" || state === "loading"}>
          <Save size={16} aria-hidden="true" />
          {state === "saving" ? "保存中" : "保存草稿"}
        </button>
      </div>
    </div>
  );
}
