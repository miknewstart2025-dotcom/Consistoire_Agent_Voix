# ADR 0002 — Kiosque à deux niveaux
ENFORCED_HOME (défaut) : HOME persistant + suspension/masquage + restrictions. STRICT_LOCK_TASK : en plus, lock task avec liste blanche.
Le launcher d'origine n'est masqué qu'**après** confirmation que notre HOME est effectif, pour ne jamais laisser une TV sans écran d'accueil.
Applis lançables non listées : suspendues par défaut (`unlistedLaunchableApps`).
