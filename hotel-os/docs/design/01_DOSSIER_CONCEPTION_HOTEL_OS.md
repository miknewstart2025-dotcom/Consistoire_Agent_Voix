# HOTEL OS — Dossier de conception (v1.0, 19/11/2026)

> Document d'architecture préalable au développement. Il répond aux parties A à E de la mission.
> Le MASTER PROMPT (partie F) est dans `02_MASTER_PROMPT_CLAUDE_CODE.md`.
>
> **Convention de fiabilité** utilisée partout :
> - ✅ **Garanti** : API Android officielle, comportement documenté.
> - ⚠️ **À valider sur matériel** : documenté, mais le comportement dépend du fabricant / firmware / version.
> - ❌ **Impossible / interdit** : non faisable techniquement ou contractuellement — alternative proposée.

---

## A. VISION DU PRODUIT

### A.1 Ce qu'est HOTEL OS

HOTEL OS n'est pas « un launcher » : c'est un **système de gestion de flotte (MDM spécialisé hôtellerie) + une expérience client TV + une plateforme de services**, vendu en SaaS multi-tenant.

Trois plans distincts, qui structurent toute l'architecture :

| Plan | Rôle | Composants |
|---|---|---|
| **Plan de contrôle** | Ce que le boîtier a le droit de faire | Device Controller (DPC), moteur de politiques serveur, file de commandes |
| **Plan d'expérience** | Ce que voit le client | Launcher, IPTV, modules de services (room service, spa…) |
| **Plan métier** | Ce que gère l'hôtel | HOTEL MANAGER (CMS, PMS, campagnes, supervision, facturation SaaS) |

Le principe central est un **modèle déclaratif « état désiré / état réel »** (comme Kubernetes) :
le serveur calcule pour chaque boîtier une *politique effective* versionnée et signée ; le DPC la *réconcilie* en permanence avec l'état réel d'Android, puis renvoie l'état observé. HOTEL MANAGER affiche toujours **les deux** (désiré vs réel) et l'écart. C'est ce qui garantit que « le tableau affiché correspond à la réalité ».

### A.2 Différenciation vs solutions hôtelières classiques

Les acteurs historiques (systèmes IPTV hôteliers avec tête de réseau, TV hospitality Samsung LYNK / LG Pro:Centric, intégrateurs type « interactive TV ») reposent sur du **matériel imposé**, des déploiements lourds et des contrats longs.
HOTEL OS se différencie par :

1. **Matériel libre mais certifié** : l'hôtel achète des boîtiers du commerce figurant dans la liste certifiée — coût d'entrée très inférieur.
2. **Les vraies applis de streaming du client** (Netflix, YouTube, Prime…) dans un environnement verrouillé, avec nettoyage à chaque départ.
3. **Contrôle réel au niveau OS** (Device Owner), pas un simple habillage.
4. **Self-service SaaS** : un hôtel indépendant peut s'équiper sans intégrateur ; un groupe pilote 50 établissements depuis une seule console.
5. **Auto-certification automatisée** : le DPC embarque une suite de tests qui produit un rapport de compatibilité d'un nouveau modèle en quelques minutes.
6. **Architecture multi-plateforme** pensée dès le départ (Android d'abord, Tizen/webOS ensuite via des clients dédiés).

### A.3 Ce que HOTEL OS ne sera pas (honnêteté produit)

- Il ne pourra pas **garantir** Netflix/Disney+/Prime sur n'importe quel boîtier : cela dépend de la certification Google (GMS) et DRM (Widevine L1) du modèle.
- Il ne pourra pas **gérer les comptes** Netflix/YouTube à la place du client (injection d'identifiants impossible et interdite).
- Il ne pourra pas **effacer les données côté serveurs des éditeurs** — seulement les données locales du boîtier.
- Un boîtier peut toujours être réinitialisé physiquement (bouton reset / recovery) : on ne peut que **détecter et ré-enrôler vite**, pas l'empêcher à 100 %.

---

## B. ANALYSE CRITIQUE

### B.1 Faiblesses du cahier des charges actuel

| # | Faiblesse | Impact | Correction proposée |
|---|---|---|---|
| 1 | **Le provisioning par QR code est présumé possible sur Android TV.** À notre connaissance, l'assistant de configuration Android TV/Google TV ne propose ni QR code ni NFC pour devenir Device Owner (contrairement aux téléphones). ⚠️ | Toute la procédure d'installation est à revoir. | Provisioning via **station de provisioning** (ADB USB/réseau, outil fourni par nous) ; QR code utilisé ensuite pour **associer le boîtier à une chambre** (affiché sur la TV, scanné par le smartphone du technicien). Voie OEM (firmware avec DPC préinstallé) en V2. |
| 2 | **Conflit non identifié : Device Owner vs comptes Google vs mises à jour Play Store.** `dpm set-device-owner` exige un appareil **sans aucun compte**. Mais sans compte Google, le Play Store ne met plus à jour Netflix/YouTube, qui finissent par refuser de fonctionner. | Les applis natives — argument commercial n°1 — se dégradent avec le temps. | Séquence : DO d'abord, puis ajout d'un **compte Google technique de l'hôtel** (Play Store masqué au client, mises à jour en arrière-plan). À valider en Phase 1 (décision D2). |
| 3 | **Compte Google technique = fuite de vie privée YouTube.** Sur Android TV, YouTube utilise les comptes Google du système : un client qui « se connecte à YouTube » ajoute un compte au système, et le compte technique risque d'apparaître. | Risque RGPD et d'image. | Interdire l'ajout de comptes par le client (`DISALLOW_MODIFY_ACCOUNTS`), désactiver l'historique du compte technique, privilégier **YouTube en mode non connecté + Cast/« Lien avec le téléphone »**. À tester. |
| 4 | **Netflix « mode B compte hôtel » présenté comme une option.** Le partage d'un compte Netflix entre clients est contraire aux CGU. Netflix dispose en revanche d'un **programme hospitality pour partenaires certifiés** (déconnexion automatique au check-out). | Risque juridique. | Mode A uniquement au MVP ; candidature au programme partenaire Netflix en parallèle (dépendance externe, délai inconnu). |
| 5 | **Aucune mention du réseau hôtelier.** Portails captifs, isolation client Wi-Fi, VLAN, multicast IPTV, bande passante lors d'un déploiement d'APK sur 300 chambres. | Échecs terrain massifs. | Cahier des **prérequis réseau** (SSID/VLAN dédié TV sans portail captif, Ethernet recommandé, liste de domaines à autoriser), téléchargements étalés, option **Edge local** en V2. |
| 6 | **« Retour arrière » des APK présumé simple.** Android interdit le downgrade d'une APK (versionCode inférieur) sans désinstallation, ce qui efface les données. | Rollback impossible tel que décrit. | **Roll-forward** : republier l'ancien code avec un versionCode supérieur. Pour nos APK : build « rollback » systématiquement préparé. Pour les APK tierces : désinstaller + réinstaller (perte de données), clairement signalé. |
| 7 | **Mise à jour du DPC sous-estimée.** Si une nouvelle version du DPC plante en boucle, le boîtier peut être perdu (seul le DPC est propriétaire de l'appareil). | Perte de flotte. | DPC minimal et très testé, anneaux de déploiement (labo → canari → 5 % → 100 %), détection de boucle de crash avec mode dégradé, jamais de DPC « fat ». |
| 8 | **Confusion masquage / suspension / blocage.** Ces trois mécanismes ont des effets différents (voir C.4). Un bouton « Netflix » de télécommande peut ouvrir le Play Store si Netflix est masqué. | Contournements faciles. | Matrice d'état par appli + traitement des boutons dédiés de la télécommande et de l'assistant vocal. |
| 9 | **Le modèle commercial n'existe pas dans le modèle de données** (revendeurs, intégrateurs, franchises). Le marché hôtelier se vend largement par des intégrateurs. | Refonte coûteuse plus tard. | Niveau **Partner/Revendeur** dans la hiérarchie dès le jour 1 (même s'il est vide au MVP). |
| 10 | **Les données de diffusion publicitaire peuvent devenir des données personnelles** (chambre + date = client identifiable via le PMS). | RGPD. | Statistiques **agrégées** (par jour/groupe), jamais rattachées au séjour. |
| 11 | **Droits de diffusion TV.** La diffusion de chaînes en chambre est juridiquement une « communication au public » (jurisprudence CJUE 2006, *SGAE c/ Rafael Hoteles*) : droits à payer par l'hôtel. | Exposition juridique de l'hôtel (et réputationnelle pour nous). | Clause contractuelle + case à cocher d'attestation à la création d'une source IPTV. |
| 12 | **HDMI-CEC, volume, allumage TV** non spécifiés. Le contrôle CEC est une API système non accessible à un DPC tiers. | Promesses impossibles. | Traité comme **critère de certification** (comportement natif du boîtier), pas comme fonctionnalité pilotable. |

### B.2 Fonctionnalités manquantes (priorisées)

**P0 = MVP, P1 = V1 commerciale, P2 = V2, P3 = plus tard.**

| Fonctionnalité | Prio | Commentaire |
|---|---|---|
| Station de provisioning + appli technicien (PWA) pour associer boîtier ↔ chambre par QR | P0 | Remplace le QR Android TV impossible |
| Remplacement de boîtier (transfert d'identité de chambre en 1 scan) | P0 | Demandé, à outiller |
| Détection de réinitialisation / perte du Device Owner + alerte | P0 | |
| Mode maintenance (désactive le kiosque temporairement via code technicien à usage unique, horodaté, journalisé) | P0 | Indispensable sur site |
| Lanceur de secours intégré au DPC (si le Launcher est absent/crashe) | P0 | « Ne jamais perdre le contrôle » |
| Fenêtres de maintenance + report si TV en cours d'utilisation | P0 | |
| Synchronisation heure/fuseau forcée (`setAutoTimeEnabled`, `setTimeZone`) | P0 | Sans heure correcte : TLS échoue |
| Configuration Wi-Fi distante (ajout réseau par le DPC) | P1 | Changement de mot de passe Wi-Fi de l'hôtel |
| **Message d'urgence prioritaire** (alarme incendie, évacuation) sur tous les écrans, plein écran, multilingue | P1 | Forte valeur, souvent oublié. Attention : ne remplace jamais un système de sécurité incendie réglementaire |
| Messagerie réception → chambre, réveil (wake-up call) | P1 | |
| Volume : plafond et volume de démarrage (si l'audio est géré par le boîtier) | P1 | ⚠️ si le volume est géré par la TV via CEC, hors de portée |
| Retour automatique à l'accueil après inactivité / extinction | P1 | |
| Politique de mise à jour système OTA (`setSystemUpdatePolicy`, fenêtre ou gel) | P1 | ⚠️ certains OEM l'ignorent |
| Blocage de l'assistant vocal / bouton micro (peut lancer des applis désactivées) | P1 | |
| Bluetooth : autoriser/interdire l'appairage du client (casque) et purge au départ | P2 | ⚠️ suppression des appairages non exposée aux DPC — souvent : interdire |
| **Casting (Chromecast intégré / Google Cast)** sécurisé par chambre | P2 | Très demandé ; nécessite une architecture réseau d'isolation, à étudier |
| Facture / express check-out / post de commande sur la note de chambre via PMS | P2 | |
| Enquête de satisfaction au départ | P2 | |
| Mode affichage dynamique (lobby, restaurant, salles de réunion) | P2 | Même boîtier, profil « signage » |
| Contrôle parental / code PIN pour certaines chaînes | P2 | |
| Accessibilité (taille de texte, contraste, sous-titres par défaut) | P2 | |
| Edge local (cache APK/médias, proxy PMS FIAS, multicast) | P2 | |
| Portail revendeur / marque blanche | P2 | |
| SSO entreprise (SAML/OIDC) pour groupes hôteliers | P2 | |
| Webhooks + API publique partenaires | P2 | |
| Aperçu WYSIWYG du Launcher dans l'admin | P1 | Réduit énormément le support |
| Import CSV des chambres, opérations en masse | P0 | |
| Versionnement des configurations + retour arrière de config | P1 | |
| Page de statut / SLA | P2 | |
| Kill-switch facturation : passage en mode « accueil basique » si impayé (jamais d'écran noir) | P1 | |

### B.3 Fonctionnalités techniquement risquées

| Fonctionnalité | Niveau de risque | Raison |
|---|---|---|
| Device Owner sur le matériel retenu | **Élevé** | Dépend entièrement du firmware ; c'est le *go/no-go* du projet |
| Remplacement du launcher d'origine (bouton HOME) sur Google TV | **Élevé** | Certains firmwares Google TV traitent le bouton HOME de manière spécifique ; DO + `addPersistentPreferredActivity` + masquage du launcher d'origine fonctionne sur beaucoup d'appareils mais doit être prouvé par modèle |
| Netflix/Disney+/Prime | **Élevé** | Certification Google + Widevine L1 + éventuel programme hospitality |
| Nettoyage de session YouTube (comptes Google) | **Élevé** | Comptes au niveau système |
| Mise à jour du DPC | Moyen | Maîtrisable par process |
| Suspension d'applis système | Moyen | Certains packages sont protégés par le système |
| IPTV multicast UDP | Moyen | Dépend du réseau de l'hôtel (IGMP) |
| Intégrations PMS on-premise (FIAS) | Moyen | Certification Oracle, présence réseau locale |
| Tizen / webOS | Moyen | Programmes partenaires constructeurs, autre stack |

---

## C. RECOMMANDATIONS

### C.1 Architecture générale

```
                     ┌────────────────────────── CLOUD (UE) ───────────────────────────┐
  Admins hôtel ──►   │  HOTEL MANAGER (Next.js)  ──REST──►  API Core (NestJS, monolithe │
  Techniciens ──►    │  PWA Technicien                      modulaire)                  │
                     │                                         │   │   │                │
                     │  Workers (BullMQ) ◄── Redis ────────────┘   │   └─► PostgreSQL   │
                     │  - ingestion M3U/XMLTV                      │       (RLS tenant) │
                     │  - connecteurs PMS                          │                    │
                     │  - analyse APK, rollouts, purge RGPD        ▼                    │
                     │                               Device Gateway (WebSocket, même    │
                     │  Stockage objet S3 + CDN ◄─── code, process séparé, scalable)    │
                     └───────────────▲──────────────────────────▲───────────────────────┘
                                     │ HTTPS (APK, médias)      │ WSS + REST (mTLS/JWT signé)
                     ┌───────────────┴──────────────────────────┴──────────────┐
                     │ BOÎTIER ANDROID TV (chambre)                             │
                     │  HOTEL DEVICE CONTROLLER (DPC, Device Owner)             │
                     │   - identité (Android Keystore), sync, politiques,       │
                     │     commandes, installations, kiosque, nettoyage,        │
                     │     watchdog, lanceur de secours                         │
                     │        │ AIDL protégé par permission « signature »       │
                     │        ├──► HOTEL LAUNCHER (Compose for TV)             │
                     │        └──► HOTEL IPTV (Media3)                         │
                     │  Applis natives : Netflix, YouTube… (suspendues/masquées)│
                     └──────────────────────────────────────────────────────────┘
```

Principes :
- **Monolithe modulaire** côté serveur (un seul dépôt, un seul déploiement API + un process Gateway + des workers). Pas de microservices au démarrage.
- **Le DPC est l'unique agent de contrôle** du boîtier et le seul détenteur de l'identité forte. Launcher et IPTV obtiennent des **jetons délégués courts** via AIDL (permission de niveau signature) → un crash ou une mise à jour du Launcher n'affecte jamais le contrôle.
- **Politique effective signée** par le serveur (Ed25519) : le DPC refuse toute politique non signée, même via un CDN ou un proxy compromis.
- **Hors ligne par défaut** : le boîtier fonctionne indéfiniment sur la dernière politique valide et le dernier contenu en cache.

### C.2 Choix technologiques recommandés

| Couche | Choix | Pourquoi | Alternatives écartées |
|---|---|---|---|
| Admin web | **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui**, i18n (next-intl) | Écosystème que vous maîtrisez déjà (vos autres dépôts), SSR utile pour le portail client | SPA Vite pure : OK aussi mais moins adaptée au portail public |
| Backend | **NestJS (TypeScript)** monolithe modulaire | Structure modulaire, DI, WebSocket gateway intégrée, validation, OpenAPI auto ; même langage que le front (types partagés) | Go (plus performant mais 2 langages) ; Supabase seul (pas adapté à une gateway WebSocket longue durée, logique métier complexe, RLS insuffisant seul) |
| ORM | **Prisma** ou **Drizzle** (préférence Drizzle pour le SQL explicite + RLS) | Migrations versionnées | |
| BDD | **PostgreSQL 16+ managé, hébergé UE** (Scaleway / OVHcloud / AWS eu-west-3) avec **Row-Level Security** | Robuste, JSONB pour les politiques, RLS = 2ᵉ barrière d'isolation tenant | Supabase utilisable comme *hébergeur Postgres*, mais pas comme backend applicatif |
| Cache / files | **Redis + BullMQ** | Jobs (ingestion EPG, rollouts, PMS), pub/sub entre instances de gateway | Kafka : surdimensionné |
| Stockage | **S3 compatible** (Scaleway Object Storage / R2) + **CDN**, URLs signées | APK, médias, icônes | |
| Temps réel boîtiers | **WebSocket (WSS) + REST de repli + interrogation périodique** | Simple, suffisant jusqu'à ~50–100 k connexions avec plusieurs instances | **MQTT** (EMQX/Mosquitto) : à reconsidérer au-delà de 100 k boîtiers. **FCM écarté** : dépend des Google Play services, pas garanti sur tous les boîtiers |
| Android | **Kotlin, Jetpack Compose for TV (`androidx.tv`), Coroutines/Flow, Room, WorkManager, Hilt, Ktor ou OkHttp** | Standard actuel ; Compose for TV gère le focus D-pad | Leanback (déprécié de fait) |
| Lecteur vidéo | **AndroidX Media3 ExoPlayer** | HLS, DASH, RTSP, UDP/TS, Widevine | VLC-lib (licence LGPL, plus lourd) en secours pour formats exotiques |
| minSdk Android | **API 28 (Android 9)** ; cible = dernière API | `clearApplicationUserData`, `setLockTaskFeatures`, `setTimeZone` requièrent API 28 | |
| Auth admins | OIDC (Keycloak auto-hébergé ou service managé type WorkOS/Auth0) + **2FA obligatoire (TOTP/WebAuthn)** | SSO entreprise ensuite | Auth maison : déconseillé |
| Observabilité | OpenTelemetry + Prometheus/Grafana + Sentry (backend + Android) | | |
| Infra | Docker, déploiement conteneurs (Kubernetes managé ou Scaleway Serverless Containers / Fly.io au départ), IaC Terraform | Le Next.js admin peut rester sur Vercel ; **l'API et la gateway WebSocket ne doivent pas être sur des fonctions serverless** | |
| Monorepo | **pnpm + Turborepo** (TS) + **Gradle multi-modules** (Android) dans un même dépôt `hotel-os` | Types/protocoles partagés, CI unique | |

### C.3 Stratégie Android : DPC propriétaire (recommandé)

| Option | Verdict |
|---|---|
| **Android Management API (AMAPI)** | ❌ pour le cœur. AMAPI s'appuie sur l'appli *Android Device Policy* de Google ; le support des appareils **Android TV n'est pas documenté officiellement**. Usage en production soumis aux conditions et quotas Google (les projets démarrent avec un quota limité et doivent être approuvés pour un usage commercial). Dépendance totale à Google pour une fonction critique. ⚠️ À re-vérifier sur la documentation à date, mais ne pas bâtir dessus. |
| **EMM tiers en marque blanche** (Esper, Scalefusion, Hexnode…) | Possible pour un POC rapide, mais coût par appareil, dépendance fournisseur, et le cœur de valeur (politique d'applis, nettoyage, kiosque hôtelier) serait chez un tiers. Écarté pour le produit. |
| **DPC propriétaire (Device Owner, `DevicePolicyManager`)** | ✅ **Recommandé.** API publiques, gratuites, aucune licence Google requise ; contrôle total ; fonctionne sur tout appareil acceptant `dpm set-device-owner`. Les limites sont celles du firmware → d'où la certification. |
| **Application système / firmware OEM** (DPC préinstallé, signé plateforme) | V2, via partenariat avec 1–2 fabricants : provisioning sans ADB, contrôle CEC/volume/OTA possible via API OEM. |

**Mécanismes retenus dans le DPC** (tous ✅ API officielles `DevicePolicyManager`, sous réserve de validation par modèle ⚠️) :

- Kiosque : `addPersistentPreferredActivity(HOME)` vers le Launcher ; `setLockTaskPackages` + `setLockTaskFeatures` (mode strict, voir ci-dessous) ; `setStatusBarDisabled` ; `setKeyguardDisabled`.
- Restrictions utilisateur (`addUserRestriction`) : `DISALLOW_INSTALL_APPS`, `DISALLOW_INSTALL_UNKNOWN_SOURCES(_GLOBALLY)`, `DISALLOW_UNINSTALL_APPS`, `DISALLOW_FACTORY_RESET`, `DISALLOW_SAFE_BOOT`, `DISALLOW_DEBUGGING_FEATURES`, `DISALLOW_CONFIG_WIFI`, `DISALLOW_CONFIG_BLUETOOTH`, `DISALLOW_MODIFY_ACCOUNTS`, `DISALLOW_ADD_USER`, `DISALLOW_MOUNT_PHYSICAL_MEDIA`, `DISALLOW_USB_FILE_TRANSFER`, `DISALLOW_CONFIG_DATE_TIME`, `DISALLOW_APPS_CONTROL`, `DISALLOW_NETWORK_RESET`…
- Applis : `setPackagesSuspended`, `setApplicationHidden`, `enableSystemApp`, `PackageInstaller` (installation/désinstallation **silencieuses** en Device Owner), `clearApplicationUserData` (API 28), `setUninstallBlocked`.
- Système : `reboot`, `setTimeZone`, `setAutoTimeEnabled` (API 30, sinon `setAutoTimeRequired`), `setSystemUpdatePolicy`, `setScreenCaptureDisabled`, `setGlobalSetting` (liste blanche limitée), `setPermissionGrantState`/`setPermissionPolicy`.

**Kiosque : deux niveaux par profil, choisis après la Phase 1**
1. **« Enforced Home »** (défaut) : Launcher = HOME persistant + launcher d'origine masqué + Paramètres/Play Store/assistant suspendus ou masqués + restrictions. Les applis autorisées fonctionnent normalement (y compris leurs dépendances : WebView, Google Play services).
2. **« Strict Lock Task »** : en plus, `startLockTask` avec liste blanche = Launcher + applis activées + paquets techniques requis. Plus robuste contre les raccourcis, mais une appli qui ouvre une activité d'un paquet non listé (sélecteur de compte Google, navigateur…) sera bloquée → à valider appli par appli.

### C.4 Matrice des états d'application (référence)

| Mécanisme | Icône | Lancement par le client | Bouton dédié télécommande / voix | Données conservées | Mises à jour Play |
|---|---|---|---|---|---|
| Autorisé | visible | ✅ | ✅ | oui | oui |
| **Suspendu** (`setPackagesSuspended`) | masquée par notre Launcher (grisée dans un launcher système) | ❌ dialogue système « appli suspendue » | ❌ bloqué | oui | ⚠️ à tester |
| **Masqué** (`setApplicationHidden`) | absente | ❌ (paquet considéré comme non installé) | ⚠️ peut rediriger vers la fiche Play Store → Play Store doit être suspendu | oui | ❌ non |
| Masqué *Launcher seulement* | absente | ⚠️ contournable | ⚠️ contournable | oui | oui |
| Non suspendable (paquet protégé) | — | signalé dans l'admin comme **« non bloquable sur ce modèle »** | | | |

**Règle par défaut :** désactiver = *suspendre* (blocage système le plus fiable, mises à jour préservées) ; *masquer* en option pour les applis à faire disparaître totalement. Le DPC **relit** l'état (`isPackageSuspended`, `isApplicationHidden`) après chaque action et remonte la capacité réelle : c'est cette valeur, pas l'intention, qu'affiche HOTEL MANAGER.

### C.5 Résumé des 18 études techniques obligatoires

| # | Sujet | Possible | Restrictions / conditions | Coût / licence | Recommandation |
|---|---|---|---|---|---|
| 1 | Device Owner Android TV | ✅ via `dpm set-device-owner` (ADB) sur appareil réinitialisé **sans compte** | ⚠️ firmware ; certains OEM bloquent ; ADB doit être activable | Gratuit | Go/no-go Phase 1 sur 3–5 modèles |
| 2 | AMAPI vs DPC | AMAPI ⚠️ non documenté sur TV | Approbation/quota Google | Gratuit mais conditionné | **DPC propriétaire** |
| 3 | Provisioning / QR | ❌ QR/NFC non disponibles sur l'assistant Android TV (à reconfirmer) ; ✅ ADB ; ✅ OEM | ADB nécessite d'activer les options développeur (manipulation de ~1 min/boîtier) | Gratuit | Station de provisioning (USB/réseau, plusieurs boîtiers en parallèle) + QR d'association chambre. **Clé USB seule : ne peut pas donner le statut DO** (elle peut seulement transporter l'APK). |
| 4 | Verrouillage complet | ✅ restrictions + HOME persistant + lock task | ⚠️ menus constructeur, boutons dédiés, panneau rapide Google TV, reset physique | — | Deux niveaux de kiosque + tests par modèle |
| 5 | Suspension / masquage | ✅ API 24 / 21 | Paquets critiques non suspendables (DPC, launcher par défaut actif, installeur, contrôleur de permissions…) | — | Matrice C.4 |
| 6 | Blocage du lancement | ✅ via suspension ; boutons dédiés et assistant = cas particuliers | ⚠️ | — | Suspendre l'assistant vocal si nécessaire |
| 7 | Installation silencieuse | ✅ `PackageInstaller` en DO, sans interaction | APK signée, compatible ABI/SDK | — | ✅ |
| 8 | MAJ auto des APK | ✅ pour nos APK et APK du catalogue | Même certificat de signature obligatoire ; downgrade interdit | — | Roll-forward + anneaux |
| 9 | Signatures / versions | ✅ `apksigner verify`, `aapt2 dump badging` côté serveur | Clés de signature à protéger (KMS/HSM) | Coût KMS faible | Épinglage du certificat par package dans le catalogue |
| 10 | Nettoyage données | ✅ `clearApplicationUserData` (API 28, DO) | Ne touche pas aux comptes système ni aux serveurs éditeurs ; inopérant sur certains paquets | — | Politique de nettoyage par appli + rapport |
| 11 | Netflix / YouTube comptes | ❌ injection d'identifiants ; ✅ connexion par le client (souvent via téléphone) | CGU : pas de compte partagé ; YouTube lié aux comptes Google système | Programme Netflix hospitality : conditions à négocier | Mode A au MVP ; partenariats en parallèle |
| 12 | DRM | ✅ Widevine lisible via `MediaDrm` (`securityLevel`) ; HD/4K Netflix exige L1 + certification appareil | Boîtiers non certifiés Google : pas de Netflix officiel | Porté par le fabricant | Critère de certification bloquant pour les offres « streaming » |
| 13 | IPTV | ✅ Media3 : HLS, DASH, RTSP, UDP/RTP-TS (multicast avec `MulticastLock`) | DRM hôtelier propriétaire (ex. Verimatrix) = intégration spécifique | Licences DRM éventuelles | Ingestion M3U/XMLTV **côté serveur**, lineup + EPG compacts envoyés aux boîtiers |
| 14 | Diffusion multimédia (CMS) | ✅ cache local, lecture hors ligne | Espace disque des boîtiers (8–16 Go) | CDN | Quotas de cache + purge LRU |
| 15 | PMS | ✅ API cloud (Mews, Apaleo, Cloudbeds, OPERA Cloud/OHIP) ; FIAS pour OPERA on-premise | OHIP et FIAS : programme partenaire Oracle payant ; FIAS = connexion TCP locale | Variable | Saisie manuelle au MVP ; Mews + Apaleo en premier ; OPERA ensuite |
| 16 | Commandes distantes | ✅ reboot, lancement appli, rafraîchissement, message, sync, MAJ | Allumer/éteindre la TV : ⚠️ CEC non pilotable par un DPC tiers | — | File de commandes persistante + accusés |
| 17 | Hors ligne | ✅ | Heure système nécessaire pour TLS | — | Dernière politique signée + cache contenu + journal local |
| 18 | Tizen / webOS | ❌ APK impossible ; ✅ applis web hôtelières (Samsung Hospitality / LYNK, LG Pro:Centric) | Accès SDK hospitality via programmes partenaires | Accords constructeurs | Client web dédié en V3, même protocole serveur |

---

## D. POINTS À TRANCHER (seulement ceux qui exigent votre décision)

| # | Décision | Options | Ma recommandation | Pourquoi |
|---|---|---|---|---|
| **D1** | Matériel du MVP | (a) ouvert dès le départ ; (b) **2 modèles certifiés max** | **(b)** — 1 boîtier Google TV certifié du commerce + 1 modèle « Android TV opérateur/hospitality » | La fiabilité est la priorité absolue ; chaque modèle ajoute des semaines de tests. On ouvre la certification en Phase 8. Je vous fournis la grille, vous achetez 3–5 candidats pour la Phase 1. |
| **D2** | Compte Google sur les boîtiers (mises à jour Netflix/YouTube) | (a) aucun compte : pas de MAJ des applis du Play Store ; (b) **compte Google technique ajouté après le Device Owner, Play Store invisible pour le client** ; (c) pas d'applis Google, uniquement IPTV + nos applis | **(b), conditionné à la validation Phase 1** ; (c) comme offre de repli « sans streaming » | Sans mises à jour, les applis de streaming cessent de fonctionner en quelques mois. Points à valider : nombre d'appareils par compte, comportement YouTube, vie privée. |
| **D3** | Stratégie Netflix / streaming | (a) **Mode A seul (comptes clients + nettoyage local)** ; (b) attendre les accords hospitality | **(a) + démarche partenaire en parallèle** | Le mode A est légal et faisable ; le mode B ne doit être activé qu'appli par appli avec accord écrit de l'éditeur. |
| **D4** | Hébergement / RGPD | (a) **Hébergeur UE (Scaleway/OVH) ou région UE d'AWS** ; (b) Supabase/Vercel comme vos autres projets | **(a) pour l'API, la BDD et le stockage** ; l'admin Next.js peut rester sur Vercel | Besoin d'un process WebSocket permanent et d'un argument « données en UE » pour les hôtels. |
| **D5** | Canal de vente | (a) direct uniquement ; (b) **direct + revendeurs/intégrateurs** | **(b) dans le modèle de données dès le MVP**, portail revendeur en V2 | Ajouter un niveau de hiérarchie plus tard est très coûteux ; il ne coûte presque rien maintenant. |
| **D6** | Dépôt | (a) réutiliser un dépôt existant ; (b) **nouveau monorepo `hotel-os`** | **(b)** | Aucun de vos dépôts actuels (glambook, jeuxtv, smalto…) ne contient de base exploitable pour ce projet ; jeuxtv est une appli web de jeux télévisés sans lien technique. |

Tout le reste (stack, protocole, modèle de données, priorités) est tranché dans ce dossier et dans le MASTER PROMPT.

---

## E. ROADMAP

Hypothèse : 1 développeur Android senior + 1 développeur full-stack, assistés par Claude Code. Durées indicatives.

```
Semaines      0    4    8    12   16   20   24   28   32   36
P1 Valid.     ████████                                         ← GO/NO-GO matériel
P2 Socle srv     ██████████                                    (démarre en parallèle de P1)
P3 Launcher           ████████
P4 App Mgmt                ██████████
P5 IPTV                         ███████                        (parallèle P4, équipe 2)
P6 Services                          ██████████
P7 Supervis.          ░░░░░░░░░░░░░░░░██████                   (fil continu, finalisation)
P8 Industr.                                 ██████████████
          MVP pilote (1 hôtel) ≈ S20 ─┘      V1 commerciale ≈ S32–36
```

| Phase | Contenu | Livrable de sortie (critère d'acceptation) | Dépend de | Parallélisable avec |
|---|---|---|---|---|
| **P1 Validation technologique** | Achat 3–5 boîtiers ; DPC « POC » ; DO par ADB ; HOME persistant ; suspension/masquage de Netflix/YouTube/Paramètres/Play Store ; installation silencieuse ; `clearApplicationUserData` sur Netflix/YouTube/Spotify ; test compte Google (D2) ; Widevine ; boutons télécommande ; reboot/coupure électrique | **Rapport de certification signé par modèle** + décision D1/D2 confirmée | — | P2 |
| **P2 Socle serveur** | Monorepo, NestJS, Postgres+RLS, tenants/partenaires/organisations/hôtels/groupes/chambres/boîtiers, utilisateurs/rôles/audit, enrôlement, protocole boîtier v1 (REST+WS), moteur de politiques + résolution, file de commandes | API documentée OpenAPI, tests d'isolation tenant, simulateur de 1 000 boîtiers | — | P1 |
| **P3 Launcher** | Compose for TV, templates, focus, i18n 7 langues + RTL, cache hors ligne, jetons délégués | Launcher sur boîtier réel, navigation 100 % télécommande, retour HOME fiable | P1 (kiosque), P2 (API config) | P4 serveur |
| **P4 Application Management** | Inventaire natif, catalogue APK privé, analyse serveur, déploiements ciblés, anneaux, maintenance, roll-forward, « DEPLOY TO ALL HOTELS » | Tableau désiré/réel exact sur boîtiers réels | P1, P2 | P5 |
| **P5 IPTV** | Ingestion serveur M3U/XMLTV, appli Media3, EPG, favoris, reprise erreur | Lecture HLS + UDP multicast stable 72 h | P2 | P4 |
| **P6 Services** | CMS, campagnes, Room Service, check-in/out manuel puis PMS (Mews/Apaleo), moteur de nettoyage | Cycle séjour complet de bout en bout avec rapport de nettoyage | P3, P4 | — |
| **P7 Supervision** | Télémétrie, alertes, fiche équipement, télécommande virtuelle complète, statistiques | Alertes < 2 min sur boîtier hors ligne | P2 (démarre tôt), P4 | P5, P6 |
| **P8 Industrialisation** | Certification de nouveaux modèles, tests de charge 10 k boîtiers, pentest, documentation, facturation/abonnements, portail client | Prêt commercial | Tout | — |

**MVP recommandé (pilote 1 hôtel, ~40–80 chambres)** : 1–2 modèles certifiés ; station de provisioning + PWA technicien ; DPC (kiosque Enforced Home, suspension/masquage, installation silencieuse, commandes de base, nettoyage) ; Launcher (1 template, 7 langues) ; inventaire des applis natives + catalogue APK + déploiement par anneaux ; HOTEL IPTV (M3U/HLS/UDP + XMLTV) ; CMS simple (accueil, infos pratiques, promotions planifiées) ; check-in/out **manuel** depuis l'admin + rapport de nettoyage ; supervision de base (en ligne/hors ligne, versions, alertes e-mail) ; multi-tenant complet (même avec un seul client). **Hors MVP** : PMS automatique, Room Service avec paiement, publicité monétisée, Tizen/webOS, casting, facturation automatique.

---

## Annexe 1 — Plan de certification matérielle (résumé)

1. **Auto-test embarqué** (mode « Certification » du DPC, lancé par le technicien) : ~60 vérifications automatiques → rapport JSON envoyé au module HARDWARE COMPATIBILITY. Exemples : version Android/API, ABI, RAM/stockage, `dpm` DO actif, chaque restriction appliquée et relue, HOME persistant effectif, suspension/masquage de chaque paquet cible (relecture), installation/désinstallation silencieuse d'une APK de test, `clearApplicationUserData`, `reboot`, `setTimeZone`, Widevine `securityLevel`, codecs (HEVC, AV1, Dolby), résolution/HDR, Ethernet/Wi-Fi, présence GMS/Play Store.
2. **Tests manuels guidés** (checklist dans la PWA) : chaque bouton de la télécommande (HOME, BACK, boutons Netflix/YouTube/Prime, micro, paramètres, input), panneau rapide, menus constructeur, comportement CEC (allumage TV, volume), lecture Netflix HD, reprise après coupure électrique, reset matériel (détection et ré-enrôlement).
3. **Endurance** : 72 h de lecture IPTV + 100 cycles check-in/out + 20 cycles de mise à jour.
4. **Statut** calculé : CERTIFIÉ (tous critères bloquants OK), PARTIELLEMENT COMPATIBLE (liste des fonctions indisponibles affichée), NON COMPATIBLE. Re-certification à chaque mise à jour firmware majeure détectée sur la flotte.
5. **Soumission** d'un nouveau modèle par un hôtel/revendeur : formulaire + envoi du rapport d'auto-test → revue humaine → statut publié.

## Annexe 2 — Risques principaux

| Risque | Prob. | Impact | Mitigation |
|---|---|---|---|
| Aucun boîtier grand public ne supporte un kiosque fiable | Moyenne | Bloquant | P1 avant tout investissement lourd ; piste OEM |
| Mise à jour firmware/Google TV qui casse le kiosque | Élevée | Élevé | Gel OTA si respecté, détection de version firmware, alerte flotte, recertification |
| Netflix/éditeurs refusent l'usage hôtelier | Moyenne | Élevé commercialement | Mode A + programme partenaire ; offre sans streaming |
| Mise à jour DPC défectueuse | Faible | Critique | Anneaux, DPC minimal, détection crash-loop |
| Réseau hôtelier inadapté | Élevée | Moyen | Prérequis réseau, diagnostic intégré au DPC |
| Fuite inter-tenant | Faible | Critique | RLS + tests automatisés + revue sécurité |
| Clé de signature APK compromise | Faible | Critique | KMS/HSM, accès restreint, rotation (APK Signature Scheme v3) |
| Dépendance Oracle (OPERA) | Moyenne | Moyen | Commencer par des PMS à API ouvertes |

## Annexe 3 — Dépendances externes

Fabricants de boîtiers (firmware, support DO) · Google (GMS, Play Store, Widevine, politiques Google TV) · Éditeurs de streaming (CGU, programmes hospitality) · Éditeurs PMS (Mews, Apaleo, Oracle OHIP/FIAS, Cloudbeds) · Fournisseurs IPTV des hôtels (flux, droits, DRM) · Sociétés de gestion de droits (responsabilité hôtel) · Hébergeur cloud UE, CDN, fournisseur e-mail/SMS · Stripe (facturation) · Samsung/LG (programmes hospitality, V3) · Fournisseur d'identité (OIDC).

## Annexe 4 — Modèle commercial recommandé

- **Prix par chambre et par mois** (standard du marché), avec minimum par hôtel.
- **Paliers** : *Essentials* (kiosque, gestion des applis, Launcher, supervision) · *Pro* (+ IPTV, CMS, promotions, room service, multilingue avancé) · *Enterprise* (+ PMS, multi-établissements, SSO, API, SLA, marque blanche).
- **Modules additionnels** activables : PMS, publicité monétisée, services hôteliers.
- **Essai** 30 jours / 5 chambres ; **démo** avec boîtier de démonstration.
- Techniquement : moteur d'**entitlements** (plan → modules → quotas d'appareils), vérifié côté serveur à chaque calcul de politique ; en cas d'impayé : dégradation progressive vers un accueil basique, jamais d'écran noir.
