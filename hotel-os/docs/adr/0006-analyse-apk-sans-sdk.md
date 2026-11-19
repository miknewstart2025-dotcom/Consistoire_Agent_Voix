# ADR 0006 — Analyse des APK côté serveur sans SDK Android
Les outils officiels (`apksigner`, `aapt2`) exigent le SDK Android sur le serveur. L'analyse est donc implémentée en TypeScript : lecture ZIP, manifeste binaire (AXML) et vérification complète des schémas de signature v2/v3 (signature des données signées + condensat CHUNKED_SHA256/512 de tout le fichier). Les APK signées uniquement en v1 sont refusées (minSdk 28).
Garantie : résultats comparés à apksig (bibliothèque Java de Google) sur une APK réelle ; fixtures régénérables via `scripts/fixtures/build.sh`.
