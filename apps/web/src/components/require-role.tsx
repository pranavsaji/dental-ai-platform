"use client";

import { useApp } from "@/components/shell";
import { Card, Empty, PageTitle } from "@/components/ui";

// Page-level RBAC guard. Cosmetic only — every API endpoint re-checks the
// same matrix (apps/api/src/auth/roles.ts); this just replaces a wall of
// 403 toasts with a clear empty state when a URL is opened directly.
export function RequireRole({
  roles,
  kicker,
  title,
  children
}: {
  roles: string[];
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  const { user } = useApp();
  if (!roles.includes(user.role)) {
    return (
      <>
        <PageTitle kicker={kicker} title={title} />
        <Card>
          <Empty text={`This page requires the ${roles.join(" or ")} role (you are ${user.role}).`} />
        </Card>
      </>
    );
  }
  return <>{children}</>;
}
