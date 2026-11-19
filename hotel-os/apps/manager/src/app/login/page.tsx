"use client";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useState } from "react";
import { ErrorBox } from "@/components/Shell";
import { api, errorText, session } from "@/lib/api";

type LoginResp = { ok: true; accessToken?: string; totpRequired?: true; setupRequired?: true; setupToken?: string };

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [setup, setSetup] = useState<{ token: string; secret?: string; qr?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (setup?.secret) {
        const r = await api<{ accessToken: string }>("/v1/auth/totp/confirm", { body: { setupToken: setup.token, code: totp } });
        session.set(r.accessToken);
        return router.replace("/hotels");
      }
      const r = await api<LoginResp>("/v1/auth/login", { body: { email, password, totp: needTotp ? totp : undefined } });
      if (r.accessToken) {
        session.set(r.accessToken);
        return router.replace("/hotels");
      }
      if (r.totpRequired) setNeedTotp(true);
      if (r.setupRequired && r.setupToken) {
        const s = await api<{ otpauthUrl: string; secret: string }>("/v1/auth/totp/setup", { body: { setupToken: r.setupToken } });
        setSetup({ token: r.setupToken, secret: s.secret, qr: await QRCode.toDataURL(s.otpauthUrl) });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 420 }}>
      <h1>HOTEL MANAGER</h1>
      <form className="panel" onSubmit={submit}>
        {!setup && (
          <>
            <label htmlFor="email">E-mail</label>
            <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: "100%" }} />
            <label htmlFor="password">Mot de passe</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: "100%" }} />
          </>
        )}
        {setup?.qr && (
          <>
            <p>La double authentification est obligatoire. Scannez ce QR code avec votre application d’authentification, puis saisissez le code.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR code TOTP" width={200} height={200} />
            <p className="mono">Clé : {setup.secret}</p>
          </>
        )}
        {(needTotp || setup) && (
          <>
            <label htmlFor="totp">Code à 6 chiffres</label>
            <input id="totp" inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} required />
          </>
        )}
        <ErrorBox error={error} />
        <div className="row" style={{ marginTop: 12 }}>
          <button type="submit" disabled={busy}>Se connecter</button>
        </div>
      </form>
    </main>
  );
}
