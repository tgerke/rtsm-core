import { createDb, type Db } from "@rtsm-core/db";
import { healthResponseSchema } from "@rtsm-core/schemas";
import Fastify, { type FastifyInstance } from "fastify";
import type { AuthConfig } from "./auth/config.js";
import { authPlugin } from "./auth/plugin.js";
import { auditRoutes } from "./routes/audit.js";
import { codeBreakRoutes } from "./routes/codebreak.js";
import { deliveryRoutes } from "./routes/deliveries.js";
import { depotRoutes } from "./routes/depots.js";
import { dispenseRoutes } from "./routes/dispense.js";
import { kitRoutes } from "./routes/kits.js";
import { listRoutes } from "./routes/lists.js";
import { randomizeRoutes } from "./routes/randomize.js";
import { resupplyRoutes } from "./routes/resupply.js";
import { shipmentRoutes } from "./routes/shipments.js";
import { siteRoutes } from "./routes/sites.js";
import { studyRoutes } from "./routes/studies.js";

export const API_VERSION = "0.3.0";

export interface BuildServerOptions {
  db?: Db;
  authConfig?: AuthConfig;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: process.env.NODE_ENV !== "test" });

  let db = opts.db;
  if (!db) {
    // Runtime traffic uses the DML-only rtsm_app role (APP_DATABASE_URL);
    // migrations run separately as the owner.
    const created = createDb();
    db = created.db;
    server.addHook("onClose", async () => {
      await created.client.end();
    });
  }

  await server.register(authPlugin, {
    db,
    ...(opts.authConfig ? { config: opts.authConfig } : {}),
  });
  await server.register(studyRoutes);
  await server.register(siteRoutes);
  await server.register(kitRoutes);
  await server.register(depotRoutes);
  await server.register(shipmentRoutes);
  await server.register(resupplyRoutes);
  await server.register(dispenseRoutes);
  await server.register(listRoutes);
  await server.register(randomizeRoutes);
  await server.register(codeBreakRoutes);
  await server.register(deliveryRoutes);
  await server.register(auditRoutes);

  server.get("/health", async () => {
    return healthResponseSchema.parse({
      status: "ok",
      service: "rtsm-core-api",
      version: API_VERSION,
      time: new Date().toISOString(),
    });
  });

  return server;
}
