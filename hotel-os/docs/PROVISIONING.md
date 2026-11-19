# Provisioning d'un boîtier (technicien)

> Le QR code / NFC de l'assistant Android ne sont pas supposés disponibles sur Android TV. Méthode V1 : ADB.

1. **Réinitialisation d'usine** du boîtier.
2. Assistant de configuration : réseau (Ethernet recommandé), **ne pas se connecter à un compte Google** (choisir la configuration « basique » si proposée).
3. Paramètres → À propos → appuyer 7× sur « Build » → Options développeur → **Débogage USB** (ou réseau) activé.
4. HOTEL MANAGER → Hôtel → Enrôlement → générer un jeton (N boîtiers).
5. Station : `hotelos-provision --server https://api… --token <jeton> --dpc dpc.apk --launcher launcher.apk [--serial X]`
   (vérifie l'absence de comptes, installe, `dpm set-device-owner`, configure, vérifie).
6. Le contrôleur s'enrôle puis affiche un **code à 6 caractères**.
7. HOTEL MANAGER → Technicien : choisir la chambre, saisir le code. Si la chambre avait un boîtier, il est révoqué (remplacement).
8. Le contrôleur désactive ensuite le débogage (`no_debugging_features`), applique le kiosque et lance HOTEL LAUNCHER.

Échecs fréquents : comptes présents → reset ; « already provisioned » → reset ; refus persistant → modèle INCOMPATIBLE.
Récupération administrateur : mode maintenance (Phase 3+) ; sinon réinitialisation matérielle puis reprise à l'étape 1 (la chambre garde sa configuration).
