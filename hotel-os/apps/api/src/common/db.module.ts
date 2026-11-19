import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { createDb, type Db } from "@hotel-os/db";
import type { Pool } from "pg";
import { APP_CONFIG, type AppConfig } from "../config";

export const DB = Symbol("DB");
export const PG_POOL = Symbol("PG_POOL");

@Global()
@Module({
  providers: [
    {
      provide: "DB_BUNDLE",
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => createDb({ connectionString: cfg.DATABASE_URL }),
    },
    { provide: DB, inject: ["DB_BUNDLE"], useFactory: (b: { db: Db }) => b.db },
    { provide: PG_POOL, inject: ["DB_BUNDLE"], useFactory: (b: { pool: Pool }) => b.pool },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onModuleDestroy() {
    await this.pool.end();
  }
}
