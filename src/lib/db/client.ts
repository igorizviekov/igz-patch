import postgres from "postgres";

import { requiredEnv } from "@/lib/env";

let sqlClient: postgres.Sql | null = null;

export function getSql(): postgres.Sql {
  if (!sqlClient) {
    sqlClient = postgres(requiredEnv("DATABASE_URL"), {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sqlClient;
}

