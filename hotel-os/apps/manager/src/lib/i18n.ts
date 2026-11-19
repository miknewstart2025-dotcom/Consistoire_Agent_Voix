// Admin UI strings (FR first; EN fallback). Extend to the 7 languages in Phase 8.
const fr = {
  hotels: "Hôtels", rooms: "Chambres", devices: "Boîtiers", apps: "Applications", config: "Configuration", iptv: "IPTV",
  enrollment: "Enrôlement", logout: "Déconnexion", online: "En ligne", offline: "Hors ligne", inSync: "Synchronisé",
  outOfSync: "Écart", checkIn: "Check-in", checkOut: "Check-out", save: "Enregistrer", create: "Créer",
};
export type Key = keyof typeof fr;
export const t = (k: Key) => fr[k];
