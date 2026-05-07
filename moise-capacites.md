---

<img src="assets/consistoire-logo.jpg" alt="Consistoire de Paris" style="width:220px;display:block;margin:0 0 24px 0;" />

# Moïse — Assistant vocal du Consistoire de Paris

## Dossier de fonctionalités produit

**Version :** 1.0 — 20 avril 2026
**Cas d'usage :** `consistoire-paris`
**Persona :** Moïse, assistant vocal officiel du Consistoire de Paris

---

## 1. Vue d'ensemble

Moïse est un assistant vocal conversationnel en français, destiné à
l'accueil téléphonique du Consistoire de Paris. Il représente
l'institution avec dignité et bienveillance, accueille les fidèles sur
les six grands domaines de service et route les demandes complexes vers
un opérateur humain lorsque nécessaire.

La plateforme repose sur :

- une **reconnaissance vocale** adaptée au français conversationnel
  (accents, termes hébreux courants) ;
- un **modèle de langage** instruit de la posture, du vocabulaire et des
  règles halakhiques de base ;
- une **synthèse vocale** masculine chaleureuse et posée ;
- une **base de connaissances** constituée de documents officiels du
  Consistoire (cacherout, mikvaot, mohalim, mariages, serrures cachères)
  et de l'annuaire des commerces agréés ;
- un **annuaire structuré des commerces** (type, arrondissement, code
  postal, ville, nom) interrogeable par filtres exacts.

---

## 2. Canaux supportés

| Canal | Statut | Usage |
|---|---|---|
| Appels entrants (PSTN) | Opérationnel | Fidèle appelant le standard du Consistoire |
| Appels sortants (PSTN) | Opérationnel | Rappel d'un fidèle, campagne d'information |
| WhatsApp / chat web | Non inclus dans cette version | Prévu pour une phase ultérieure |

Les appels sont gérés via un tronc SIP sortant agréé par l'opérateur
télécom, avec présentation d'un numéro d'appelant paramétrable par
campagne.

---

## 3. Périmètre fonctionnel — Les six services couverts

Moïse connaît les grandes étapes, les documents requis et les
interlocuteurs des six services suivants :

1. **Mariages** — dossier, ketouba, date, lieu, entretien préalable, dates interdites.
2. **Divorces (guet)** — procédure du beth din, délais, documents civils à fournir.
3. **Conversions (guiyour)** — parcours d'études, entretiens, beth din, tévila.
4. **Statut personnel** — certificats de judaïcité, attestations, régularisations.
5. **Hevra Kadicha** — accompagnement funéraire, taharah, inhumation, priorité absolue sur les autres demandes.
6. **Talmud Torah** — inscriptions, niveaux, calendrier scolaire.

Il est conscient des contraintes liées au **Shabbath** et aux **jours de fête**, et ne propose jamais de rendez-vous le samedi.

---

## 4. Base de connaissances

Moïse s'appuie sur **614 extraits indexés** issus de 6 sources :

| Source | Contenu | Usage typique |
|---|---|---|
| **Liste des produits 2025-2026** (38 pages) | Produits alimentaires cachers certifiés par le Beth Din | Vérification d'une marque, question sur Pessah, Kitniyot, additifs |
| **Liste des mohalim agréés** | Contacts des mohalim de l'association AFM | Recherche d'un mohel pour une brith milah |
| **Liste des mikvaot 5785** | Annuaire des mikvaot par département (Paris, 92, 93, 78, 94…) | Trouver un mikvé proche d'une adresse |
| **Mariages interdits 5786-5790** | Dates du calendrier juif où le mariage est proscrit | Vérifier qu'une date envisagée est permise |
| **Serrures cachères** (novembre 2024) | Serrures mécatroniques certifiées pour Shabbath | Orienter un fidèle en rénovation ou construction |
| **Annuaire des commerces** (497 entrées) | Restaurants, boucheries, traiteurs, pâtisseries… | Trouver un commerce par type, par arrondissement ou par nom |

Les documents sont interrogeables par **recherche sémantique** (le fidèle
pose sa question en langage naturel) ; l'annuaire des commerces est
également interrogeable par **filtres structurés** (type × arrondissement
× ville × nom).

Chaque réponse est sourcée : Moïse cite, lorsqu'il le faut, le document
d'origine (par exemple : *« d'après la liste des mikvaot 5785, page 2,
le mikvé de Neuilly se trouve au 16 avenue Maurice »*).

---

## 5. Types de questions auxquelles Moïse peut répondre

Cette section est le cœur opérationnel du produit. Les exemples sont
formulés tels qu'un fidèle les poserait naturellement au téléphone.

### 5.1 Cacherout

- *« Est-ce que le fromage Président est casher ? »*
- *« Quels vins sont autorisés pour Pessah cette année ? »*
- *« L'additif E 471 est-il casher ? »*
- *« Quels poissons sont autorisés ? »*
- *« J'ai acheté une marque qui ne figure pas sur la liste, que me conseillez-vous ? »*

### 5.2 Commerces — recherche par type et localisation

- *« Je cherche une boucherie cachère dans le 17ᵉ arrondissement. »*
- *« Où puis-je trouver un traiteur pour Shabbat près de Sarcelles ? »*
- *« Y a-t-il un restaurant cacher à Boulogne-Billancourt ? »*
- *« Quelle pâtisserie cachère à Neuilly avez-vous ? »*
- *« Avez-vous les coordonnées de la boucherie Berbèche ? »*

Réponse type : nom du commerce, adresse complète, numéro de téléphone,
et — si plusieurs résultats — les options classées par distance /
notoriété.

### 5.3 Mariages

- *« Peut-on se marier le 14 septembre 2026 ? »* (vérification d'une date dans la liste des mariages interdits)
- *« Quels sont les documents à préparer pour un mariage religieux ? »*
- *« Comment se déroule l'entretien préalable avec le rabbin ? »*
- *« À qui dois-je m'adresser pour commencer la procédure ? »*
- *« Le mariage est-il possible pendant la période de l'omer ? »*

### 5.4 Divorces (guet)

- *« Je souhaite entamer une procédure de guet, par où commencer ? »*
- *« Quels documents civils dois-je fournir au beth din ? »*
- *« Combien de temps dure la procédure en moyenne ? »*
- *« Mon ex-conjoint(e) vit à l'étranger — est-ce possible ? »*

### 5.5 Conversions (guiyour)

- *« Je souhaite me convertir au judaïsme, que dois-je faire ? »*
- *« Combien de temps dure le parcours ? »*
- *« À quels entretiens faut-il se préparer ? »*
- *« Où se déroule la tévila ? »*

### 5.6 Hevra Kadicha

*Cas prioritaire — traité en premier quel que soit le motif initial de l'appel.*

- *« Un proche vient de décéder, que faut-il faire maintenant ? »*
- *« Comment organiser la taharah ? »*
- *« Quelles sont les démarches pour l'inhumation ? »*
- *« Je cherche un mohel / rabbin disponible rapidement. »*

### 5.7 Talmud Torah

- *« Comment inscrire mon enfant au Talmud Torah ? »*
- *« Quels sont les niveaux proposés ? »*
- *« Quel est le calendrier scolaire ? »*
- *« À quel centre dois-je me présenter selon mon arrondissement ? »*

### 5.8 Mikvaot

- *« Où se trouve le mikvé le plus proche du 92 ? »*
- *« Quel est le téléphone du mikvé des Eaux d'Eden à Villemomble ? »*
- *« Y a-t-il un mikvé ouvert pour les hommes le matin ? »*

### 5.9 Mohalim

- *« Je cherche un mohel agréé par l'association AFM. »*
- *« Pouvez-vous me donner les coordonnées de Monsieur Yoël Arbib ? »*
- *« Y a-t-il un mohel qui se déplace en région PACA ? »*

### 5.10 Serrures cachères pour Shabbath

- *« Quelle serrure certifiée par le Beth Din pour utilisation le samedi ? »*
- *« Je fais des travaux, que recommandez-vous pour ma porte d'entrée ? »*

### 5.11 Informations pratiques

- *« Quelles sont les horaires d'accueil du Consistoire ? »*
- *« À quelle adresse dois-je envoyer mon dossier ? »*
- *« Quelle est la date de Pessah cette année ? »*

---

## 6. Garde-fous et limites

Moïse est conçu pour **ne jamais sortir de son rôle**. Il refuse
poliment, et renvoie vers l'humain compétent, dans les cas suivants :

- **Décisions halakhiques** — toute question de fond est renvoyée au
  rabbinat ou au beth din. Moïse ne tranche jamais.
- **Engagement institutionnel** — il n'engage jamais le Consistoire sur
  un délai, un coût, une date définitive, ni une disponibilité d'un
  rabbin en particulier.
- **Shabbath et jours de fête** — aucune proposition de rendez-vous ni
  d'activité le samedi ou pendant une fête.
- **Deuil** — si l'appelant le souhaite, la prise en charge est
  immédiatement transférée à la Hevra Kadicha.
- **Incertitude** — lorsqu'une information manque, Moïse le dit
  explicitement plutôt que d'improviser.

Une **escalade vers un opérateur humain** est possible via un outil
dédié ; les cibles d'escalade (accueil général, mariages, Hevra Kadicha,
etc.) sont configurables par le Consistoire dans un fichier paramétré.

---

## 7. Multilinguisme

- **Français** — langue principale, par défaut sur tous les appels.
- **Anglais et hébreu** — Moïse suit si l'appelant bascule, dans la
  limite des capacités du modèle. En cas de demande complexe dans une
  langue autre que le français, une mise en relation humaine est
  proposée.

---

## 8. Architecture technique (synthèse)

| Composant | Technologie |
|---|---|
| Plateforme voix temps réel | Livekit Cloud|
| Reconnaissance vocale | Deepgram - futur à définir|
| Modèle conversationnel | Claude Sonnet 4.6 - futur à définir |
| Synthèse vocale | ElevenLabs - futur à définir   |
| Téléphonie | Twilio |
| Indexation sémantique | Voyage - futur: à définir |
| Annuaire structuré | Index et graphe|
| Configuration | YAML + briefing Markdown + mémoire cumulative |
| Résumé post-appel | Écrit automatiquement dans la mémoire de l'assistant |

Chaque appel produit :

- une **transcription** horodatée,
- un **résumé Markdown** du dialogue,
- la liste des **outils utilisés** (recherche documentaire, annuaire,
  escalade…).

---

## 9. Extensibilité

Le cas d'usage Moïse est conçu comme un **modèle réplicable**. Pour
étendre le périmètre :

- **Ajouter un document** (ex. : nouvelle liste Pessah, FAQ actualisée)
  → déposer le fichier dans le dossier documents du cas et
  réindexer (`kb_build.py`).
- **Rafraîchir l'annuaire des commerces** → un script de crawl récupère
  la dernière version du site du Consistoire et régénère le CSV.
- **Ajouter un service** (ex. : jeunesse, aumônerie) → enrichir le
  système prompt + ajouter les documents de référence.
- **Configurer les escalades** → remplir la table `escalation_targets`
  avec les numéros des interlocuteurs humains de garde.

---

## 10. Indicateurs de pilotage suggérés

- Nombre d'appels pris en charge par Moïse / transférés à l'humain.
- Taux de résolution au premier appel.
- Répartition par service (mariages, cacherout, Hevra Kadicha…).
- Temps moyen de conversation.
- Satisfaction post-appel (enquête SMS/WhatsApp à implémenter dans une
  phase ultérieure).

---
