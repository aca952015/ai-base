"use client";

import { ExternalLink, RefreshCw, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { ServiceSnapshot } from "@/lib/control-plane/types";

import { StatusPill } from "./status-pill";

export function LiveServiceTable({ initialServices }: { initialServices: ServiceSnapshot[] }) {
  const [services, setServices] = useState(initialServices);
  const [isChecking, setIsChecking] = useState(false);
  const [message, setMessage] = useState("显示最近一次检测结果");

  async function checkAll() {
    setIsChecking(true);
    setMessage("正在检测全部服务…");
    setServices((current) => current.map((service) => ({ ...service, status: "checking" })));

    try {
      const response = await fetch("/api/services", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`健康检查失败（${response.status}）`);
      }

      const payload = (await response.json()) as ServiceSnapshot[] | { services?: ServiceSnapshot[] };
      const nextServices = Array.isArray(payload) ? payload : payload.services;

      if (!nextServices?.length) {
        throw new Error("健康检查未返回服务状态");
      }

      setServices(nextServices);
      setMessage(`已于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 完成检测`);
    } catch (error) {
      setServices(initialServices);
      setMessage(error instanceof Error ? error.message : "健康检查失败");
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <div>
      <div className="table-toolbar">
        <span aria-live="polite">{message}</span>
        <button className="text-button" type="button" onClick={checkAll} disabled={isChecking}>
          <RefreshCw className={isChecking ? "is-spinning" : ""} size={15} aria-hidden="true" />
          {isChecking ? "检测中" : "检测全部"}
        </button>
      </div>

      <div className="table-scroll">
        <table className="data-table service-table">
          <thead>
            <tr>
              <th scope="col">服务</th>
              <th scope="col">状态</th>
              <th scope="col">运行信息</th>
              <th scope="col">延迟</th>
              <th scope="col" aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              <tr key={service.id}>
                <td data-label="服务">
                  <div className="service-identity">
                    <strong>{service.name}</strong>
                    <span>{service.product}</span>
                  </div>
                </td>
                <td data-label="状态">
                  <StatusPill status={service.status} compact />
                </td>
                <td data-label="运行信息">
                  <span className="cell-primary">{service.detail}</span>
                  <span className="cell-secondary cell-mono">{service.endpoint ?? "未设置端点"}</span>
                </td>
                <td data-label="延迟">
                  <span className="cell-mono">{service.latencyMs ? `${service.latencyMs} ms` : "—"}</span>
                </td>
                <td className="table-actions">
                  <Link className="icon-button" href={`/settings#service-${service.id}`} aria-label={`配置${service.name}`}>
                    <SlidersHorizontal size={16} />
                  </Link>
                  <a className="icon-button" href={service.docsUrl} target="_blank" rel="noreferrer" aria-label={`打开${service.product}文档`}>
                    <ExternalLink size={16} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
