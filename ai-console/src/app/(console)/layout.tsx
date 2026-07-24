import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { getConsoleIdentity } from "@/lib/server/console-identity";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const identity = await getConsoleIdentity();
  return (
    <AppShell identity={{
      name: identity.name,
      email: identity.email,
      isAdmin: identity.isAdmin,
    }}>
      {children}
    </AppShell>
  );
}
