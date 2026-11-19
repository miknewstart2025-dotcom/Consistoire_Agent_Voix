# Prérequis réseau hôtel
- SSID ou VLAN dédié aux TV, **sans portail captif**, isolation client autorisée. Ethernet recommandé.
- Sortie HTTPS (443) vers l'API HOTEL OS, le CDN, et — si streaming — Google Play / services des éditeurs.
- NTP accessible (sans heure correcte, TLS échoue).
- IPTV multicast : IGMP snooping/querier configurés sur le VLAN TV.
- Bande passante : les mises à jour d'APK sont étalées (jitter) ; prévoir ~50 Mo × nombre de chambres par déploiement.
