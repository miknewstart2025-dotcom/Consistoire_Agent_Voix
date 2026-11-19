import { runMigrations } from "./index";

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error("DATABASE_OWNER_URL is required (owner role, not the app role)");
  process.exit(1);
}
runMigrations({ connectionString: url })
  .then(() => console.log("migrations applied"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
