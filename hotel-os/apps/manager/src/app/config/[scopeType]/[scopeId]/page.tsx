"use client";
import { useParams } from "next/navigation";
import { ConfigEditor } from "@/components/ConfigEditor";
import { Shell } from "@/components/Shell";

export default function ConfigPage() {
  const { scopeType, scopeId } = useParams<{ scopeType: string; scopeId: string }>();
  return <Shell>{() => <ConfigEditor scopeType={scopeType} scopeId={scopeId} />}</Shell>;
}
