"use client";
import { useEffect, useState } from "react";
import { ErrorBox, Shell } from "@/components/Shell";
import { api, errorText } from "@/lib/api";

interface Model { id: string; manufacturer: string; model: string; androidVersion: string | null; apiLevel: number | null; status: string; capabilities: Record<string, unknown>; notes: string | null }

export default function Hardware() {
  return <Shell>{() => <Inner />}</Shell>;
}

function Inner() {
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Model[]>("/v1/device-models").then(setModels).catch((e) => setError(errorText(e))); }, []);
  return (
    <>
      <h1>Matériel compatible</h1>
      <p className="muted">Tout modèle vu à l’enrôlement apparaît ici en <b>PENDING</b> tant qu’il n’a pas passé la certification (auto-tests + checklist manuelle).</p>
      <ErrorBox error={error} />
      <div className="panel table-wrap">
        <table><thead><tr><th>Fabricant</th><th>Modèle</th><th>Android</th><th>Statut</th><th>Capacités mesurées</th></tr></thead>
          <tbody>{models.map((m) => (
            <tr key={m.id}><td>{m.manufacturer}</td><td>{m.model}</td><td>{m.androidVersion} (API {m.apiLevel})</td>
              <td><span className={m.status === "CERTIFIED" ? "ok" : m.status === "INCOMPATIBLE" ? "bad" : "warn"}>{m.status}</span></td>
              <td className="mono">{Object.entries(m.capabilities).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</td></tr>
          ))}</tbody></table>
      </div>
    </>
  );
}
