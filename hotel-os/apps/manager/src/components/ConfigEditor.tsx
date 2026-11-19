"use client";
import { useEffect, useState } from "react";
import { ErrorBox } from "@/components/Shell";
import { api, errorText } from "@/lib/api";

export function ConfigEditor({ scopeType, scopeId }: { scopeType: string; scopeId: string; hotelId?: string }) {
  const [text, setText] = useState("");
  const [locked, setLocked] = useState("");
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<{ values: unknown; lockedKeys: string[]; version: number }>(`/v1/config/${scopeType}/${scopeId}`)
      .then((r) => { setText(JSON.stringify(r.values, null, 2)); setLocked(r.lockedKeys.join("\n")); setVersion(r.version); setLoaded(true); })
      .catch((e) => setError(errorText(e)));
  }, [scopeType, scopeId]);
  async function save() {
    setError(null); setMsg(null);
    let values: unknown;
    try { values = JSON.parse(text || "{}"); } catch { return setError("JSON invalide"); }
    try {
      const r = await api<{ layer: { version: number }; devicesRecomputed: number }>(`/v1/config/${scopeType}/${scopeId}`, { method: "PUT", body: { values, lockedKeys: locked.split("\n").map((s) => s.trim()).filter(Boolean) } });
      setVersion(r.layer.version);
      setMsg(`Version ${r.layer.version} enregistrée – ${r.devicesRecomputed} boîtier(s) recalculé(s)`);
    } catch (e) { setError(errorText(e)); }
  }
  if (!loaded) return <div className="panel"><ErrorBox error={error} /><p className="muted">Chargement de la configuration…</p></div>;
  return (
    <div className="panel">
      <h2>Configuration {scopeType} <span className="muted">v{version}</span></h2>
      <p className="muted">Ordre de priorité : GLOBAL → ORG → HÔTEL → GROUPE → CHAMBRE → BOÎTIER. Exemple : <code>{`{"apps":{"com.netflix.ninja":{"state":"ALLOWED","cleanup":"CLEAR_DATA"}}}`}</code></p>
      <textarea aria-label="Configuration JSON" rows={18} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <label htmlFor="locked">Clés verrouillées pour les niveaux inférieurs (une par ligne)</label>
      <textarea id="locked" rows={3} value={locked} onChange={(e) => setLocked(e.target.value)} />
      <ErrorBox error={error} />
      {msg && <p className="ok">{msg}</p>}
      <button onClick={save}>Enregistrer</button>
    </div>
  );
}

