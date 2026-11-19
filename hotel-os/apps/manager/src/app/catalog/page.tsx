"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ago, ErrorBox, type Me, Shell } from "@/components/Shell";
import { api, errorText, uploadApk } from "@/lib/api";

interface Version { id: string; versionCode: number; versionName: string; status: string; sizeBytes: number; minSdk: number | null; abis: string[]; warnings: string[]; createdAt: string }
interface CatalogApp { id: string; packageName: string; name: string; source: string; scope: string; signerSha256: string; versions: Version[] }
interface Rollout { id: string; packageName: string; scopeType: string; status: string; currentRing: number; rings: number[]; createdAt: string }
interface Target { id: string; label: string; type: string }

export default function Catalog() {
  return <Shell>{(me) => <Inner me={me} />}</Shell>;
}

function Inner({ me }: { me: Me }) {
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [catalog, setCatalog] = useState<string>(""); // org id, or "" = platform
  const [apps, setApps] = useState<CatalogApp[]>([]);
  const [rollouts, setRollouts] = useState<Rollout[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<Version & { pkg: string } | null>(null);

  useEffect(() => {
    api<{ id: string; name: string }[]>("/v1/organizations").then((o) => {
      setOrgs(o);
      if (!me.isPlatformAdmin && o[0]) setCatalog(o[0].id);
    }).catch((e) => setError(errorText(e)));
  }, [me.isPlatformAdmin]);

  const load = useCallback(() => {
    const q = catalog ? `?orgId=${catalog}` : "";
    if (!catalog && !me.isPlatformAdmin) return;
    api<CatalogApp[]>(`/v1/catalog/apps${q}`).then(setApps).catch((e) => setError(errorText(e)));
    api<Rollout[]>(`/v1/rollouts${q}`).then(setRollouts).catch(() => {});
  }, [catalog, me.isPlatformAdmin]);
  useEffect(load, [load]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await uploadApk<{ analysis: { packageName: string; versionCode: number; warnings: string[] } }>(`/v1/catalog/apks${catalog ? `?orgId=${catalog}` : ""}`, file);
      setMsg(`${r.analysis.packageName} v${r.analysis.versionCode} analysée et stockée${r.analysis.warnings.length ? ` — avertissements : ${r.analysis.warnings.join(" ; ")}` : ""}`);
      setFile(null); setAttest(false);
      load();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Catalogue APK</h1>
      <div className="row">
        <label htmlFor="cat" style={{ margin: 0 }}>Catalogue</label>
        <select id="cat" value={catalog} onChange={(e) => setCatalog(e.target.value)}>
          {me.isPlatformAdmin && <option value="">Plateforme (tous les hôtels)</option>}
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      {msg && <p className="ok">{msg}</p>}
      <form className="panel" onSubmit={upload}>
        <h2>Importer une APK</h2>
        <p className="muted">L’APK est analysée (paquet, version, SDK, architectures, permissions) et sa signature v2/v3 est vérifiée. Elle est stockée telle quelle, jamais modifiée. Les applications commerciales (Netflix, YouTube…) doivent venir de leur store officiel.</p>
        <input aria-label="Fichier APK" type="file" accept=".apk,application/vnd.android.package-archive" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <label className="row" style={{ marginTop: 8 }}><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> Je certifie disposer du droit de distribuer cette application dans les établissements concernés</label>
        <button type="submit" disabled={!file || !attest || busy}>{busy ? "Analyse…" : "Importer"}</button>
      </form>
      {apps.map((a) => (
        <div key={a.id} className="panel table-wrap">
          <h2>{a.name} <span className="mono muted">{a.packageName}</span> <span className="chip">{a.source}</span></h2>
          <div className="mono muted">Certificat épinglé : {a.signerSha256.slice(0, 32)}…</div>
          <table>
            <thead><tr><th>Version</th><th>Statut</th><th>Taille</th><th>SDK min</th><th>ABI</th><th>Avertissements</th><th></th></tr></thead>
            <tbody>{a.versions.map((v) => (
              <tr key={v.id}>
                <td>{v.versionName} <span className="muted">({v.versionCode})</span></td>
                <td><span className={v.status === "PUBLISHED" ? "ok" : "warn"}>{v.status}</span></td>
                <td>{(v.sizeBytes / 1048576).toFixed(1)} Mo</td>
                <td>{v.minSdk}</td>
                <td>{v.abis.join(", ") || "toutes"}</td>
                <td className="warn">{v.warnings.join(" · ")}</td>
                <td><button onClick={() => setDeploy({ ...v, pkg: a.packageName })}>Déployer</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {deploy && <DeployForm version={deploy} orgId={catalog} platform={me.isPlatformAdmin && !catalog} onDone={() => { setDeploy(null); load(); }} />}
      <div className="panel table-wrap">
        <h2>Déploiements</h2>
        <table><tbody>{rollouts.map((r) => (
          <tr key={r.id}><td><Link href={`/rollouts/${r.id}`}>{r.packageName}</Link></td><td>{r.scopeType}</td><td><span className={r.status === "COMPLETED" ? "ok" : r.status === "PAUSED" || r.status === "CANCELLED" ? "warn" : ""}>{r.status}</span></td><td>anneau {r.currentRing + 1}/{r.rings.length}</td><td className="muted">{ago(r.createdAt)}</td></tr>
        ))}</tbody></table>
        {!rollouts.length && <p className="muted">Aucun déploiement.</p>}
      </div>
    </>
  );
}

function DeployForm({ version, orgId, platform, onDone }: { version: Version & { pkg: string }; orgId: string; platform: boolean; onDone: () => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [scope, setScope] = useState(platform ? "ALL_HOTELS" : "");
  const [rings, setRings] = useState("5,25,100");
  const [window_, setWindow] = useState<"MAINTENANCE" | "IMMEDIATE">("MAINTENANCE");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const out: Target[] = [];
      if (orgId) out.push({ id: orgId, label: "Toute l’organisation", type: "ORG" });
      const hotels = await api<{ id: string; name: string; organizationId: string }[]>("/v1/hotels");
      for (const h of hotels.filter((x) => !orgId || x.organizationId === orgId)) {
        out.push({ id: h.id, label: `Hôtel · ${h.name}`, type: "HOTEL" });
        const groups = await api<{ id: string; name: string }[]>(`/v1/hotels/${h.id}/groups`).catch(() => []);
        groups.forEach((g) => out.push({ id: g.id, label: `Groupe · ${h.name} › ${g.name}`, type: "GROUP" }));
      }
      setTargets(out);
      if (!platform && out[0]) setScope(`${out[0].type}:${out[0].id}`);
    })().catch((e) => setError(errorText(e)));
  }, [orgId, platform]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const [scopeType, scopeId] = scope === "ALL_HOTELS" ? ["ALL_HOTELS", null] : scope.split(":");
    try {
      const r = await api<{ id: string }>("/v1/rollouts", { body: { appVersionId: version.id, scopeType, scopeId, rings: rings.split(",").map((x) => Number(x.trim())), updateWindow: window_, confirm: scopeType === "ALL_HOTELS" ? confirm : undefined } });
      onDone();
      location.href = `/rollouts/${r.id}`;
    } catch (err) { setError(errorText(err)); }
  }
  return (
    <form className="panel" onSubmit={submit}>
      <h2>Déployer {version.pkg} v{version.versionName}</h2>
      <label htmlFor="scope">Cible</label>
      <select id="scope" value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: "100%" }}>
        {platform && <option value="ALL_HOTELS">TOUS LES HÔTELS (toute la plateforme)</option>}
        {targets.map((t) => <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>{t.label}</option>)}
      </select>
      <label htmlFor="rings">Anneaux (pourcentages cumulés)</label>
      <input id="rings" value={rings} onChange={(e) => setRings(e.target.value)} />
      <label htmlFor="win">Mises à jour d’une app déjà installée</label>
      <select id="win" value={window_} onChange={(e) => setWindow(e.target.value as "MAINTENANCE" | "IMMEDIATE")}>
        <option value="MAINTENANCE">pendant la fenêtre de maintenance de l’hôtel</option>
        <option value="IMMEDIATE">immédiatement</option>
      </select>
      {scope === "ALL_HOTELS" && (
        <>
          <label htmlFor="confirm">Tapez « DEPLOY TO ALL HOTELS » pour confirmer</label>
          <input id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ width: "100%" }} />
        </>
      )}
      <ErrorBox error={error} />
      <div className="row" style={{ marginTop: 8 }}><button type="submit">Lancer le déploiement</button><button type="button" className="secondary" onClick={onDone}>Annuler</button></div>
    </form>
  );
}
