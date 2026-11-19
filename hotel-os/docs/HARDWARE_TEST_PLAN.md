# Plan de tests matériel (Phase 1)
Pour chaque modèle candidat, consigner résultat + version firmware (`Build.FINGERPRINT`) pour chacun des 11 points `[HW-REQUIRED]` de PROGRESS.md.
Procédure de base : provisioning (PROVISIONING.md) → config hôtel autorisant Netflix, suspendant YouTube → vérifier dans HOTEL MANAGER (onglet Applications, fiche boîtier) que l'état **réel** correspond ; essayer chaque bouton de la télécommande et la voix ; check-out → rapport de nettoyage → relancer Netflix (déconnecté ?) ; 20 coupures secteur ; reset matériel.
Verdict : CERTIFIÉ / PARTIEL (fonctions indisponibles listées) / NON COMPATIBLE, saisi dans `device_models` (statut + capacités).
