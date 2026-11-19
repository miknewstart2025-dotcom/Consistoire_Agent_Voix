/**
 * Creates the first platform administrator. Usage:
 *   DATABASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node dist/scripts/create-platform-admin.js
 * TOTP enrolment is forced at first login.
 */
import { createDb, schema, withTenant } from "@hotel-os/db";
import { AuthService } from "../auth/auth.service";

async function main() {
  const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error("DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD are required");
  if (ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  const { db, pool } = createDb({ connectionString: DATABASE_URL });
  try {
    await withTenant(db, { orgIds: [], platform: true }, async (tx) => {
      await tx.insert(schema.users).values({ email: ADMIN_EMAIL.toLowerCase(), name: ADMIN_NAME ?? "Platform admin", passwordHash: await AuthService.hashPassword(ADMIN_PASSWORD), isPlatformAdmin: true });
    });
    console.log(`platform admin ${ADMIN_EMAIL} created`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
