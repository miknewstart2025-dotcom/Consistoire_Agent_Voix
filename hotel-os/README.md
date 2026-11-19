# HOTEL OS

Plateforme SaaS multi-tenant de gestion des téléviseurs d'hôtels (boîtiers Android TV / Google TV en Device Owner).
Conception complète : [`docs/design/`](docs/design/). État réel du développement : [`docs/PROGRESS.md`](docs/PROGRESS.md).

| Composant | Dossier | Techno |
|---|---|---|
| API (admin + boîtiers + WebSocket) | `apps/api` | NestJS, PostgreSQL (RLS), Drizzle |
| HOTEL MANAGER (admin web + vue technicien) | `apps/manager` | Next.js |
| Station de provisioning (ADB) | `apps/provisioning-cli` | Node/TS |
| Simulateur de boîtiers (charge / protocole / démo) | `apps/device-simulator` | Node/TS |
| Contrat boîtier ↔ serveur | `packages/protocol` | zod |
| Moteur de politiques | `packages/policy-engine` | TS pur |
| Schéma BDD + migrations + RLS | `packages/db` | Drizzle, SQL |
| HOTEL DEVICE CONTROLLER | `android/dpc` + `android/dpc-core` | Kotlin, DevicePolicyManager |
| HOTEL LAUNCHER | `android/launcher` | Kotlin, Compose for TV |
| HOTEL IPTV | `android/iptv` + `android/iptv-core` | Kotlin, Media3 |

## Démarrage local

```bash
pnpm install
pnpm db:up                                   # PostgreSQL local (port 54329), sans Docker
pnpm -r --filter "./packages/**" run build
DATABASE_OWNER_URL=postgres://hotelos_owner:hotelos_owner@127.0.0.1:54329/hotelos pnpm --filter @hotel-os/db migrate
pnpm --filter @hotel-os/api build
export DATABASE_URL=postgres://hotelos_api:hotelos_api@127.0.0.1:54329/hotelos JWT_SECRET=$(openssl rand -hex 32)
ADMIN_EMAIL=vous@exemple.com ADMIN_PASSWORD='un-mot-de-passe-long' node apps/api/dist/scripts/create-platform-admin.js
node apps/api/dist/main.js                   # API sur :3001
pnpm --filter @hotel-os/manager dev          # Admin sur :3000 (2FA imposée à la 1re connexion)
```

## Tests

```bash
pnpm --filter @hotel-os/policy-engine test   # moteur de politiques
pnpm --filter @hotel-os/api test             # intégration sur vrai PostgreSQL (pnpm db:up requis)
pnpm --filter @hotel-os/provisioning-cli test
cd android && gradle :dpc-core:test :iptv-core:test   # logique contrôleur + IPTV (JVM, sans SDK Android)
node e2e/admin-flow.e2e.cjs                  # E2E navigateur : API + admin + boîtier simulé
```

Les modules Android `:dpc`, `:launcher`, `:iptv` nécessitent le SDK Android (`ANDROID_HOME`) pour être compilés.
