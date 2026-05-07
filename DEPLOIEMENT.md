# Note de reprise — déploiement de l'agent vocal

À lire après avoir cloné le repo. Objectif : passer d'un repo froid à un
agent qui prend des appels en production sur OVH.

---

## 1. Comptes externes à créer

L'agent ne fait quasiment aucun calcul lourd lui-même : tout passe par
des APIs tierces. Il faut des clés pour chacun.

| Service | Rôle | Variable(s) | Coût d'ordre |
|---------|------|-------------|--------------|
| **LiveKit Cloud** | Transport temps réel + dispatch SIP + workers | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Gratuit à démarrer ; ~$50–150/mois en prod légère |
| **Twilio** (ou autre opérateur SIP) | Numéro PSTN entrant + sortant pour les escalades | configuré côté LiveKit (trunk SIP) | ~$1/mois par numéro + minutes |
| **Deepgram** | STT (modèle `nova-3` côté FR) | `DEEPGRAM_API_KEY` | $0.0043/min en streaming |
| **ElevenLabs** | TTS (voix Augustin pour Moïse) | `ELEVENLABS_API_KEY` | Plan Creator $22/mois minimum |
| **Anthropic** | LLM (Claude Sonnet 4.6 par défaut) | `ANTHROPIC_API_KEY` | Pay-per-token, ~$0.02–0.05/appel |
| **OpenAI** *(optionnel)* | LLM alternatif si on bascule un use case sur GPT | `OPENAI_API_KEY` | — |
| **Voyage AI** | Embeddings pour la KB vectorielle | `VOYAGE_API_KEY` | Gratuit jusqu'à 50M tokens, sinon $0.05/1M |
| **GitHub** | Repo (déjà fait) | clé SSH déploiement | — |

> **Twilio vs LiveKit SIP natif** : voir `Twilio vs Livekit.md`. Pour
> l'instant, on utilise LiveKit comme proxy SIP au-dessus d'un trunk
> Twilio (numéros gérés chez Twilio, dispatch chez LiveKit).

### Côté LiveKit, à configurer dans la console

1. Un **inbound trunk** SIP qui pointe vers Twilio (ou l'opérateur).
2. Une **dispatch rule** par use case — voir
   `use_cases/<slug>.dispatch.json` pour le format. La règle route un
   numéro entrant vers le bon `agent_name`.
3. Un **outbound trunk** pour les escalades (`ESCALATION_OUTBOUND_TRUNK_ID`)
   et un autre pour Zoom si pertinent (`ZOOM_OUTBOUND_TRUNK_ID`).

---

## 2. Lancement local (smoke test avant tout déploiement)

```bash
git clone <repo>
cd voiceagent
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env.local   # à créer si absent — voir tableau ci-dessus
.venv/bin/python test_use_cases.py        # charge tous les use cases, vérifie les outils
.venv/bin/streamlit run admin.py          # UI sur :8502
.venv/bin/python kb_build.py consistoire-paris    # construit la KB vectorielle
.venv/bin/python graph_build.py consistoire-paris # construit le graphe SQLite
.venv/bin/python agent.py dev             # worker en mode dev, écoute LiveKit
```

Si `agent.py dev` se connecte à LiveKit sans erreur et que `test_use_cases.py`
passe, le repo est sain.

---

## 3. Déploiement sur OVH

### Choix de l'instance

OVH Public Cloud, région **Gravelines (GRA11)** ou **Roubaix (RBX)** —
proche de l'Europe, faible latence vers LiveKit Cloud EU. L'agent est
léger : ~200 MB RAM par worker, négligeable en CPU. Une seule instance
suffit techniquement, **mais c'est un SPOF**.

| Profil | vCPU | RAM | ~Prix/mois | Pour |
|--------|------|-----|------------|------|
| `b3-8` | 2 | 8 GB | ~25 € | démarrage 1 worker + admin Streamlit |
| `b3-16` | 4 | 16 GB | ~50 € | 2-3 workers en parallèle |

OS recommandé : **Ubuntu 24.04 LTS**.

### Procédure de mise en route (instance unique)

```bash
# Sur l'instance fraîche, en root puis user 'voice'
adduser --disabled-password --gecos "" voice
apt update && apt install -y python3.13 python3.13-venv git nginx
sudo -u voice -i

# En tant que voice
git clone git@github.com:laurentfp/Voice-agent.git
cd Voice-agent
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Déposer .env.local manuellement (scp depuis le poste, NE PAS commit)
chmod 600 .env.local

# Construire les artefacts KB/graph (ou les rsync depuis le poste)
.venv/bin/python kb_build.py consistoire-paris
.venv/bin/python graph_build.py consistoire-paris
```

### Service systemd

`/etc/systemd/system/voiceagent@.service` :

```ini
[Unit]
Description=Voice agent worker (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=voice
WorkingDirectory=/home/voice/Voice-agent
EnvironmentFile=/home/voice/Voice-agent/.env.local
ExecStart=/home/voice/Voice-agent/.venv/bin/python agent.py start
Restart=always
RestartSec=5
StandardOutput=append:/var/log/voiceagent-%i.log
StandardError=append:/var/log/voiceagent-%i.log

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now voiceagent@consistoire
journalctl -fu voiceagent@consistoire   # suivi en direct
```

### Admin Streamlit (interne uniquement)

L'UI sur `:8502` ne doit **jamais** être exposée publiquement (elle
permet d'éditer les use cases, donc le system prompt). Trois options :

1. **Tailscale / VPN** (recommandé, 5 min) — l'UI n'écoute que sur
   l'IP Tailscale, jamais sur l'IP publique.
2. **nginx + basic auth + IP allow-list** — plus lourd, pas de SSO.
3. Pas d'admin sur la prod : on édite les YAML en local, on commit,
   on `git pull` sur l'instance, on relance le service.

### Haute dispo (étape 2)

Une fois la première instance stable, passer à 2 instances avec le
même `agent_name` : LiveKit dispatche automatiquement sur le worker
disponible. Aucune configuration de load-balancer côté OVH n'est
nécessaire — c'est LiveKit qui orchestre. Les deux instances
partagent le même `.env.local` ; les artefacts KB/graph doivent être
construits sur chacune (ou rsynchronisés depuis un master).

---

## 4. Réglages les plus probables après déploiement

Ce qui se règle presque toujours après les premiers vrais appels :

- **Latence TTS first-chunk** — si la voix met >1 s à démarrer, ajuster
  `_TURN_FILLER_DELAY_S` dans `agent.py` (actuellement 0.7 s).
- **Voix ElevenLabs** — `voice_id` dans le YAML. Tester plusieurs voix
  natives FR sur un script type avant de figer.
- **Modèle Claude** — Sonnet 4.6 par défaut ; basculer sur Opus 4.7 si
  les réponses sont trop courtes/imprécises, ou Haiku 4.5 pour réduire
  la latence et le coût (au prix de qualité halakhique).
- **Wake word Zoom** — la regex est dans `use_case.py`. Ajuster les
  variantes phonétiques ("Dis Moïse" / "Dis Moshe" / "Moshé") en
  fonction des transcriptions Deepgram observées dans les logs.
- **Numéros autorisés (`access: restricted`)** — actuellement seul
  `+14156021250` est admis. Élargir prudemment, idéalement après avoir
  ajouté un mécanisme de liste dynamique côté admin.
- **`turn_fillers`** — vide pour Consistoire ; ajouter 4-5 variantes
  ("Hmm.", "Voyons.", "Un instant.") si l'on observe des silences >1 s
  sur les tours lents (lookups KB).
- **System prompt** — c'est là que se joue 80 % de la qualité
  perçue. Itérer après chaque session de tests utilisateur, pas avant.
- **Escalation targets** — pour l'instant un seul (`accueil`). Ajouter
  `mariages`, `hevra_kadicha`, etc. dans le YAML une fois que les
  numéros internes du Consistoire sont confirmés.
- **Cacherout / produits** — la base graph est construite à partir de
  PDFs ; à reconstruire chaque saison (`graph_build.py`).

---

## 5. Étapes vers la production — ordre de priorité

1. **Triage des appels existants** — lire les 13 résumés dans
   `summaries/` + `consistoire-paris.memory.md` pour bâtir la liste
   des défauts réels avant d'investir.
2. **Secrets** — sortir les clés du `.env.local` manuel ; soit OVH
   Secret Manager, soit `sops` + clé age, soit Vault. Le manuel passe
   pour démarrer mais ne tient pas à 2+ instances.
3. **Numéros autorisés en prod** — décider du périmètre : public ouvert
   au standard du Consistoire, ou liste blanche provisoire. Aujourd'hui
   c'est restreint à 1 numéro de test.
4. **Cibles d'escalade complètes** — récupérer auprès du Consistoire
   les numéros directs (mariages, Hevra Kadicha, accueil) et les coller
   dans `escalation_targets`.
5. **Persistance des résumés** — actuellement écrits dans
   `summaries/*.md`, locaux à l'instance. À envoyer dans un stockage
   partagé (OVH Object Storage S3-compatible) ou dans le futur CRM.
6. **Observabilité** — au minimum : journal structuré (déjà en place
   via `logger`), shipping des logs vers Loki/Grafana Cloud ou
   `journalctl` exporté ; alerte si le worker ne reçoit aucun appel
   pendant N heures.
7. **HA** — passer à 2 instances avec le même `agent_name` une fois
   les artefacts (KB, graph) reproductibles via un script.
8. **Tests d'appel automatisés** — appeler le numéro entrant depuis un
   script Twilio chaque matin, vérifier qu'on entend la salutation.
   Coût négligeable, rattrape 90 % des incidents silencieux.
9. **CRM** — voir la discussion séparée. Postgres + Streamlit "CRM-lite"
   plutôt qu'un HubSpot mid-call.
10. **RGPD** — résumés d'appels = données personnelles (parfois
    sensibles : deuil, conversion). Définir une rétention, un droit à
    l'effacement, et une mention vocale de consentement enregistrement
    si l'on stocke l'audio (actuellement on ne stocke que le résumé
    texte).

---

## Liens utiles dans le repo

- `LP voice agent README.md` — architecture générale
- `Twilio vs Livekit.md` — choix de l'opérateur SIP
- `zoom-teams-bots.md` — intégration meetings (Zoom/Teams)
- `use_cases/consistoire-paris.briefing.md` — périmètre fonctionnel
- `use_cases/consistoire-paris.memory.md` — apprentissages des appels passés
