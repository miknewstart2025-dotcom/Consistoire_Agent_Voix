# Sécurité — implémenté
- Isolation : gardes applicatives + PostgreSQL RLS (`hotelos_org_allowed`), rôle applicatif sans BYPASSRLS. Ressource étrangère = 404.
- Admins : argon2id, TOTP obligatoire, verrouillage 15 min après 5 échecs, JWT 15 min, adhésions relues à chaque requête.
- Boîtiers : clé Keystore, JWT ES256 ≤ 10 min, révocation immédiate, jetons d'enrôlement hachés à usage limité.
- Politiques signées (ECDSA), anti-rollback ; APK vérifiées (sha256, package, versionCode, certificat épinglé) avant installation.
- Secrets tiers chiffrés AES-256-GCM ; URL fournies par les admins filtrées contre le SSRF.
- Journal d'audit en ajout seul (UPDATE/DELETE révoqués pour le rôle applicatif).
À faire : rate limiting, refresh tokens, rotation des clés outillée, SSO, pentest, purge RGPD planifiée.
