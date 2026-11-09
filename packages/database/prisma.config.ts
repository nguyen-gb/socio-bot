import { defineConfig } from "prisma/config";

const command = process.argv[2];
const offlineCommands = new Set(["format", "generate", "validate"]);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl && !offlineCommands.has(command)) {
  throw new Error(`DATABASE_URL is required for prisma ${command ?? "command"}`);
}

const resolvedDatabaseUrl =
  databaseUrl ?? "postgresql://schema:validation@localhost:5432/schema";
process.env.DATABASE_URL = resolvedDatabaseUrl;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  engine: "classic",
  datasource: {
    // Schema-only commands still parse the datasource but never connect to it.
    url: resolvedDatabaseUrl,
  },
});
