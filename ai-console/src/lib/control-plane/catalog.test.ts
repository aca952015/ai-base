import { describe, expect, it } from "vitest";

import { getServiceDefinition, serviceCatalog } from "./catalog";

describe("service catalog", () => {
  it("keeps service identifiers unique", () => {
    const ids = serviceCatalog.map((service) => service.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains the external connector and knowledge workbench", () => {
    expect(getServiceDefinition("open-connector")?.product).toBe("Open Connector");
    expect(getServiceDefinition("silverbullet")?.product).toBe("SilverBullet");
  });
});
