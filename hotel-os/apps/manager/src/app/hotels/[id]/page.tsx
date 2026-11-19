"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ago, ErrorBox, Shell } from "@/components/Shell";
import { ConfigEditor } from "@/components/ConfigEditor";
import { api, errorText } from "@/lib/api";

interface Room { id: string; number: string; floor: string | null; roomType: string | null; groupIds: string[]; device: { id: string; lastSeenAt: string | null } | null }
interface Group { id: string; name: string; priority: number }
interface Device { id: string; roomNumber: string | null; online: boolean; lastSeenAt: string | null; model: { manufacturer: string; model: string; certification: string } | null; isDeviceOwner: boolean; kioskActive: boolean; launcherHealthy: boolean; policyVersionApplied: number; reconcileErrors: { key: string; message: string }[] }
interface AppRow { packageName: string; label: string | null; installed: number; allowed: number; visible: number; suspended: number; hidden: number; mismatched: number; notEnforceable: number; system: boolean }

const TABS = ["Chambres", "Boîtiers", "Applications", "Configuration", "IPTV", "Enrôlement"] as const;

export default function HotelPage() {
  return <Shell>{() => <Inner />}</Shell>;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const [hotel, setHotel] = useState<{ name: string; timezone: string } | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Chambres");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<{ name: string; timezone: string }>(`/v1/hotels/${id}`).then(setHotel).catch((e) => setError(errorText(e))); }, [id]);
  return (
    <>
      <h1>{hotel?.name ?? "…"}</h1>
      <ErrorBox error={error} />
      <div className="tabs" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      {tab === "Chambres" && <Rooms hotelId={id} />}
      {tab === "Boîtiers" && <Devices hotelId={id} />}
      {tab === "Applications" && <Apps hotelId={id} />}
      {tab === "Configuration" && <ConfigEditor scopeType="HOTEL" scopeId={id} hotelId={id} />}
      {tab === "IPTV" && <Iptv hotelId={id} />}
      {tab === "Enrôlement" && <Enrollment hotelId={id} />}
    </>
  );
}

function Rooms({ hotelId }: { hotelId: string }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [csv, setCsv] = useState("number,floor,type,groups\n");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Room[]>(`/v1/hotels/${hotelId}/rooms`).then(setRooms).catch((e) => setError(errorText(e)));
    api<Group[]>(`/v1/hotels/${hotelId}/groups`).then(setGroups).catch(() => {});
  }, [hotelId]);
  useEffect(load, [load]);
  const gname = (gid: string) => groups.find((g) => g.id === gid)?.name ?? "?";
  async function act(fn: () => Promise<unknown>, ok: string) {
    setError(null); setMsg(null);
    try { await fn(); setMsg(ok); load(); } catch (e) { setError(errorText(e)); }
  }
  return (
    <>
      <ErrorBox error={error} />
      {msg && <p className="ok">{msg}</p>}
      <div className="panel table-wrap">
        <table>
          <thead><tr><th>Chambre</th><th>Étage</th><th>Type</th><th>Groupes</th><th>Boîtier</th><th>Séjour</th></tr></thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.number}</strong></td><td>{r.floor}</td><td>{r.roomType}</td>
                <td>{r.groupIds.map((g) => <span key={g} className="chip">{gname(g)}</span>)}</td>
                <td>{r.device ? <Link href={`/devices/${r.device.id}`}>{ago(r.device.lastSeenAt)}</Link> : <span className="muted">—</span>}</td>
                <td className="row">
                  <button className="secondary" onClick={() => act(() => api(`/v1/rooms/${r.id}/check-in`, { body: { displayNameConsent: false } }), `Check-in chambre ${r.number}`)}>Check-in</button>
                  <button className="secondary" onClick={() => act(() => api(`/v1/rooms/${r.id}/check-out`, { body: {} }), `Check-out chambre ${r.number} : nettoyage envoyé`)}>Check-out</button>
                </td>
              </tr>
            ))}
            {!rooms.length && <tr><td colSpan={6} className="muted">Aucune chambre. Importez un CSV ci-dessous.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>Import CSV des chambres</h2>
        <p className="muted">Colonnes : number,floor,type,groups (groupes séparés par « | », créés si absents). Une chambre existante est mise à jour.</p>
        <textarea aria-label="CSV" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} />
        <button onClick={() => act(async () => {
          const r = await api<{ created: number; updated: number; errors: { line: number; message: string }[] }>(`/v1/hotels/${hotelId}/rooms/import`, { body: { csv } });
          if (r.errors.length) throw new Error(`${r.created} créées, ${r.updated} mises à jour, erreurs : ${r.errors.map((e) => `ligne ${e.line} ${e.message}`).join(", ")}`);
        }, "Import terminé")}>Importer</button>
      </div>
      <div className="panel">
        <h2>Groupes</h2>
        {groups.map((g) => <div key={g.id} className="row"><span className="chip">{g.name}</span><span className="muted">priorité {g.priority}</span><Link href={`/config/GROUP/${g.id}?hotel=${hotelId}`}>configurer</Link></div>)}
      </div>
    </>
  );
}

function Devices({ hotelId }: { hotelId: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api<Device[]>(`/v1/hotels/${hotelId}/devices`).then(setDevices).catch((e) => setError(errorText(e)));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [hotelId]);
  return (
    <div className="panel table-wrap">
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>Chambre</th><th>État</th><th>Modèle</th><th>Device Owner</th><th>Kiosque</th><th>Launcher</th><th>Politique</th><th>Vu</th></tr></thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td><Link href={`/devices/${d.id}`}>{d.roomNumber ?? "non appairé"}</Link></td>
              <td className={d.online ? "ok" : "bad"}>{d.online ? "En ligne" : "Hors ligne"}</td>
              <td>{d.model ? `${d.model.manufacturer} ${d.model.model}` : "?"} {d.model && <span className="chip">{d.model.certification}</span>}</td>
              <td className={d.isDeviceOwner ? "ok" : "bad"}>{d.isDeviceOwner ? "oui" : "NON"}</td>
              <td className={d.kioskActive ? "ok" : "warn"}>{d.kioskActive ? "actif" : "inactif"}</td>
              <td className={d.launcherHealthy ? "ok" : "warn"}>{d.launcherHealthy ? "OK" : "?"}</td>
              <td>v{d.policyVersionApplied} {d.reconcileErrors.length > 0 && <span className="warn">· {d.reconcileErrors.length} erreur(s)</span>}</td>
              <td className="muted">{ago(d.lastSeenAt)}</td>
            </tr>
          ))}
          {!devices.length && <tr><td colSpan={8} className="muted">Aucun boîtier enrôlé.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Apps({ hotelId }: { hotelId: string }) {
  const [data, setData] = useState<{ devices: number; apps: AppRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<{ devices: number; apps: AppRow[] }>(`/v1/hotels/${hotelId}/apps`).then(setData).catch((e) => setError(errorText(e))); }, [hotelId]);
  if (!data) return <ErrorBox error={error} />;
  const n = data.devices;
  const frac = (x: number) => (n ? `${x}/${n}` : "—");
  return (
    <div className="panel table-wrap">
      <p className="muted">État <strong>réel</strong> remonté par les boîtiers ({n}). « Écart » = l’état réel ne correspond pas encore à la configuration.</p>
      <table>
        <thead><tr><th>Application</th><th>Installée</th><th>Autorisée</th><th>Visible</th><th>Suspendue</th><th>Masquée</th><th>Écart</th></tr></thead>
        <tbody>
          {data.apps.map((a) => (
            <tr key={a.packageName}>
              <td><strong>{a.label ?? a.packageName}</strong><div className="mono muted">{a.packageName}{a.system ? " · système" : ""}</div></td>
              <td>{frac(a.installed)}</td><td>{frac(a.allowed)}</td><td>{frac(a.visible)}</td><td>{frac(a.suspended)}</td><td>{frac(a.hidden)}</td>
              <td>{a.mismatched ? <span className="warn">{a.mismatched}</span> : <span className="ok">0</span>}{a.notEnforceable > 0 && <div className="bad">non bloquable sur {a.notEnforceable} boîtier(s)</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Pour autoriser ou bloquer une application, modifiez la section <code>apps</code> de la configuration (hôtel, groupe ou chambre).</p>
    </div>
  );
}

function Iptv({ hotelId }: { hotelId: string }) {
  const [sources, setSources] = useState<{ id: string; name: string; playlistUrl: string; lastSyncStatus: string | null; lastSyncAt: string | null; lastSyncMessage: string | null }[]>([]);
  const [channels, setChannels] = useState<{ id: string; number: number; name: string; category: string | null; enabled: boolean }[]>([]);
  const [form, setForm] = useState({ name: "", playlistUrl: "", epgUrl: "", attest: false });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<typeof sources>(`/v1/hotels/${hotelId}/iptv/sources`).then(setSources).catch((e) => setError(errorText(e)));
    api<typeof channels>(`/v1/hotels/${hotelId}/iptv/channels`).then(setChannels).catch(() => {});
  }, [hotelId]);
  useEffect(load, [load]);
  return (
    <>
      <ErrorBox error={error} />
      <div className="panel">
        <h2>Sources</h2>
        {sources.map((s) => (
          <div key={s.id} className="row">
            <strong>{s.name}</strong><span className="mono muted">{s.playlistUrl}</span>
            <span className={s.lastSyncStatus === "OK" ? "ok" : "warn"}>{s.lastSyncStatus ?? "—"}</span><span className="muted">{ago(s.lastSyncAt)}</span>
            {s.lastSyncMessage && <span className="warn">{s.lastSyncMessage}</span>}
            <button className="secondary" onClick={async () => { try { await api(`/v1/iptv/sources/${s.id}/sync`, { body: {} }); load(); } catch (e) { setError(errorText(e)); } }}>Synchroniser</button>
          </div>
        ))}
        <form className="row" style={{ marginTop: 12 }} onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try { await api(`/v1/hotels/${hotelId}/iptv/sources`, { body: { name: form.name, playlistUrl: form.playlistUrl, epgUrl: form.epgUrl || undefined, rightsAttestation: form.attest } }); setForm({ name: "", playlistUrl: "", epgUrl: "", attest: false }); load(); } catch (err) { setError(errorText(err)); }
        }}>
          <input aria-label="Nom" placeholder="Nom" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input aria-label="URL M3U" placeholder="URL M3U" value={form.playlistUrl} onChange={(e) => setForm({ ...form, playlistUrl: e.target.value })} required />
          <input aria-label="URL XMLTV" placeholder="URL XMLTV (optionnel)" value={form.epgUrl} onChange={(e) => setForm({ ...form, epgUrl: e.target.value })} />
          <label className="row" style={{ margin: 0 }}><input type="checkbox" checked={form.attest} onChange={(e) => setForm({ ...form, attest: e.target.checked })} /> L’hôtel détient les droits de diffusion de ces flux</label>
          <button type="submit">Ajouter</button>
        </form>
      </div>
      <div className="panel table-wrap">
        <h2>Chaînes ({channels.length})</h2>
        <table><tbody>{channels.map((c) => (
          <tr key={c.id}><td>{c.number}</td><td>{c.name}</td><td>{c.category}</td>
            <td><button className="secondary" onClick={async () => { await api(`/v1/iptv/channels/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } }); load(); }}>{c.enabled ? "Désactiver" : "Activer"}</button></td></tr>
        ))}</tbody></table>
      </div>
    </>
  );
}

function Enrollment({ hotelId }: { hotelId: string }) {
  const [token, setToken] = useState<{ token: string; expiresAt: string; maxUses: number } | null>(null);
  const [maxUses, setMaxUses] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  return (
    <div className="panel">
      <h2>Jeton d’enrôlement</h2>
      <p className="muted">À utiliser avec la station de provisioning. Le jeton n’est affiché qu’une seule fois.</p>
      <div className="row">
        <label htmlFor="uses" style={{ margin: 0 }}>Nombre de boîtiers</label>
        <input id="uses" type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} />
        <button onClick={async () => { setError(null); try { setToken(await api(`/v1/hotels/${hotelId}/enrollment-tokens`, { body: { maxUses, ttlHours: 24 } })); } catch (e) { setError(errorText(e)); } }}>Générer</button>
      </div>
      <ErrorBox error={error} />
      {token && (
        <pre className="mono panel" style={{ whiteSpace: "pre-wrap" }}>
{`Jeton : ${token.token}
Expire : ${new Date(token.expiresAt).toLocaleString()} · ${token.maxUses} utilisation(s)

pnpm --filter @hotel-os/provisioning-cli start -- --server ${apiUrl} --token ${token.token} --dpc dpc-release.apk`}
        </pre>
      )}
    </div>
  );
}
