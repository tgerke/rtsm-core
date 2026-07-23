import { type Permission, withActor } from "@rtsm-core/core";
import { type Db, rolePermissions, userStudyRoles } from "@rtsm-core/db";
import { and, eq, isNull } from "drizzle-orm";

export interface PermissionScope {
  studyId: string;
}

/**
 * A user holds a permission in a study when any unrevoked role grant for that
 * study carries it. System admins do NOT implicitly hold trial capabilities —
 * deliberate: administering the system must not entitle anyone to randomize
 * subjects or read arms (P11-04, and the blinding split in ADR-0003).
 * Grants are study-wide; rtsm-core has no site scoping in v0.1.
 */
export async function hasPermission(
  db: Db,
  userId: string,
  permission: Permission,
  scope: PermissionScope,
): Promise<boolean> {
  const rows = await db
    .select({ roleId: userStudyRoles.roleId })
    .from(userStudyRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userStudyRoles.roleId))
    .where(
      and(
        eq(userStudyRoles.userId, userId),
        eq(userStudyRoles.studyId, scope.studyId),
        isNull(userStudyRoles.revokedAt),
        eq(rolePermissions.permission, permission),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * All permissions the user's unrevoked grants confer in the study. Serves the
 * UI's action gating; route guards still call hasPermission — this is
 * advisory, never authorization.
 */
export async function effectivePermissions(
  db: Db,
  userId: string,
  scope: PermissionScope,
): Promise<Permission[]> {
  const rows = await db
    .selectDistinct({ permission: rolePermissions.permission })
    .from(userStudyRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userStudyRoles.roleId))
    .where(
      and(
        eq(userStudyRoles.userId, userId),
        eq(userStudyRoles.studyId, scope.studyId),
        isNull(userStudyRoles.revokedAt),
      ),
    );
  return rows.map((r) => r.permission as Permission).sort();
}

/** Membership = any unrevoked role grant in the study (read visibility). */
export async function isStudyMember(db: Db, userId: string, studyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: userStudyRoles.id })
    .from(userStudyRoles)
    .where(
      and(
        eq(userStudyRoles.userId, userId),
        eq(userStudyRoles.studyId, studyId),
        isNull(userStudyRoles.revokedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Grant and revocation are trigger-audited via withActor. */
export async function grantRole(
  db: Db,
  grant: {
    userId: string;
    studyId: string;
    roleId: string;
    grantedBy: string;
    grantedByLabel: string;
  },
) {
  return withActor(db, { userId: grant.grantedBy, label: grant.grantedByLabel }, async (tx) => {
    const [row] = await tx
      .insert(userStudyRoles)
      .values({
        userId: grant.userId,
        studyId: grant.studyId,
        roleId: grant.roleId,
        grantedBy: grant.grantedBy,
      })
      .returning();
    if (!row) throw new Error("role grant insert returned no row");
    return row;
  });
}

export async function revokeRole(
  db: Db,
  grantId: string,
  revokedBy: string,
  revokedByLabel: string,
): Promise<void> {
  await withActor(db, { userId: revokedBy, label: revokedByLabel }, async (tx) => {
    const [row] = await tx
      .update(userStudyRoles)
      .set({ revokedAt: new Date() })
      .where(and(eq(userStudyRoles.id, grantId), isNull(userStudyRoles.revokedAt)))
      .returning();
    if (!row) throw new Error("role grant not found or already revoked");
  });
}
