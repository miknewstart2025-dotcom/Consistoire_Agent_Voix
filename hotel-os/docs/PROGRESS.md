# État d'avancement — HOTEL OS

Règle : rien n'est déclaré « validé » sans preuve. `[HW-REQUIRED]` = nécessite un boîtier physique.

## Vérifié automatiquement (tests verts)

| Domaine | Preuve |
|---|---|
| Moteur de politiques : GLOBAL→ORG→HÔTEL→GROUPE→CHAMBRE→BOÎTIER, clés verrouillées, « le plus restrictif gagne » entre groupes de même priorité, abonnements, replis matériels, paquets protégés | `packages/policy-engine` – 13 tests |
| Isolation multi-tenant applicative **et** PostgreSQL RLS, rôles (technicien sans données clients), 2FA TOTP obligatoire, verrouillage après 5 échecs | `apps/api/test/auth-and-isolation.test.ts` – 9 tests |
| Enrôlement (jeton à usage unique, clé publique P-256), JWT boîtier ES256 courts, politique signée ECDSA + ETag/304, appairage par code, remplacement de boîtier (révocation), état voulu vs réel, commandes (idempotence, cycle de vie, WebSocket + polling), check-in/out + rapport de nettoyage, consentement prénom | `apps/api/test/device-lifecycle.test.ts` – 13 tests |
| Ingestion IPTV M3U/XMLTV (parseur en flux), attestation de droits, identifiants chiffrés AES-GCM jamais renvoyés, garde SSRF, numérotation stable, échec sans effacement | `apps/api` – 9 tests |
| Logique du contrôleur : réconciliation (restrictions, kiosque, suspension → repli masquage, interdiction par défaut, ordre sûr HOME/launcher d'origine, maintenance), vérification de signature **d'une politique produite par le serveur TypeScript**, anti-rollback, JWT DER→P1363, nettoyage partiel honnête, commandes | `android/dpc-core` – 19 tests (Android simulé, voir `FakeDevicePlatform`) |
| Logique IPTV boîtier : grille, zapping, saisie numérique, maintenant/ensuite, reprise | `android/iptv-core` – 4 tests |
| Catalogue APK : analyse statique **sans outils Android** (ZIP, manifeste binaire, vérification cryptographique complète des signatures v2/v3 et du condensat du fichier), résultats identiques à l'outil officiel de Google (apksig) sur une vraie APK ; détection d'un octet modifié ; épinglage du certificat ; refus des applis « store only » (Netflix, YouTube…) ; attestation de droits de distribution ; stockage à l'identique | `apps/api/src/catalog` – 7 tests + `test/catalog-rollouts.test.ts` |
| Déploiements progressifs : anneaux (ex. 5→25→100 %), succès mesuré par l'inventaire remonté, pause automatique sur taux d'échec, reprise, annulation (sans downgrade), filtre de compatibilité (SDK, ABI, downgrade, signature), boîtiers ajoutés après la fin, blocage possible par l'hôtel, « DEPLOY TO ALL HOTELS » (plateforme + confirmation écrite), téléchargement authentifié et reprenable | `test/catalog-rollouts.test.ts` – 9 tests |
| Contrôleur : mises à jour différées à la fenêtre de maintenance de l'hôtel (y compris fenêtre à cheval sur minuit), premières installations immédiates | `android/dpc-core` – 21 tests au total |
| Station de provisioning : plan ADB et interprétation des erreurs `dpm` | `apps/provisioning-cli` – 2 tests |
| Parcours admin complet dans Chromium avec boîtier **simulé** | `e2e/admin-flow.e2e.cjs` + captures `e2e/screenshots/` |

## Écrit mais NON compilé ici

Le SDK Android n'était pas téléchargeable dans l'environnement de développement (dl.google.com bloqué).
`android/dpc`, `android/launcher`, `android/iptv` sont écrits contre les API officielles mais **n'ont jamais été compilés**.
Première action : `ANDROID_HOME=… gradle assembleDebug` et corriger les erreurs éventuelles.

## [HW-REQUIRED] — à valider sur boîtier réel (Phase 1)

1. `dpm set-device-owner` accepté par le firmware (station de provisioning).
2. HOME persistant effectif ; bouton HOME de la télécommande ; masquage du launcher d'origine sans casser le système.
3. `setPackagesSuspended` / `setApplicationHidden` sur Netflix, YouTube, Prime, Disney+, Spotify, Paramètres, Play Store, assistant.
4. Boutons dédiés de la télécommande (Netflix, YouTube, micro) avec applis suspendues.
5. Installation silencieuse `PackageInstaller` (aucune confirmation).
6. `clearApplicationUserData` sur Netflix/YouTube/Spotify : déconnexion effective ?
7. Compte Google technique (décision D2) : mises à jour Play Store, comportement YouTube.
8. Niveau Widevine (L1/L3), lecture Netflix HD.
9. Lecture IPTV HLS/DASH/UDP multicast 72 h.
10. Coupure électrique (×20), redémarrage, réinitialisation matérielle (détection + ré-enrôlement).
11. CEC (allumage/volume TV) — critère de certification, non pilotable.

## Non implémenté (renvoie une erreur explicite, jamais un faux succès)

- Commandes `UPLOAD_LOGS`, `ENTER_MAINTENANCE`, `EMERGENCY_BROADCAST`, `INSTALL_APP`/`UNINSTALL_APP` directes, `RUN_CERTIFICATION` (côté boîtier).
- Stockage APK : pilote disque local uniquement (pilote S3/CDN à brancher pour la production).
- CMS / campagnes / Room Service / connecteurs PMS (Phase 6). Check-in/out **manuel** disponible.
- Fan-out WebSocket multi-instances (Redis) et workers BullMQ : instance unique pour l'instant ; les boîtiers retombent sur le polling.
- Écran QR graphique sur la TV (code texte affiché), suite d'auto-certification embarquée, purge RGPD planifiée, facturation.

## Décisions prises par défaut (modifiables)

Recommandations D1–D6 du dossier appliquées (DPC propriétaire, monorepo, hébergement UE, niveau revendeur dans le modèle).
Écart au dossier : signature des politiques en **ECDSA P-256** au lieu d'Ed25519 (supporté nativement dès Android 9) — ADR 0004.
