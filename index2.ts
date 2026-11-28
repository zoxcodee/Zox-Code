// Edge Function: mp-webhook
// Recebe o aviso do Mercado Pago e marca o pedido como "pago".
// Não confia no aviso: busca o pagamento direto na API do Mercado Pago com o seu token
// e confere status, pedido e valor antes de liberar.
// Deploy com "Verify JWT" DESLIGADO (o Mercado Pago não envia JWT do Supabase).
import { createClient } from "npm:@supabase/supabase-js@2";

const MP_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (!MP_TOKEN || !SB_URL || !SB_KEY) return new Response("config", { status: 500 });

  const url = new URL(req.url);
  let body: any = {};
  try { body = await req.json(); } catch { /* o aviso pode vir só na URL */ }

  const topic = String(body?.type ?? url.searchParams.get("type") ?? url.searchParams.get("topic") ?? "");
  const action = String(body?.action ?? "");
  if (topic !== "payment" && !action.startsWith("payment")) return new Response("ignored", { status: 200 });

  const paymentId = String(body?.data?.id ?? url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? "");
  if (!/^\d{3,20}$/.test(paymentId)) return new Response("ignored", { status: 200 });

  // Fonte da verdade: o próprio Mercado Pago
  const r = await fetch("https://api.mercadopago.com/v1/payments/" + paymentId, {
    headers: { Authorization: "Bearer " + MP_TOKEN },
  });
  if (!r.ok) {
    console.error("mp_fetch_failed", r.status);
    return new Response("retry", { status: 500 }); // o Mercado Pago tenta de novo
  }
  const p = await r.json();
  if (p.status !== "approved") return new Response("not approved", { status: 200 });

  const orderId = String(p.external_reference ?? "");
  const { data: o } = await db.from("orders")
    .select("id,status,mp_payment_id,mp_amount").eq("id", orderId).maybeSingle();
  if (!o) return new Response("order not found", { status: 200 });
  if (o.status === "pago") return new Response("already paid", { status: 200 });

  const okId = String(o.mp_payment_id ?? "") === String(p.id);
  const okAmount = Math.abs(Number(p.transaction_amount) - Number(o.mp_amount)) < 0.01;
  if (!okId || !okAmount) {
    console.error("mismatch", o.id, okId, okAmount);
    return new Response("mismatch", { status: 200 });
  }

  const { error } = await db.from("orders")
    .update({ status: "pago", paid_at: new Date().toISOString() })
    .eq("id", o.id).in("status", ["a_pagar", "pendente"]);
  if (error) {
    console.error("db_update_failed", error.message);
    return new Response("retry", { status: 500 });
  }
  return new Response("ok", { status: 200 });
});
