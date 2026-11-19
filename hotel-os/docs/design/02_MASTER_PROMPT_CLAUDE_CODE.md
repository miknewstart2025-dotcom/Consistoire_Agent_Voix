# MASTER PROMPT — HOTEL OS (à transmettre tel quel à Claude Code)

---

## 0. Ton rôle

Tu es l'équipe de développement principale de **HOTEL OS**, une plateforme SaaS multi-tenant de gestion des téléviseurs d'hôtels basée sur des boîtiers Android TV / Google TV. Tu agis comme un ingénieur senior rigoureux : tu développes **par phases**, tu vérifies chaque étape, tu documentes, et tu ne déclares jamais opérationnel ce qui n'a pas été prouvé.

L'architecture ci-dessous est **décidée**. Ne la redéfinis pas. Si tu rencontres une impossibilité technique ou une meilleure option significative, tu l'écris dans `docs/adr/` (Architecture Decision Record : contexte, alternatives, décision, conséquences) **avant** de dévier, puis tu continues.

---

## 1. Règles de conduite NON NÉGOCIABLES

1. **Audite d'abord.** Avant toute modification, inspecte le dépôt existant, produis `docs/AUDIT.md` (ce qui existe, ce qui est réutilisable, ce qui sera remplacé et pourquoi). Conserve tout élément exploitable.
2. **Progression incrémentale.** Une phase à la fois, en petits lots vérifiables (une PR / un commit logique par lot). Pas de génération massive de code non testé.
3. **Chaque lot livre** : code + tests automatisés qui passent + documentation mise à jour + gestion des erreurs + note de validation dans `docs/PROGRESS.md` (fait / testé comment / reste à faire).
4. **Zéro faux-semblant.** N'utilise jamais de données fictives ou de « mocks » en prétendant qu'une fonctionnalité est opérationnelle. Les simulateurs et fixtures sont autorisés **uniquement** dans les tests et le simulateur de boîtiers, et doivent être nommés comme tels. Toute fonction non implémentée renvoie une erreur explicite `NOT_IMPLEMENTED`, jamais un succès.
5. **Matériel réel.** Marque chaque fonctionnalité qui nécessite un boîtier physique avec le tag `[HW-REQUIRED]` dans le code (commentaire), dans `docs/PROGRESS.md` et dans `docs/HARDWARE_TEST_PLAN.md`. Une telle fonctionnalité ne passe au statut « validé » qu'avec un rapport de test sur matériel réel fourni par l'équipe humaine. Ce que tu peux tester sur l'émulateur Android TV (y compris `dpm set-device-owner` sur émulateur), fais-le et dis-le.
6. **Ne jamais inventer de capacités Android.** Utilise uniquement des API publiques documentées (`DevicePolicyManager`, `PackageInstaller`, `UserManager`…). Pas d'API cachées, pas de réflexion sur des API système, pas de root, pas d'exploit.
7. **Légalité.** Ne jamais : injecter des identifiants dans une appli tierce, contourner un DRM ou une authentification, modifier/reconditionner une APK tierce, héberger une APK dont la distribution n'est pas autorisée, partager un compte de streaming contrairement aux CGU.
8. **Sécurité par défaut.** Aucun secret dans le code ou les logs. Isolation tenant testée à chaque endpoint. Validation stricte de toutes les entrées.
9. **Autonomie.** Quand une décision est couverte par ce document, avance sans demander. Quand un choix technique important n'est pas couvert, présente brièvement les alternatives dans un ADR, retiens la meilleure selon les priorités (fiabilité > sécurité > simplicité d'administration > facilité de déploiement > performance), et continue. Ne t'arrête pour demander que si la décision est commerciale, juridique ou irréversible.
10. **Commits** : messages clairs en anglais, format Conventional Commits. Respecte le fichier `CLAUDE.md` du dépôt s'il existe.

---

## 2. Le produit en bref

Chaque chambre a un boîtier Android TV branché au téléviseur. Au démarrage, il affiche l'interface HOTEL OS ; le client ne peut ni voir Android, ni accéder aux paramètres, ni lancer une appli non autorisée. L'hôtel administre tout depuis le web.

**Quatre composants** (+ outils) :

| Composant | Techno | Rôle |
|---|---|---|
| **HOTEL MANAGER** | Next.js + API NestJS | Administration web multi-tenant |
| **HOTEL DEVICE CONTROLLER** (`dpc`) | Kotlin, Device Owner | Contrôle réel du boîtier, unique agent cloud du boîtier |
| **HOTEL LAUNCHER** | Kotlin, Compose for TV | Interface client |
| **HOTEL IPTV** | Kotlin, Media3 | Lecture des chaînes de l'hôtel |
| Station de provisioning | CLI Node/TS (puis GUI) utilisant ADB | Enrôlement Device Owner en série |
| PWA Technicien | Next.js (route dédiée, mobile) | Association boîtier ↔ chambre par QR, checklists |
| Simulateur de boîtiers | TS | Tests de charge et d'intégration du protocole |

### Faits techniques établis (à respecter)

- Le provisioning QR/NFC n'est **pas** supposé disponible sur Android TV. Méthode V1 : **ADB** (`adb shell dpm set-device-owner com.hotelos.dpc/.HotelDeviceAdminReceiver`) sur un boîtier réinitialisé **sans aucun compte**. Une clé USB ne peut pas conférer le statut Device Owner.
- Le QR code sert à **associer** un boîtier enrôlé à un hôtel/une chambre : le boîtier affiche un QR contenant un code d'appairage court ; le technicien le scanne dans la PWA.
- Downgrade d'APK impossible sans désinstallation → **roll-forward** (republier l'ancien code avec versionCode supérieur).
- Mise à jour d'une APK : même certificat de signature obligatoire.
- `clearApplicationUserData` : API 28+, Device Owner ; n'efface pas les comptes système ni les données côté serveurs des éditeurs.
- Le contrôle HDMI-CEC, le volume TV et l'allumage TV ne sont **pas** pilotables par un DPC tiers : ce sont des critères de certification, pas des fonctions.
- FCM n'est pas utilisé (dépend des services Google, non garantis).
- Tizen/webOS ne peuvent pas exécuter d'APK : clients web dédiés en V3 (hors périmètre actuel, mais le protocole doit rester agnostique).

---

## 3. Structure du dépôt (nouveau monorepo `hotel-os`)

```
hotel-os/
├── apps/
│   ├── api/                 # NestJS — API admin + API boîtiers + workers (même code, rôles de process)
│   ├── manager/             # Next.js — HOTEL MANAGER + PWA technicien (/tech)
│   ├── provisioning-cli/    # Station de provisioning (TS + ADB)
│   └── device-simulator/    # Simulateur de N boîtiers (tests protocole/charge)
├── packages/
│   ├── protocol/            # Schémas JSON (zod) du protocole boîtier ↔ serveur, source de vérité,
│   │                        # génère les types TS et les modèles Kotlin (kotlinx.serialization)
│   ├── policy-engine/       # Résolution des configurations (pure, 100 % testée)
│   ├── db/                  # Schéma, migrations (Drizzle), politiques RLS, seeds de dev
│   ├── i18n/                # Chaînes partagées (fr, en, he, ar, es, it, de)
│   └── ui/                  # Composants admin partagés
├── android/                 # Projet Gradle multi-modules
│   ├── dpc/
│   ├── launcher/
│   ├── iptv/
│   ├── core-protocol/       # Modèles générés depuis packages/protocol
│   ├── core-auth/           # Client AIDL jetons délégués
│   ├── core-ui-tv/          # Thème, composants focusables, RTL
│   └── test-apps/           # APK de test pour la certification (installation/suspension)
├── infra/                   # Docker compose (dev), Terraform (prod), configs observabilité
└── docs/                    # AUDIT, ARCHITECTURE, ADR, API, PROTOCOL, SECURITY, RGPD,
                             # INSTALL_GUIDE, PROVISIONING, NETWORK_REQUIREMENTS,
                             # HARDWARE_TEST_PLAN, CERTIFICATION, PROGRESS, RUNBOOKS
```

Outils : pnpm + Turborepo ; TypeScript strict ; ESLint/Prettier ; Gradle Kotlin DSL + version catalog ; ktlint/detekt ; CI GitHub Actions (lint, tests, build APK debug, tests d'isolation tenant). **Pas de déploiement automatique depuis la CI à ce stade.**

---

## 4. Stack décidée

- **Backend** : NestJS (TypeScript), monolithe modulaire. Un binaire, trois rôles de process : `api` (REST), `gateway` (WebSocket boîtiers), `worker` (BullMQ). OpenAPI généré automatiquement.
- **BDD** : PostgreSQL 16+ (hébergement UE), Drizzle ORM, migrations versionnées, **Row-Level Security** sur toutes les tables tenantisées (variable de session `app.tenant_ids` positionnée par transaction) **en plus** des gardes applicatives.
- **Redis** : files BullMQ, pub/sub entre instances gateway, rate limiting, présence boîtiers.
- **Stockage objet S3 compatible + CDN**, URLs signées à durée courte.
- **Admin** : Next.js App Router, TypeScript, Tailwind, shadcn/ui, next-intl, TanStack Query. Authentification OIDC + 2FA obligatoire pour tous les rôles admin (TOTP, WebAuthn).
- **Android** : Kotlin, minSdk 28, targetSdk = dernière stable, Jetpack Compose for TV (`androidx.tv`), Coroutines/Flow, Hilt, Room, WorkManager, OkHttp (WebSocket), kotlinx.serialization, Media3 (ExoPlayer, HLS, DASH, RTSP, UDP), Coil.
- **Observabilité** : OpenTelemetry, logs JSON structurés, Sentry (serveur + Android), métriques Prometheus.
- **Dev local** : `docker compose` (Postgres, Redis, MinIO, Mailpit).

---

## 5. Modèle multi-tenant et hiérarchie

```
PLATFORM (super admin HOTEL OS)
 └─ PARTNER (revendeur/intégrateur — optionnel, peut être vide au MVP)
     └─ ORGANIZATION (client facturé : hôtel indépendant, groupe, propriétaire)
         └─ BRAND (optionnel : enseigne/franchise, porte des modèles partagés)
         └─ HOTEL (établissement)
             ├─ ROOM_GROUP (N, personnalisables ; une chambre peut appartenir à plusieurs groupes)
             ├─ ROOM
             │   └─ DEVICE (0..1 actif ; historique des boîtiers conservé)
             └─ (contenus, applis, IPTV, services, séjours)
```

- **Isolation** : toute ligne tenantisée porte `organization_id` (et `hotel_id` quand pertinent). Aucun accès inter-organisation sans **grant explicite** (table `access_grants` : ex. un revendeur gère un hôtel, une marque publie un modèle à ses franchisés).
- **Rôles** (RBAC + portée) : `PLATFORM_ADMIN`, `PARTNER_ADMIN`, `ORG_ADMIN`, `HOTEL_ADMIN`, `MANAGER` (contenus, séjours, services), `TECHNICIAN` (boîtiers, provisioning, diagnostics, sans données clients), `READ_ONLY`. Permissions fines `resource:action` (ex. `device:reboot`, `app:deploy`, `stay:checkout`, `deploy:all_hotels` réservé PLATFORM_ADMIN avec double confirmation). Une adhésion (`membership`) = utilisateur + rôle + portée (org / hôtel / liste d'hôtels).
- **Journal d'audit** immuable de toute action d'écriture (qui, quoi, portée, avant/après, IP, horodatage).

---

## 6. Modèle de données (tables principales)

Conventions : `id uuid v7`, `created_at`, `updated_at`, `deleted_at` (soft delete quand utile), colonnes de tenant, index sur les clés étrangères. Écris le schéma complet dans `packages/db` et documente-le dans `docs/DATA_MODEL.md` (avec diagramme Mermaid).

**Tenancy & accès** : `partners`, `organizations`, `brands`, `hotels` (nom, adresse, fuseau, langues activées, langue par défaut, branding JSON : logo, couleurs, polices, photos, messages), `users`, `memberships`, `roles`, `permissions`, `access_grants`, `audit_logs`, `api_keys`.

**Topologie** : `room_groups` (avec `priority int` pour les conflits), `rooms` (numéro, étage, type, statut, `room_group_ids` via `room_group_members`), `devices` (identité, `room_id` nullable, modèle, firmware, versions des APK, état de provisioning, `last_seen_at`, `policy_version_applied`, `kiosk_state`, capacités mesurées JSON), `device_room_history`, `device_credentials` (clé publique, empreinte, statut, rotation), `enrollment_tokens` (usage unique, portée hôtel, expiration), `pairing_codes`.

**Matériel** : `device_models` (fabricant, référence, Android, API, RAM, stockage, CPU/ABI, Wi-Fi, Ethernet, résolution, statut CERTIFIED / PARTIAL / INCOMPATIBLE), `certification_reports` (JSON du rapport d'auto-test + checklist manuelle + verdict), `model_capabilities` (capacité par fonction : DO, kiosque, install silencieuse, suspension par paquet, DRM niveau…).

**Configuration** : `config_layers` (scope_type GLOBAL/ORG/HOTEL/GROUP/ROOM/DEVICE, scope_id, `values jsonb`, `locked_keys text[]`, version), `effective_policies` (device_id, version, hash, document signé, calculé le).

**Applications** : `apps` (package, nom, type NATIVE/CATALOG/FIRST_PARTY, catégorie, icône), `app_versions` (APK : objet S3, sha256, versionCode, versionName, certificat de signature SHA-256, minSdk/targetSdk, ABI, permissions, statut d'analyse, provenance et attestation de droit de distribution), `app_signing_pins` (package → certificat attendu), `app_assignments` (scope, app_id, version ciblée ou « latest », état désiré : ALLOWED / SUSPENDED / HIDDEN / UNINSTALLED, visible au Launcher, ordre, cleanup_policy), `device_app_inventory` (état réel remonté : installé, version, système/utilisateur, suspendu, masqué, capacités `can_suspend`/`can_hide`/`can_clear`, dernière observation).

**Déploiements** : `rollouts` (version cible, portée — y compris ALL_HOTELS —, anneaux, pourcentage, fenêtre de maintenance, état, critères de santé, auto-pause), `rollout_targets` (device, état : PENDING / DOWNLOADING / INSTALLING / VERIFYING / SUCCEEDED / FAILED / SKIPPED / ROLLED_FORWARD, erreur).

**Commandes** : `commands` (device_id, type, payload, idempotency_key, priorité, expire_at, créée par, état : CREATED / QUEUED / DELIVERED / ACKED / RUNNING / SUCCEEDED / FAILED / EXPIRED / CANCELLED), `command_events`.

**Contenus & campagnes** : `media_assets`, `content_items` (type : image, vidéo, bannière, message, promotion, annonce, info pratique ; traductions), `playlists`, `schedules` (récurrence, fuseau hôtel), `campaigns` (ciblage hôtel/groupe/chambre, dates, horaires, priorité, emplacement), `impressions_daily` (**agrégé** : campagne, hôtel, groupe, jour, nb d'affichages, durée — jamais par séjour).

**IPTV** : `iptv_sources` (type M3U/XMLTV/autre, URL, identifiants chiffrés, fréquence de sync, attestation de droits de diffusion), `channels` (numéro, nom, logo, catégorie, URL de flux, langue, DRM), `channel_lineups` (par hôtel/groupe), `epg_programs` (fenêtre glissante 7 jours max, purge automatique).

**Séjours & services** : `stays` (hotel, room, arrivée, départ, prénom **optionnel** et consentement d'affichage, langue, source MANUAL/PMS, référence PMS pseudonymisée, statut), `cleanup_jobs` (stay, device, état : PENDING / RUNNING / SUCCEEDED / PARTIAL / FAILED, résultats par appli), `service_modules` (activation par hôtel), `menus`, `menu_categories`, `products` (prix, photos, disponibilités horaires, traductions), `orders`, `order_items`, `order_events`, `messages_to_room`, `emergency_broadcasts`.

**PMS** : `pms_connections` (type, identifiants chiffrés, mapping chambres, état), `pms_events` (journal d'événements entrants, idempotence).

**SaaS** : `plans`, `subscriptions`, `entitlements` (modules activés, quotas de chambres/boîtiers), `invoices` (via Stripe, plus tard).

**Rétention RGPD** : `retention_policies` (par organisation, par type de donnée, durée), job de purge quotidien.

---

## 7. Moteur de politiques (cœur logique — `packages/policy-engine`)

Fonction pure : `resolveEffectivePolicy(device, layers[], entitlements, modelCapabilities) → EffectivePolicy`.

Règles de résolution, à implémenter et tester exhaustivement :
1. Ordre : **GLOBAL → ORG → HOTEL → GROUP(s) → ROOM → DEVICE**. Un niveau plus spécifique écrase un niveau plus général, **clé par clé** (merge profond des objets, remplacement des tableaux sauf clés listées comme « additives »).
2. **Clés verrouillées** : une clé présente dans `locked_keys` d'un niveau ne peut pas être modifiée par les niveaux inférieurs (ex. la plateforme verrouille `security.adbDisabled = true`).
3. **Plusieurs groupes** : appliqués par `priority` croissante (le plus prioritaire en dernier) ; à priorité égale, ordre déterministe par id. Pour les **clés de sécurité et d'état d'appli**, la règle la plus restrictive gagne entre groupes de même priorité (HIDDEN > SUSPENDED > ALLOWED).
4. **Entitlements** : un module non souscrit est forcé à désactivé, quelle que soit la configuration.
5. **Capacités** : si l'état désiré est impossible sur le modèle (ex. paquet non suspendable), la politique contient l'état demandé **et** le repli (ex. `launcherHidden`), et l'admin affiche l'avertissement.
6. Résultat : document JSON canonique, `version` monotone, `hash` SHA-256, **signature Ed25519** par une clé serveur (clé privée en KMS). Le DPC vérifie la signature avec la clé publique embarquée (avec support de rotation : liste de clés publiques acceptées).
7. **Explicabilité** : l'API renvoie, pour chaque clé, le niveau qui l'a fixée (« pourquoi Netflix est suspendu dans la chambre 204 ? »).

Contenu de l'`EffectivePolicy` : kiosque (mode ENFORCED_HOME / STRICT_LOCK_TASK, paquets lock task), restrictions utilisateur, applis (package → état, visible, ordre, version cible, URL+sha256, politique de nettoyage), launcher (template, branding, langue, modules, contenus/playlists référencés), IPTV (référence lineup), réseau (Wi-Fi), heure/fuseau, fenêtre de maintenance, politique OTA, télémétrie (intervalle), volume (si supporté).

---

## 8. Protocole boîtier ↔ serveur (`packages/protocol`, documenté dans `docs/PROTOCOL.md`)

### Identité et enrôlement
1. Station de provisioning : installe le DPC, exécute `dpm set-device-owner`, transmet (via `adb shell am broadcast` ou fichier) l'URL du serveur et un **jeton d'enrôlement** à usage unique lié à l'hôtel.
2. Le DPC génère une paire de clés **dans l'Android Keystore** (matériel si disponible, demande d'attestation de clé si supportée — résultat stocké, non bloquant au MVP), envoie `POST /device/v1/enroll` (jeton, clé publique, chaîne d'attestation, infos matériel : fabricant, modèle, `Build.FINGERPRINT`, numéro de série si accessible au DO, Android ID, MAC à titre informatif uniquement).
3. Le serveur crée le `device`, renvoie `device_id` + certificat/identifiant de credential. Le jeton d'enrôlement est consommé.
4. Le boîtier affiche un **QR d'appairage** (code court, 10 min) ; le technicien le scanne dans la PWA et choisit la chambre. **Remplacement** : scanner le nouveau boîtier sur une chambre déjà équipée → l'ancien est révoqué, la chambre garde sa configuration.
5. Authentification ensuite : chaque requête REST et la connexion WS portent un **JWT court signé par la clé privée du boîtier** (ou mTLS — choisis via ADR, JWT signé par défaut). Révocation immédiate côté serveur ; rotation de clé périodique (`POST /device/v1/credentials/rotate`).

### Canaux
- **WebSocket** `wss://…/device/v1/ws` : `hello` (versions, policy_version), `heartbeat` (60 s), `policy.changed` (nouvelle version disponible), `command` → `command.ack` → `command.result`, `telemetry`. Reconnexion avec backoff exponentiel + jitter.
- **REST** : `GET /device/v1/policy` (ETag / version, réponse 304), `GET /device/v1/commands?since=` (repli si WS indisponible), `POST /device/v1/state` (état réel : inventaire applis différentiel, kiosque, versions, stockage, RAM, température si disponible, réseau, erreurs), `POST /device/v1/commands/{id}/result`, `POST /device/v1/cleanup/{jobId}/report`, `GET /device/v1/content/manifest`, `POST /device/v1/logs` (upload à la demande), `POST /device/v1/token/delegate` (jeton court pour Launcher/IPTV).
- **Interrogation périodique** de sécurité (15 min, WorkManager) même si WS ouvert.
- **Synchronisation différentielle** : inventaire et manifestes de contenu par hash ; le boîtier n'envoie que les changements.
- **Commandes** : idempotentes (`idempotency_key`), TTL, persistées serveur ; le DPC conserve un journal local des commandes exécutées pour ne jamais exécuter deux fois.

### Types de commandes (MVP en gras)
**`REBOOT_DEVICE`** (`DevicePolicyManager.reboot`), **`RESTART_LAUNCHER`**, **`LAUNCH_APP`**, **`REFRESH_UI`**, **`SYNC_NOW`**, **`SHOW_MESSAGE`** (texte, durée, priorité), **`CHECKOUT_CLEANUP`**, **`UPLOAD_LOGS`**, **`RUN_DIAGNOSTICS`**, `INSTALL_APP`/`UNINSTALL_APP` (normalement via politique, commande pour forcer), `EMERGENCY_BROADCAST`, `ENTER_MAINTENANCE` (code à usage unique), `RUN_CERTIFICATION`, `SCREENSHOT` (désactivé par défaut, uniquement hors séjour, journalisé — sinon refusé).

---

## 9. HOTEL DEVICE CONTROLLER (`android/dpc`) — spécification

Package : `com.hotelos.dpc`. Doit rester **petit, stable et très testé**. Aucune UI client hormis l'écran d'appairage, l'écran de maintenance et le **lanceur de secours**.

Modules internes :
- `admin/` : `HotelDeviceAdminReceiver`, état DO, `onProfileProvisioningComplete`, détection de perte du statut DO (impossible à voir après reset → c'est le serveur qui détecte : boîtier silencieux puis ré-enrôlement d'un nouvel appareil sur la même chambre ⇒ alerte « boîtier réinitialisé »).
- `identity/` : Keystore, JWT signés, rotation, stockage chiffré (EncryptedSharedPreferences / DataStore + Tink).
- `sync/` : client WS + REST, backoff, WorkManager périodique, service au premier plan (type `dataSync`/`specialUse` selon API 34+ — documente le choix).
- `policy/` : vérification de signature, persistance de la **dernière politique valide** (Room), **réconciliateur** idempotent (désiré vs réel → actions → relecture → rapport). Exécuté au boot, à chaque nouvelle politique, toutes les 15 min.
- `kiosk/` : HOME persistant (`addPersistentPreferredActivity`) vers le Launcher, masquage/suspension du launcher d'origine si la politique du modèle le permet, lock task (mode strict), `setStatusBarDisabled`, `setKeyguardDisabled`, restrictions utilisateur (liste en annexe du dossier), désactivation ADB après provisioning (`DISALLOW_DEBUGGING_FEATURES`) sauf mode maintenance.
- `apps/` : inventaire (`PackageManager`, flags système, icônes compressées envoyées par hash), `setPackagesSuspended`, `setApplicationHidden`, `setUninstallBlocked`, installation/désinstallation silencieuses via `PackageInstaller` (téléchargement reprenable, **vérification sha256 + certificat de signature épinglé avant install**, vérification ABI/minSdk, espace disque), suivi des résultats via `PendingIntent`, gestion des échecs et reprise après coupure.
- `cleanup/` : moteur de nettoyage par appli selon `cleanup_policy` (`CLEAR_DATA`, `KEEP`, `RESET_PREFERENCES`), `clearApplicationUserData`, retour au Launcher, rapport détaillé (succès / partiel / échec par appli, avec raison).
- `watchdog/` : surveille le Launcher (heartbeat AIDL, crash-loop) ; en cas de défaillance : redémarrage, puis bascule du HOME persistant vers le **lanceur de secours** intégré au DPC (logo hôtel + applis autorisées + message), alerte serveur.
- `commands/` : exécuteur, journal local d'idempotence.
- `system/` : `reboot`, `setTimeZone`, `setAutoTimeEnabled`/`setAutoTimeRequired`, `setSystemUpdatePolicy`, Wi-Fi (`WifiManager` en tant que DO), télémétrie (stockage, RAM, uptime, réseau, température si exposée).
- `maintenance/` : mode maintenance via code TOTP/à usage unique délivré par l'admin à un technicien : lève temporairement le kiosque (durée max), journalisé, retour automatique.
- `certification/` : suite d'auto-tests (voir §15) produisant un rapport JSON.
- `ipc/` : service AIDL exporté protégé par une permission `signature` (`com.hotelos.permission.DEVICE_SERVICE`) : obtenir jeton délégué, politique Launcher, signaler heartbeat, demander lancement d'appli autorisée.
- **Résilience** : détection de crash-loop du DPC lui-même (compteur au démarrage) → mode dégradé (réconciliateur désactivé, sync seule) + alerte.

**Mise à jour du DPC** : par lui-même via `PackageInstaller` (même signature), uniquement par anneaux (LAB → CANARY → 5 % → 25 % → 100 %), jamais pendant une fenêtre d'usage.

---

## 10. HOTEL LAUNCHER (`android/launcher`)

- Activité HOME (`CATEGORY_HOME`, `CATEGORY_DEFAULT`, `LEANBACK_LAUNCHER`). Démarrage automatique (via HOME persistant + `BOOT_COMPLETED` de secours).
- Données : politique Launcher et jeton délégué obtenus **uniquement via l'AIDL du DPC** ; contenus téléchargés depuis le CDN par URL signée ; **cache hors ligne** (Room + fichiers, quota, purge LRU).
- Écran d'accueil : logo, photo de bienvenue, message personnalisé (prénom si consentement), numéro de chambre, heure/date (fuseau hôtel), météo (fournie par le **serveur**, mise en cache — pas d'appel direct à une API tierce depuis le boîtier), infos pratiques, rangée d'applis autorisées, services, promotions planifiées.
- **3 templates** à terme (1 au MVP), pilotés par la politique (server-driven UI : le schéma de mise en page est un JSON validé par `packages/protocol`, pour pouvoir le réutiliser sur Tizen/webOS plus tard).
- Navigation 100 % télécommande : D-pad, OK, Retour, touches média ; focus très visible (agrandissement + contour + contraste AA), aucune impasse de focus, Retour à l'accueil ne quitte jamais le Launcher.
- Lancement d'une appli : `getLaunchIntentForPackage` / `getLeanbackLaunchIntentForPackage` ; si l'appli ne démarre pas en 10 s ou crashe, retour à l'accueil avec message ; en mode strict, demander au DPC.
- Multilingue : fr, en, he, ar, es, it, de ; **RTL complet** pour he/ar (miroir de la mise en page, polices adaptées) ; langue = chambre/séjour → groupe → hôtel ; sélecteur de langue accessible au client.
- Modules de services (room service, etc.) en écrans natifs pilotés par l'API.
- Message d'urgence : overlay plein écran prioritaire (via DPC), multilingue.
- Retour à l'accueil après inactivité configurable et au check-out.

---

## 11. HOTEL IPTV (`android/iptv`)

- **Ingestion côté serveur** (worker) : téléchargement M3U/M3U8 et XMLTV (parse en flux, gros fichiers), normalisation, correspondance chaîne ↔ EPG (`tvg-id`), logos rapatriés sur notre CDN, détection d'erreurs, historique de synchronisation. Identifiants de source chiffrés, jamais envoyés au boîtier si le flux peut être servi sans (sinon jeton).
- Le boîtier reçoit un **lineup JSON compact** + EPG en fenêtres de 24 h (compressé), mis en cache (Room).
- Appli : liste des chaînes, catégories, favoris (réinitialisés au check-out), recherche, logos, guide TV (grille), programme en cours/suivant, zapping numérique et haut/bas, plein écran, OSD.
- Lecture **Media3 ExoPlayer** : HLS, DASH, progressive, RTSP, **UDP/RTP multicast MPEG-TS** (avec `WifiManager.MulticastLock`), Widevine si la source le requiert. Reprise automatique après erreur (backoff, chaîne suivante proposée), détection de flux mort remontée en télémétrie agrégée (« chaîne X en échec sur 30 % des chambres »).
- Activation par hôtel/groupe/chambre via la politique ; mises à jour indépendantes du Launcher.
- Attestation obligatoire dans l'admin : l'hôtel déclare détenir les droits de diffusion des flux.

---

## 12. HOTEL MANAGER (`apps/manager`)

Écrans (MVP en gras) :
- **Tableau de bord global / hôtel** : hôtels, chambres, boîtiers, en ligne/hors ligne, dernière sync, versions, échecs, rollouts en cours, état kiosque, alertes.
- **Hôtels** (fiche, branding, langues, fuseau, photos, messages), **Groupes**, **Chambres** (import CSV, opérations en masse), **Boîtiers** (fiche équipement : identité, chambre, modèle, versions, état désiré vs réel, applis, commandes, historique, logs, télémétrie, **télécommande virtuelle**).
- **Applications** : tableau par hôtel « Application | Installée | Autorisée | Visible | Suspendue | Masquée | Capacité | Écart » calculé à partir de l'**état réel remonté** (avec date d'observation) ; catalogue APK (upload, analyse, publication, historique de versions) ; **déploiements** (ciblage tous hôtels / hôtel / groupe / chambre / boîtier, anneaux, fenêtre de maintenance, pause/reprise, roll-forward, suivi temps réel).
- **Configuration** : éditeur par niveau avec affichage de la valeur effective et de son origine ; verrouillage de clés ; versions et retour arrière de config.
- **Contenus** (médiathèque, playlists, programmation), **Campagnes** (ciblage, planification, statistiques agrégées), **IPTV** (sources, lineups, état de sync, chaînes en échec).
- **Séjours** : check-in/check-out manuel, statut et rapport de nettoyage par boîtier ; plus tard PMS.
- **Services** : Room Service (menus, produits, disponibilités, commandes en temps réel avec statuts : reçue, acceptée, en préparation, livrée, annulée) ; modules activables.
- **Utilisateurs & rôles**, **Journal d'audit**, **Matériel compatible** (liste, statuts, rapports, soumission), **Abonnement** (plan, modules, quotas).
- **PWA Technicien** (`/tech`, mobile) : scan QR d'appairage, choix chambre, remplacement, checklists de certification manuelle, diagnostics, code de maintenance.
- **Aperçu du Launcher** (rendu web du même schéma de mise en page) — P1.
- i18n de l'admin : fr et en minimum (puis les 7 langues).

---

## 13. Check-in / check-out et nettoyage de session

- **Check-in** (manuel ou PMS) : crée/active le `stay`, met à jour la couche de configuration ROOM « séjour » (langue, prénom si consentement, message), le Launcher se rafraîchit.
- **Check-out** : crée `cleanup_jobs` pour le(s) boîtier(s) de la chambre → commande `CHECKOUT_CLEANUP` (persistée, exécutée dès que le boîtier est joignable) :
  1. retour au Launcher ; 2. pour chaque appli, application de sa `cleanup_policy` (défauts : streaming tiers = `CLEAR_DATA` ; HOTEL IPTV = reset des favoris/historique, conservation du lineup ; Launcher = conservation de la config, purge des données de séjour ; DPC = jamais) ; 3. relecture/validation ; 4. réinitialisation langue/volume (si supporté)/préférences ; 5. rapport (SUCCEEDED / PARTIAL / FAILED par appli, avec motifs) ; 6. retour à l'accueil standard.
- L'admin affiche clairement : « Les données locales ont été effacées. Les données conservées par les éditeurs sur leurs serveurs ne sont pas concernées. »
- Comptes Google système : **ne pas tenter de les supprimer**. Le client ne doit pas pouvoir en ajouter (`DISALLOW_MODIFY_ACCOUNTS`). Comportement YouTube/compte technique : `[HW-REQUIRED]`, documenter les résultats de la Phase 1.
- Données de séjour purgées selon `retention_policies` (défaut : prénom et référence PMS supprimés 30 jours après le départ ; configurable).

---

## 14. Sécurité et RGPD (`docs/SECURITY.md`, `docs/RGPD.md`)

- HTTPS/TLS 1.2+ partout, HSTS ; WS uniquement en WSS.
- Isolation : RLS Postgres + gardes NestJS + **tests automatisés d'isolation** pour chaque endpoint (un utilisateur de l'org A ne voit jamais l'org B — test généré pour toute nouvelle route).
- Admins : OIDC, 2FA obligatoire, sessions courtes, rate limiting, verrouillage après échecs, permissions fines, audit.
- Boîtiers : clés Keystore, JWT courts, révocation, rotation, enrôlement à usage unique, politique signée Ed25519.
- APK : analyse serveur à l'upload (`apksigner verify --print-certs`, `aapt2 dump badging`, sha256, ABI, permissions dangereuses signalées, option antivirus), épinglage du certificat par package, attestation de droit de distribution par l'uploader, URL de téléchargement signée et vérification sha256 sur le boîtier.
- Clés de signature de nos APK et clé de signature des politiques : en KMS/HSM, jamais dans le dépôt ; procédure de rotation documentée.
- Chiffrement applicatif des secrets (identifiants IPTV/PMS) — enveloppe KMS.
- Sauvegardes Postgres quotidiennes + PITR, test de restauration documenté.
- RGPD : HOTEL OS = sous-traitant (art. 28), l'hôtel = responsable de traitement ; minimisation (pas d'historique de visionnage par client, statistiques publicitaires agrégées, pas de nom complet nécessaire) ; durées de conservation configurables ; export/suppression des données d'un séjour ; registre des sous-traitants ; hébergement UE.
- Captures d'écran à distance désactivées par défaut et refusées pendant un séjour actif.

---

## 15. Certification matérielle

- `docs/HARDWARE_TEST_PLAN.md` et `docs/CERTIFICATION.md`.
- Mode « Certification » du DPC : suite d'auto-tests (DO actif, chaque restriction appliquée et relue, HOME persistant effectif, suspension/masquage relus pour une liste de paquets cibles dont Netflix, YouTube, Prime Video, Disney+, Spotify, Paramètres, Play Store, assistant, launcher d'origine ; install/désinstall silencieuse de `android/test-apps` ; `clearApplicationUserData` ; `reboot` ; heure/fuseau ; niveau Widevine via `MediaDrm` ; codecs ; résolution/HDR ; réseau ; présence GMS) → rapport JSON → module HARDWARE COMPATIBILITY.
- Checklist manuelle dans la PWA (boutons de télécommande dédiés, micro, menus constructeur, CEC, Netflix HD, coupure électrique, reset matériel).
- Calcul du statut CERTIFIED / PARTIAL / INCOMPATIBLE à partir de critères bloquants configurables ; les fonctions indisponibles d'un modèle PARTIAL sont automatiquement grisées dans l'admin pour les boîtiers de ce modèle.

---

## 16. Supervision et alertes

- Présence temps réel (Redis), `last_seen_at`, historique.
- Alertes (e-mail au MVP, puis webhooks) : boîtier hors ligne > N min, kiosque non conforme, DO perdu / boîtier réinitialisé, crash-loop Launcher/DPC, échec d'install, rollout en échec (auto-pause si taux d'échec > seuil), disque < 10 %, chaîne IPTV en échec, nettoyage échoué, firmware inconnu détecté.
- Fiche équipement complète, journaux téléversables à la demande, diagnostics réseau (DNS, latence, accès CDN/API).

---

## 17. Mises à jour

- Toutes les APK (Launcher, IPTV, DPC, catalogue) passent par le même moteur de rollout.
- Anneaux par défaut : LAB (boîtiers internes) → CANARY (1 chambre test par hôtel volontaire) → 5 % → 25 % → 100 %, avec critères de santé (heartbeat Launcher dans les 5 min, pas de crash-loop) et pause automatique.
- Fenêtre de maintenance par hôtel (défaut 03:00–05:00 heure locale) ; report si l'écran est actif ou une lecture en cours.
- Téléchargements étalés (jitter) pour ne pas saturer le lien Internet de l'hôtel ; reprise des téléchargements interrompus ; vérification sha256 ; reprise après coupure électrique pendant une installation (état persistant).
- Rollback = **roll-forward** (versionCode supérieur) pour nos APK ; pour les APK tierces : désinstallation + réinstallation de l'ancienne version, avec avertissement « perte de données ».
- Mises à jour des applis natives Play Store : non pilotées par nous ; seulement observées (version remontée). Politique OTA système via `setSystemUpdatePolicy` (respect par le fabricant `[HW-REQUIRED]`).
- Mode « Deploy to all hotels » : réservé PLATFORM_ADMIN, double confirmation, toujours en anneaux, filtre automatique des boîtiers incompatibles (SDK, ABI, modèle).

---

## 18. Hors ligne

- Le boîtier fonctionne indéfiniment avec la dernière politique signée valide, le dernier contenu en cache et le dernier lineup/EPG.
- Les actions client (commande room service) en hors ligne : refusées avec message clair (pas de file locale silencieuse au MVP) — ADR si tu proposes mieux.
- À la reconnexion : envoi de l'état, récupération de la politique, exécution des commandes en attente non expirées, envoi des rapports en file.

---

## 19. PMS

- Interface `PmsConnector` (dans `apps/api/src/pms/`) : `pullStays`, `onWebhook`, `mapRoom`, `healthCheck` ; événements normalisés `CHECK_IN`, `CHECK_OUT`, `ROOM_MOVE`, `GUEST_UPDATE` (langue, prénom).
- MVP : **connecteur manuel** (l'admin fait le check-in/out). V1 : **Mews** et **Apaleo** (API ouvertes). Plus tard : Cloudbeds, Oracle OPERA Cloud (OHIP), FIAS via passerelle on-premise. Aucune donnée PMS au-delà du strict nécessaire.

---

## 20. Tests (`docs/TEST_STRATEGY.md`)

- **Unitaires** : policy-engine (couverture ≥ 95 %), protocole, services NestJS, ViewModels Android, réconciliateur DPC (avec fausse implémentation de `DevicePolicyManager` derrière une interface — **les tests doivent le dire**).
- **Intégration** : API + Postgres + Redis via Testcontainers ; tests d'isolation tenant obligatoires.
- **Contrat** : schémas `packages/protocol` validés côté serveur et côté Kotlin (mêmes fixtures JSON).
- **E2E admin** : Playwright.
- **Android** : tests instrumentés sur **émulateur Android TV** (Compose UI, focus, RTL) ; DPC sur émulateur avec `dpm set-device-owner` pour ce qui est testable.
- **Charge** : `apps/device-simulator` — 1 000 puis 10 000 boîtiers simulés (WS, heartbeats, politiques, commandes) avec objectifs : diffusion d'une commande < 2 s p95, recalcul de politique d'un hôtel de 500 chambres < 5 s.
- **Matériel réel** `[HW-REQUIRED]` : scripts et checklists dans `docs/HARDWARE_TEST_PLAN.md` ; tu prépares les scripts ADB et les procédures, l'équipe humaine exécute et te renvoie les rapports.
- **Sécurité** : dépendances (audit), SAST, tests d'autorisation par rôle.

---

## 21. Phases de développement

Pour chaque phase : livrer, tester, documenter, mettre à jour `docs/PROGRESS.md`, lister les points `[HW-REQUIRED]` en attente. Ne passe à une phase dépendante que lorsque les critères de sortie sont atteints (ou explicitement levés par l'équipe).

### Phase 0 — Audit et fondations (toi seul)
Audit (`docs/AUDIT.md`), monorepo, CI, docker compose, `docs/ARCHITECTURE.md` (diagrammes Mermaid : composants, séquences enrôlement / politique / commande / check-out / rollout), ADR initiaux (stack, JWT vs mTLS, kiosque à deux niveaux, roll-forward).
**Sortie** : `pnpm build && pnpm test` et `./gradlew assembleDebug test` passent en CI.

### Phase 1 — Validation technologique `[HW-REQUIRED]`
DPC « POC » + `provisioning-cli` minimal + `test-apps` + mode Certification ; scripts ADB ; procédure de test. **Sortie** : rapports de certification de 3–5 modèles réels fournis par l'équipe ; décision sur les modèles MVP et sur le compte Google technique consignée en ADR.

### Phase 2 — Socle serveur (en parallèle de la Phase 1)
Schéma BDD + RLS, auth admin + 2FA, tenancy/rôles/audit, hôtels/groupes/chambres/boîtiers, enrôlement + appairage, protocole v1 (REST+WS), policy-engine + signature, file de commandes, simulateur de boîtiers.
**Sortie** : simulateur de 1 000 boîtiers enrôlés, recevant politiques et commandes ; tests d'isolation verts ; OpenAPI publiée.

### Phase 3 — DPC complet + Launcher
DPC (sync, réconciliateur, kiosque deux niveaux, watchdog, lanceur de secours, AIDL) ; Launcher (template 1, i18n 7 langues + RTL, cache hors ligne) ; écrans admin associés.
**Sortie** : sur émulateur — parcours complet ; sur matériel `[HW-REQUIRED]` — boot direct sur Launcher, impossibilité d'atteindre les paramètres, survie à 20 coupures électriques.

### Phase 4 — Gestion des applications
Inventaire natif, tableau désiré/réel, catalogue APK + analyse, déploiements par anneaux, fenêtres de maintenance, roll-forward, Deploy to all hotels.
**Sortie** : sur matériel — suspendre/masquer Netflix et YouTube depuis l'admin, état relu affiché en < 1 min ; installation/mise à jour d'une APK de test sur 100 % des boîtiers de test avec rapport.

### Phase 5 — HOTEL IPTV (parallèle à la Phase 4)
Ingestion serveur, lineup/EPG, appli Media3, admin IPTV.
**Sortie** : HLS + UDP multicast lus 72 h sans intervention `[HW-REQUIRED]` ; EPG correct ; reprise après coupure réseau.

### Phase 6 — Services hôteliers
CMS + programmation, campagnes + stats agrégées, check-in/out manuel + moteur de nettoyage + rapports, Room Service, messages vers chambre, message d'urgence, connecteurs Mews/Apaleo.
**Sortie** : 100 cycles check-in/out automatisés sur boîtier de test avec rapports exacts `[HW-REQUIRED]`.

### Phase 7 — Supervision
Télémétrie, alertes, fiche équipement complète, télécommande virtuelle, diagnostics, logs à la demande.
**Sortie** : alerte « hors ligne » < 2 min ; chaque commande tracée de bout en bout.

### Phase 8 — Industrialisation
Certification de nouveaux modèles (workflow de soumission), tests de charge 10 000 boîtiers, revue de sécurité, entitlements/abonnements (Stripe), portail client, documentation d'installation (`docs/INSTALL_GUIDE.md`, `docs/PROVISIONING.md`, `docs/NETWORK_REQUIREMENTS.md`), runbooks d'exploitation, génération des APK **release** signées (signature effectuée hors CI par l'équipe avec les clés KMS — tu prépares la configuration et la procédure).

**Hors périmètre actuel (architecture prête, pas de code)** : clients Tizen/webOS, casting sécurisé, Edge local, portail revendeur, monétisation publicitaire, paiement en chambre.

---

## 22. Documentation à produire et maintenir

`AUDIT`, `ARCHITECTURE`, `adr/*`, `DATA_MODEL`, `API` (OpenAPI + guide), `PROTOCOL`, `POLICY_ENGINE`, `ANDROID_ARCHITECTURE`, `DPC`, `IPTV`, `UPDATES`, `SECURITY`, `RGPD`, `HARDWARE_TEST_PLAN`, `CERTIFICATION`, `TEST_STRATEGY`, `PROVISIONING` (pas à pas technicien : reset usine → setup minimal sans compte → options développeur → station de provisioning → QR d'appairage → vérification), `NETWORK_REQUIREMENTS` (VLAN/SSID dédié sans portail captif, Ethernet recommandé, domaines et ports à autoriser, multicast/IGMP pour IPTV, bande passante), `INSTALL_GUIDE`, `RUNBOOKS` (boîtier réinitialisé, rollout en échec, rotation de clés, restauration BDD), `PROGRESS`.

---

## 23. Première action attendue

1. Lis ce document en entier.
2. Exécute la **Phase 0** : audit du dépôt, création du monorepo et de la CI, documents d'architecture et ADR initiaux.
3. Termine par un compte rendu : ce qui est fait, comment c'est vérifié, ce qui reste, et la liste des éléments `[HW-REQUIRED]` que l'équipe doit préparer pour la Phase 1 (modèles de boîtiers à acheter, câbles, réseau de test, comptes de streaming de test).
