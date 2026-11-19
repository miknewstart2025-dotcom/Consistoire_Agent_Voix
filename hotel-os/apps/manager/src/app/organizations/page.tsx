"use client";
import { useCallback, useEffect, useState } from "react";
import { ErrorBox, Shell } from "@/components/Shell";
import { api, errorText } from "@/lib/api";

const MODULES = ["iptv", "room_service", "campaigns", "pms"];
const ROLES = ["ORG_ADMIN", "HOTEL_ADMIN", "MANAGER", "TECHNICIAN", "READ_ONLY"];

export default function Organizations() {
  return <Shell>{() => <Inner />}</Shell>;
}

function Inner() {
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState("");
  const [modules, setModules] = useState<string[]>(["iptv"]);
  const [user, setUser] = useState({ orgId: "", email: "", name: "", password: "", role: "ORG_ADMIN" });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ id: string; name: string }[]>("/v1/organizations").then((o) => { setOrgs(o); setUser((u) => ({ ...u, orgId: u.orgId || o[0]?.id || "" })); }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <h1>Organisations</h1>
      <ErrorBox error={error} />
      {msg && <p className="ok">{msg}</p>}
      <div className="panel">
        <table><tbody>{orgs.map((o) => <tr key={o.id}><td>{o.name}</td><td className="mono muted">{o.id}</td></tr>)}</tbody></table>
      </div>
      <form className="panel" onSubmit={async (e) => {
        e.preventDefault(); setError(null);
        try { await api("/v1/organizations", { body: { name, modules } }); setName(""); load(); setMsg("Organisation créée"); } catch (err) { setError(errorText(err)); }
      }}>
        <h2>Nouvelle organisation</h2>
        <div className="row">
          <input aria-label="Nom" placeholder="Nom" value={name} onChange={(e) => setName(e.target.value)} required />
          {MODULES.map((m) => (
            <label key={m} className="row" style={{ margin: 0 }}>
              <input type="checkbox" checked={modules.includes(m)} onChange={(e) => setModules(e.target.checked ? [...modules, m] : modules.filter((x) => x !== m))} /> {m}
            </label>
          ))}
          <button type="submit">Créer</button>
        </div>
      </form>
      <form className="panel" onSubmit={async (e) => {
        e.preventDefault(); setError(null);
        try { await api(`/v1/organizations/${user.orgId}/users`, { body: { email: user.email, name: user.name, password: user.password, role: user.role } }); setMsg(`Utilisateur ${user.email} ajouté (2FA demandée à la première connexion)`); setUser({ ...user, email: "", name: "", password: "" }); } catch (err) { setError(errorText(err)); }
      }}>
        <h2>Ajouter un utilisateur</h2>
        <div className="row">
          <select aria-label="Organisation" value={user.orgId} onChange={(e) => setUser({ ...user, orgId: e.target.value })}>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <input aria-label="E-mail" type="email" placeholder="e-mail" value={user.email} onChange={(e) => setUser({ ...user, email: e.target.value })} required />
          <input aria-label="Nom" placeholder="nom" value={user.name} onChange={(e) => setUser({ ...user, name: e.target.value })} required />
          <input aria-label="Mot de passe temporaire" type="password" placeholder="mot de passe temporaire (12+)" value={user.password} onChange={(e) => setUser({ ...user, password: e.target.value })} required minLength={12} />
          <select aria-label="Rôle" value={user.role} onChange={(e) => setUser({ ...user, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
          <button type="submit">Ajouter</button>
        </div>
      </form>
    </>
  );
}
