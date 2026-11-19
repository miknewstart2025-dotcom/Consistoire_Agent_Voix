# ADR 0004 — Signature des politiques en ECDSA P-256
Le dossier proposait Ed25519, disponible dans la JCA Android seulement à partir d'API 33. minSdk = 28 → ECDSA P-256 / SHA-256 (DER), natif partout.
Enveloppe : `payload` = base64 des octets JSON exacts signés ; le boîtier vérifie les octets avant d'analyser. Anti-rollback : version ≥ version appliquée. Rotation : plusieurs `kid` acceptés.
