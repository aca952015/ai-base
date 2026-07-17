import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { readConfig } from "@/lib/server/config";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const config = await readConfig();
  return <AppShell environment={config.environment}>{children}</AppShell>;
}
