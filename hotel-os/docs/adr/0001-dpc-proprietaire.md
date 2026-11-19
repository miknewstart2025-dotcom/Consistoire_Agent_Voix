# ADR 0001 — DPC propriétaire plutôt qu'Android Management API
Contexte : AMAPI dépend de l'app Android Device Policy de Google, sans support Android TV documenté, avec quotas/approbation pour l'usage commercial.
Décision : DPC propriétaire (Device Owner, API publiques DevicePolicyManager). Logique isolée dans `dpc-core` (JVM, testée), adaptateur Android mince.
Conséquences : liberté totale, aucune licence ; la compatibilité dépend du firmware → certification par modèle.
