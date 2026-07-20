import { describe, expect, it } from "vitest";

import { serviceCatalog } from "./catalog";
import { getPortalEntry, portalEntries } from "./portal";

describe("component portal", () => {
  it("exposes every service exactly once", () => {
    const serviceIds = serviceCatalog.map((service) => service.id).sort();
    const portalIds = portalEntries.map((entry) => entry.id).sort();

    expect(portalIds).toEqual(serviceIds);
    expect(new Set(portalIds).size).toBe(portalIds.length);
  });

  it("provides a management route for every component", () => {
    for (const entry of portalEntries) {
      expect(entry.managePath).toMatch(/^\//);
      expect(entry.manageLabel.length).toBeGreaterThan(0);
    }
  });

  it("opens Open Connector through the local portal endpoint", () => {
    expect(getPortalEntry("open-connector")?.workspaceUrl).toBe("https://open-connector.localhost.pomerium.io:8443");
  });

  it("routes every public workspace through the global gateway ports", () => {
    for (const entry of portalEntries) {
      if (!entry.workspaceUrl) continue;
      const url = new URL(entry.workspaceUrl);
      expect(["8080", "8443"]).toContain(url.port);
    }
  });
});
