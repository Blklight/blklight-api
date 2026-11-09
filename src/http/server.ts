import { buildApp } from "../app";
import { env } from "../config/env";
import { closeDb } from "../db";
import { startEmailQueue } from "../features/email/email.service";
import { startTicketCleanup } from "../features/chat/ws-tickets";
import { features } from "../config/features";

async function start() {
  const app = await buildApp();

  let stopTicketCleanup: (() => void) | undefined;

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    stopTicketCleanup?.();
    await app.close();
    // Close the DB pool last: in-flight request queries must finish before we
    // release the pooled connections.
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`Server running at http://localhost:${env.PORT}`);
    if (env.NODE_ENV !== "production") {
      app.log.info(`API docs available at http://localhost:${env.PORT}/docs`);
    }

    stopTicketCleanup = startTicketCleanup();

    app.log.info(`Environment: ${env.NODE_ENV}`);
    if (features.emailQueue) {
      startEmailQueue();
      app.log.info("Email queue started");
    }

    const enabledFeatures = Object.entries(features)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ");
    app.log.info(`Features enabled: ${enabledFeatures || "none"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
