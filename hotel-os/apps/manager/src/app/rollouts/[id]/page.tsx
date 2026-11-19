"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorBox, Shell } from "@/components/Shell";
import { api, errorText } from "@/lib/api";

interface Rollout {
  id: string; packageName: string; scopeType: string; status: string; currentRing: number; rings: number[]; pausedReason: string | null; updateWindow: string; failureThresholdPct: number;
  version: { versionCode: number; versionName: string };
  counts: Record<string, number>;
  perRing: { ring: number; cumulativePct: number; devices: number; succeeded: number; failed: number; open: boolean }[];
  targets: { deviceId: string; ring: number; state: string; message: string | null }[];
}

export default function RolloutPage() {
  return <Shell>{() => <Inner />}</Shell>;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<Rollout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Rollout>(`/v1/rollouts/${id}`).then(setR).catch((e) => setError(errorText(e))), [id]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  async function act(a: string) {
    setError(null);
    try { setR(await api<Rollout>(`/v1/rollouts/${id}/${a}`, { body: {} })); } catch (e) { setError(errorText(e)); }
  }
  if (!r) return <ErrorBox error={error} />;
  const lastRing = r.currentRing >= r.rings.length - 1;
  return (
    <>
      <h1>{r.packageName} v{r.version.versionName} <span className={r.status === "COMPLETED" ? "ok" : r.status === "RUNNING" ? "" : "warn"}>· {r.status}</span></h1>
      <ErrorBox error={error} />
      {r.pausedReason && <div className="error">{r.pausedReason}</div>}
      <div className="panel">
        <div className="row">
          {r.status === "RUNNING" && !lastRing && <button onClick={() => act("advance")}>Ouvrir l’anneau suivant</button>}
          {r.status === "RUNNING" && <button className="secondary" onClick={() => act("pause")}>Pause</button>}
          {r.status === "PAUSED" && <button onClick={() => act("resume")}>Reprendre</button>}
          {(r.status === "RUNNING" || r.status === "PAUSED") && <button className="danger" onClick={() => confirm("Annuler ? Les boîtiers déjà mis à jour gardent cette version (Android interdit le retour arrière).") && act("cancel")}>Annuler</button>}
        </div>
        <p className="muted">Cible {r.scopeType} · mises à jour {r.updateWindow === "MAINTENANCE" ? "en fenêtre de maintenance" : "immédiates"} · pause automatique au-delà de {r.failureThresholdPct} % d’échecs. Le succès est mesuré à partir de l’inventaire remonté par chaque boîtier.</p>
        <div className="row">{Object.entries(r.counts).map(([k, v]) => <span key={k} className="chip">{k} : {v}</span>)}</div>
      </div>
      <div className="panel table-wrap">
        <h2>Anneaux</h2>
        <table><thead><tr><th>Anneau</th><th>Cumul</th><th>Boîtiers</th><th>Réussis</th><th>Échecs</th><th>État</th></tr></thead>
          <tbody>{r.perRing.map((g) => <tr key={g.ring}><td>{g.ring + 1}</td><td>{g.cumulativePct} %</td><td>{g.devices}</td><td className="ok">{g.succeeded}</td><td className={g.failed ? "bad" : ""}>{g.failed}</td><td>{g.open ? "ouvert" : "en attente"}</td></tr>)}</tbody></table>
      </div>
      <div className="panel table-wrap">
        <h2>Boîtiers</h2>
        <table><tbody>{r.targets.map((t) => (
          <tr key={t.deviceId}><td><Link href={`/devices/${t.deviceId}`} className="mono">{t.deviceId.slice(0, 8)}</Link></td><td>{t.ring >= 0 ? t.ring + 1 : "—"}</td>
            <td><span className={t.state === "SUCCEEDED" ? "ok" : t.state === "FAILED" ? "bad" : t.state === "SKIPPED_INCOMPATIBLE" ? "warn" : ""}>{t.state}</span></td><td className="muted">{t.message}</td></tr>
        ))}</tbody></table>
      </div>
    </>
  );
}
