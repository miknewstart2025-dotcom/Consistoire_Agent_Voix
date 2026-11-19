"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ConfigEditor } from "@/components/ConfigEditor";
import { ago, ErrorBox, Shell } from "@/components/Shell";
import { api, errorText } from "@/lib/api";

interface Detail {
  device: { id: string; status: string; roomId: string | null; hardware: { manufacturer?: string; model?: string; buildFingerprint?: string; sdkInt?: number }; isDeviceOwner: boolean; kioskActive: boolean; launcherHealthy: boolean; versions: Record<string, number | null>; telemetry: { storageFreeMb?: number; ramFreeMb?: number; network?: { type: string; ip?: string } }; policyVersionApplied: number; reconcileErrors: { key: string; message: string }[]; lastSeenAt: string | null; lastStateAt: string | null };
  online: boolean;
  policy: { version: number; warnings: string[]; inSync: boolean } | null;
  apps: { packageName: string; label: string | null; system: boolean; installed: boolean; installedVersion: number | null; desired: string; visibleInLauncher: boolean; observedSuspended: boolean; observedHidden: boolean; inSync: boolean; notEnforceable: boolean }[];
  history: { event: string; createdAt: string }[];
}
interface Cmd { id: string; type: string; status: string; createdAt: string; resultMessage: string | null }

export default function DevicePage() {
  return <Shell>{() => <Inner />}</Shell>;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Detail>(`/v1/devices/${id}`).then(setD).catch((e) => setError(errorText(e)));
    api<Cmd[]>(`/v1/devices/${id}/commands`).then(setCmds).catch(() => {});
  }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  async function send(type: string, payload: Record<string, unknown> = {}) {
    setError(null);
    try { await api(`/v1/devices/${id}/commands`, { body: { type, payload } }); load(); } catch (e) { setError(errorText(e)); }
  }
  if (!d) return <ErrorBox error={error} />;
  const dev = d.device;
  return (
    <>
      <h1>Boîtier {dev.hardware.manufacturer} {dev.hardware.model} <span className={d.online ? "ok" : "bad"}>· {d.online ? "en ligne" : "hors ligne"}</span></h1>
      <ErrorBox error={error} />
      <div className="grid">
        <div className="panel"><h2>Contrôle</h2>
          <div>Device Owner : <b className={dev.isDeviceOwner ? "ok" : "bad"}>{dev.isDeviceOwner ? "oui" : "NON"}</b></div>
          <div>Kiosque : <b className={dev.kioskActive ? "ok" : "warn"}>{dev.kioskActive ? "actif" : "inactif"}</b></div>
          <div>Launcher : <b className={dev.launcherHealthy ? "ok" : "warn"}>{dev.launcherHealthy ? "OK" : "pas de signal"}</b></div>
          <div>Politique : v{dev.policyVersionApplied} / v{d.policy?.version ?? "?"} {d.policy?.inSync ? <span className="ok">synchronisée</span> : <span className="warn">en attente</span>}</div>
        </div>
        <div className="panel"><h2>Système</h2>
          <div>Android API {dev.hardware.sdkInt}</div>
          <div className="mono muted">{dev.hardware.buildFingerprint}</div>
          <div>Stockage libre : {dev.telemetry.storageFreeMb ?? "?"} Mo · RAM libre : {dev.telemetry.ramFreeMb ?? "?"} Mo</div>
          <div>Réseau : {dev.telemetry.network?.type ?? "?"} {dev.telemetry.network?.ip}</div>
          <div>Versions : {Object.entries(dev.versions).map(([k, v]) => `${k} ${v ?? "—"}`).join(" · ")}</div>
          <div className="muted">Dernier contact {ago(dev.lastSeenAt)}</div>
        </div>
        <div className="panel"><h2>Télécommande virtuelle</h2>
          <div className="row">
            <button onClick={() => send("SYNC_NOW")}>Synchroniser</button>
            <button onClick={() => send("REFRESH_UI")}>Rafraîchir l’interface</button>
            <button onClick={() => send("RESTART_LAUNCHER")}>Redémarrer le launcher</button>
            <button onClick={() => send("RUN_DIAGNOSTICS")}>Diagnostic</button>
            <button className="danger" onClick={() => confirm("Redémarrer le boîtier ?") && send("REBOOT_DEVICE")}>Redémarrer</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input aria-label="Message" placeholder="Message au client" value={message} onChange={(e) => setMessage(e.target.value)} />
            <button disabled={!message} onClick={() => { send("SHOW_MESSAGE", { text: message }); setMessage(""); }}>Envoyer</button>
          </div>
        </div>
      </div>
      {(dev.reconcileErrors.length > 0 || (d.policy?.warnings.length ?? 0) > 0) && (
        <div className="panel"><h2>Écarts et limites matérielles</h2>
          {dev.reconcileErrors.map((e) => <div key={e.key} className="bad">{e.key} : {e.message}</div>)}
          {d.policy?.warnings.map((w) => <div key={w} className="warn">{w}</div>)}
        </div>
      )}
      <div className="panel table-wrap"><h2>Applications (voulu / réel)</h2>
        <table><thead><tr><th>Application</th><th>Voulu</th><th>Installée</th><th>Suspendue</th><th>Masquée</th><th>Conforme</th></tr></thead>
          <tbody>{d.apps.map((a) => (
            <tr key={a.packageName}>
              <td>{a.label ?? a.packageName}<div className="mono muted">{a.packageName}</div></td>
              <td><span className="chip">{a.desired}</span>{a.visibleInLauncher && " · visible"}</td>
              <td>{a.installed ? `oui (${a.installedVersion})` : "non"}</td>
              <td>{a.observedSuspended ? "oui" : "non"}</td><td>{a.observedHidden ? "oui" : "non"}</td>
              <td>{a.inSync ? <span className="ok">✓</span> : <span className="warn">écart</span>}{a.notEnforceable && <div className="bad">non bloquable sur ce modèle</div>}</td>
            </tr>
          ))}</tbody></table>
      </div>
      <div className="panel table-wrap"><h2>Commandes</h2>
        <table><tbody>{cmds.map((c) => <tr key={c.id}><td>{c.type}</td><td><span className={c.status === "SUCCEEDED" ? "ok" : c.status === "FAILED" || c.status === "EXPIRED" ? "bad" : "warn"}>{c.status}</span></td><td className="muted">{c.resultMessage}</td><td className="muted">{ago(c.createdAt)}</td></tr>)}</tbody></table>
      </div>
      <ConfigEditor scopeType="DEVICE" scopeId={id} />
    </>
  );
}
