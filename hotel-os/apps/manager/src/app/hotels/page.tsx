"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ErrorBox, Shell } from "@/components/Shell";
import { api, errorText } from "@/lib/api";

interface Hotel { id: string; name: string; organizationId: string; timezone: string; languages: string[] }
interface Org { id: string; name: string }

export default function Hotels() {
  return <Shell>{(me) => <HotelsInner canCreate={me.isPlatformAdmin || me.memberships.some((m) => m.role === "ORG_ADMIN" && m.hotelId === null)} />}</Shell>;
}

function HotelsInner({ canCreate }: { canCreate: boolean }) {
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [form, setForm] = useState({ orgId: "", name: "", timezone: "Europe/Paris" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Hotel[]>("/v1/hotels").then(setHotels).catch((e) => setError(errorText(e)));
    api<Org[]>("/v1/organizations").then((o) => { setOrgs(o); setForm((f) => ({ ...f, orgId: f.orgId || o[0]?.id || "" })); }).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/v1/organizations/${form.orgId}/hotels`, { body: { name: form.name, timezone: form.timezone } });
      setForm((f) => ({ ...f, name: "" }));
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <>
      <h1>Hôtels</h1>
      <ErrorBox error={error} />
      <div className="grid">
        {hotels.map((h) => (
          <Link key={h.id} href={`/hotels/${h.id}`} className="panel card">
            <strong>{h.name}</strong>
            <div className="muted">{h.timezone} · {h.languages.join(", ")}</div>
          </Link>
        ))}
        {!hotels.length && <p className="muted">Aucun hôtel.</p>}
      </div>
      {canCreate && orgs.length > 0 && (
        <form className="panel" onSubmit={create}>
          <h2>Nouvel hôtel</h2>
          <div className="row">
            <select aria-label="Organisation" value={form.orgId} onChange={(e) => setForm({ ...form, orgId: e.target.value })}>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <input aria-label="Nom de l'hôtel" placeholder="Nom de l'hôtel" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <input aria-label="Fuseau horaire" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            <button type="submit">Créer</button>
          </div>
        </form>
      )}
    </>
  );
}
