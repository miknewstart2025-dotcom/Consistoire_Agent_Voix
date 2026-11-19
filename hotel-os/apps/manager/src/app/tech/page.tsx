"use client";
import { useEffect, useState } from "react";
import { ErrorBox, Shell } from "@/components/Shell";
import { api, errorText } from "@/lib/api";

/** Technician view (mobile-first): assign a freshly enrolled box to a room using the code shown on the TV. */
export default function Tech() {
  return <Shell>{() => <Inner />}</Shell>;
}

function Inner() {
  const [hotels, setHotels] = useState<{ id: string; name: string }[]>([]);
  const [hotelId, setHotelId] = useState("");
  const [rooms, setRooms] = useState<{ id: string; number: string; device: unknown }[]>([]);
  const [roomId, setRoomId] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { api<{ id: string; name: string }[]>("/v1/hotels").then((h) => { setHotels(h); setHotelId(h[0]?.id ?? ""); }).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => { if (hotelId) api<typeof rooms>(`/v1/hotels/${hotelId}/rooms`).then(setRooms).catch((e) => setError(errorText(e))); }, [hotelId]);
  const room = rooms.find((r) => r.id === roomId);
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>Appairer un boîtier</h1>
      <form className="panel" onSubmit={async (e) => {
        e.preventDefault(); setError(null); setMsg(null);
        try {
          const r = await api<{ roomNumber: string; replacedDeviceIds: string[] }>("/v1/devices/pair", { body: { pairingCode: code.trim().toUpperCase(), roomId } });
          setMsg(`Boîtier affecté à la chambre ${r.roomNumber}${r.replacedDeviceIds.length ? " (ancien boîtier révoqué)" : ""}`);
          setCode("");
        } catch (err) { setError(errorText(err)); }
      }}>
        <label htmlFor="hotel">Hôtel</label>
        <select id="hotel" value={hotelId} onChange={(e) => setHotelId(e.target.value)} style={{ width: "100%" }}>{hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
        <label htmlFor="room">Chambre</label>
        <select id="room" value={roomId} onChange={(e) => setRoomId(e.target.value)} required style={{ width: "100%" }}>
          <option value="">—</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.number}{r.device ? " (équipée)" : ""}</option>)}
        </select>
        {room?.device ? <p className="warn">Cette chambre a déjà un boîtier : il sera remplacé et révoqué.</p> : null}
        <label htmlFor="code">Code affiché sur la TV</label>
        <input id="code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} required autoCapitalize="characters" style={{ width: "100%", fontSize: 28, letterSpacing: 6, textAlign: "center" }} />
        <ErrorBox error={error} />
        {msg && <p className="ok">{msg}</p>}
        <button type="submit" style={{ marginTop: 12, width: "100%" }}>Appairer</button>
      </form>
    </div>
  );
}
