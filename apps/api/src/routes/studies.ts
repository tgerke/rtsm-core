import { withActor } from "@rtsm-core/core";
import { roles, sites, studies, userStudyRoles, users } from "@rtsm-core/db";
import { studyCreateSchema, studyUpdateSchema } from "@rtsm-core/schemas";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requireAuth, requirePermission, requireSystemAdmin } from "../auth/plugin.js";
import { effectivePermissions, grantRole, revokeRole } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import {
  loadStudy,
  replyDomainError,
  requireMembership,
  serializeStudy,
  studyIdOf,
} from "./helpers.js";

export const studyRoutes: FastifyPluginAsync = async (app) => {
  // Creating a study is a deployment-administration act: there is no study
  // yet to hold a grant in.
  app.post("/studies", { preHandler: requireSystemAdmin() }, async (request, reply) => {
    const parsed = studyCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const user = request.user as AuthenticatedUser;
    const study = await withActor(
      request.server.db,
      { userId: user.id, label: user.username },
      async (tx) => {
        const [row] = await tx.insert(studies).values(parsed.data).returning();
        if (!row) throw new Error("study insert returned no row");
        return row;
      },
    );
    return reply.code(201).send(serializeStudy(study));
  });

  app.get("/studies", { preHandler: requireAuth }, async (request) => {
    const user = request.user as AuthenticatedUser;
    const db = request.server.db;
    if (user.isSystemAdmin) {
      return (await db.select().from(studies)).map(serializeStudy);
    }
    const memberships = await db
      .selectDistinct({ studyId: userStudyRoles.studyId })
      .from(userStudyRoles)
      .where(and(eq(userStudyRoles.userId, user.id), isNull(userStudyRoles.revokedAt)));
    const ids = memberships.map((m) => m.studyId);
    if (ids.length === 0) return [];
    return (await db.select().from(studies).where(inArray(studies.id, ids))).map(serializeStudy);
  });

  app.get("/studies/:studyId", { preHandler: requireMembership() }, async (request, reply) => {
    try {
      return serializeStudy(await loadStudy(request.server.db, studyIdOf(request)));
    } catch (err) {
      if (await replyDomainError(reply, err)) return;
      throw err;
    }
  });

  app.put(
    "/studies/:studyId",
    {
      preHandler: requirePermission("study.manage", (r) => ({ studyId: studyIdOf(r) }), {
        allowSystemAdmin: true,
      }),
    },
    async (request, reply) => {
      const parsed = studyUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const study = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          async (tx) => {
            const [row] = await tx
              .update(studies)
              .set({ ...parsed.data, updatedAt: new Date() })
              .where(eq(studies.id, studyIdOf(request)))
              .returning();
            if (!row) throw new Error("study update returned no row");
            return row;
          },
        );
        return serializeStudy(study);
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  // ── Role grants ────────────────────────────────────────────────────────
  // allowSystemAdmin bootstraps the first grant in a new study; after that,
  // study admins hold roles.grant themselves.

  app.post(
    "/studies/:studyId/roles",
    {
      preHandler: requirePermission("roles.grant", (r) => ({ studyId: studyIdOf(r) }), {
        allowSystemAdmin: true,
      }),
    },
    async (request, reply) => {
      const body = request.body as { username?: string; role?: string; siteId?: string };
      if (!body?.username || !body?.role) {
        return reply.code(400).send({ error: "username and role are required" });
      }
      const db = request.server.db;
      const [target] = await db.select().from(users).where(eq(users.username, body.username));
      if (!target) return reply.code(404).send({ error: "user not found" });
      const [role] = await db.select().from(roles).where(eq(roles.name, body.role));
      if (!role) return reply.code(404).send({ error: "role not found" });
      let siteCode: string | null = null;
      if (body.siteId) {
        const [site] = await db
          .select({ code: sites.code })
          .from(sites)
          .where(and(eq(sites.id, body.siteId), eq(sites.studyId, studyIdOf(request))))
          .limit(1);
        if (!site) return reply.code(404).send({ error: "site not found in this study" });
        siteCode = site.code;
      }
      const user = request.user as AuthenticatedUser;
      const grant = await grantRole(db, {
        userId: target.id,
        studyId: studyIdOf(request),
        roleId: role.id,
        ...(body.siteId ? { siteId: body.siteId } : {}),
        grantedBy: user.id,
        grantedByLabel: user.username,
      });
      return reply
        .code(201)
        .send({ id: grant.id, username: target.username, role: role.name, siteCode });
    },
  );

  app.post(
    "/studies/:studyId/roles/:grantId/revoke",
    {
      preHandler: requirePermission("roles.grant", (r) => ({ studyId: studyIdOf(r) }), {
        allowSystemAdmin: true,
      }),
    },
    async (request, reply) => {
      const user = request.user as AuthenticatedUser;
      const { grantId } = request.params as { grantId: string };
      try {
        await revokeRole(request.server.db, grantId, user.id, user.username);
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : "not found" });
      }
      return { ok: true };
    },
  );

  app.get("/studies/:studyId/permissions", { preHandler: requireMembership() }, async (request) => {
    const user = request.user as AuthenticatedUser;
    return effectivePermissions(request.server.db, user.id, { studyId: studyIdOf(request) });
  });
};
