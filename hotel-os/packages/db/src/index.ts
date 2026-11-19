import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { join } from "node:path";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export * as schema from "./schema";
export type Db = NodePgDatabase<typeof schema>;

/** Security context applied to every transaction (drives Postgres RLS). */
export interface TenantContext {
  /** Organizations the caller may access. */
  orgIds: string[];
  /** Platform admin or trusted system job: bypasses tenant filter. Use sparingly. */
  platform?: boolean;
}

export function createDb(config: PoolConfig): { db: Db; pool: Pool } {
  const pool = new Pool({ max: 20, ...config });
  return { db: drizzle(pool, { schema }), pool };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction whose RLS context is `ctx`. Every API data access must go through this.
 */
export async function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Db) => Promise<T>): Promise<T> {
  for (const id of ctx.orgIds) if (!UUID.test(id)) throw new Error(`invalid org id in tenant context: ${id}`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_ids', ${`{${ctx.orgIds.join(",")}}`}, true)`);
    await tx.execute(sql`select set_config('app.platform', ${ctx.platform ? "on" : "off"}, true)`);
    return fn(tx as unknown as Db);
  });
}

export const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/** Runs migrations. Must be called with an owner/superuser connection, never the app role. */
export async function runMigrations(config: PoolConfig): Promise<void> {
  const { db, pool } = createDb({ ...config, max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pool.end();
  }
}
