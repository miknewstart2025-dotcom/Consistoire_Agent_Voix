"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, session } from "@/lib/api";
import { t } from "@/lib/i18n";

export interface Me {
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
  memberships: { orgId: string; hotelId: string | null; role: string }[];
}

export function Shell({ children }: { children: (me: Me) => React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!session.get()) {
      router.replace("/login");
      return;
    }
    api<Me>("/v1/auth/me").then(setMe).catch(() => router.replace("/login"));
  }, [router]);
  if (!me) return <main className="muted">…</main>;
  return (
    <>
      <header className="top">
        <span className="brand">HOTEL MANAGER</span>
        <nav>
          <Link href="/hotels">{t("hotels")}</Link>
          {me.isPlatformAdmin && <Link href="/organizations">Organisations</Link>}
          <Link href="/hardware">Matériel</Link>
          <Link href="/tech">Technicien</Link>
        </nav>
        <span className="muted">{me.email}</span>
        <button
          className="secondary"
          onClick={() => {
            session.clear();
            router.replace("/login");
          }}
        >
          {t("logout")}
        </button>
      </header>
      <main>{children(me)}</main>
    </>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error" role="alert">{error}</div> : null;
}

export function ago(iso: string | null | undefined) {
  if (!iso) return "jamais";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `il y a ${s}s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
