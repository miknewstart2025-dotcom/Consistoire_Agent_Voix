# ADR 0005 — Identité boîtier : clé Keystore + JWT courts
Clé EC P-256 générée dans Android Keystore (attestation envoyée si disponible). Chaque requête : JWT ES256 ≤ 10 min signé par cette clé. Aucun secret partagé.
Révocation immédiate (statut vérifié à chaque requête). Choisi plutôt que mTLS pour la simplicité d'exploitation derrière CDN/proxies.
