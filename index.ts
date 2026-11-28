// Edge Function: create-pix
// Gera um Pix exclusivo para o pedido no Mercado Pago. O valor é calculado AQUI,
// a partir dos itens do pedido salvos no banco, nunca pelo valor enviado pelo navegador.
// Deploy com "Verify JWT" DESLIGADO (o site chama com a chave publishable, que não é JWT).
import { createClient } from "npm:@supabase/supabase-js@2";

// Preços oficiais (mantenha igual ao catálogo do site). Em reais.
const PRICES: Record<string, number> = {
  basico: 29.9,
  medio: 39.9,
  pro: 49.9,
  fivem: 99.9,
  clone: 10,
  server: 20,
  change: 20,
};

const MP_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const mp = (path: string, init: RequestInit = {}) =>
  fetch("https://api.mercadopago.com" + path, {
    ...init,
    headers: { Authorization: "Bearer " + MP_TOKEN, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

function pixData(p: any) {
  const t = p?.point_of_interaction?.transaction_data ?? {};
  return { qr_code: t.qr_code ?? "", qr_base64: t.qr_code_base64 ?? "" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!MP_TOKEN || !SB_URL || !SB_KEY) return json({ error: "config" }, 500);

  let orderId = "";
  try { orderId = String((await req.json()).order_id ?? ""); } catch { /* vazio */ }
  if (!/^[A-Za-z0-9-]{4,20}$/.test(orderId)) return json({ error: "order_id" }, 400);

  const { data: o, error } = await db.from("orders")
    .select("id,status,name,email,items,mp_payment_id,mp_amount").eq("id", orderId).maybeSingle();
  if (error || !o) return json({ error: "order_not_found" }, 404);
  if (o.status === "pago") return json({ status: "pago" });
  if (o.status !== "a_pagar" && o.status !== "pendente") return json({ error: "order_closed" }, 409);

  // Já existe Pix para este pedido? Reaproveita enquanto estiver pendente.
  if (o.mp_payment_id) {
    const r = await mp("/v1/payments/" + o.mp_payment_id);
    if (r.ok) {
      const p = await r.json();
      if (p.status === "approved") {
        await db.from("orders").update({ status: "pago", paid_at: new Date().toISOString() })
          .eq("id", o.id).in("status", ["a_pagar", "pendente"]);
        return json({ status: "pago" });
      }
      if (p.status === "pending" || p.status === "in_process") {
        return json({ status: "pending", amount: Number(o.mp_amount), ...pixData(p) });
      }
      // cancelado/expirado: cai para criar um novo Pix com o mesmo valor
    }
  }

  // Valor calculado no servidor
  const items = Array.isArray(o.items) ? o.items : [];
  let cents = 0;
  for (const it of items) {
    const price = PRICES[String(it?.id)];
    const q = Number(it?.q);
    if (price === undefined || !Number.isInteger(q) || q < 1 || q > 20) return json({ error: "items" }, 422);
    cents += Math.round(price * 100) * q;
  }
  if (cents < 100) return json({ error: "amount" }, 422);
  const amount = cents / 100;

  const attempt = (o.mp_payment_id ? "r" + Date.now() : "1");
  const body = {
    transaction_amount: amount,
    description: "Zox Code - Pedido " + o.id,
    payment_method_id: "pix",
    external_reference: o.id,
    notification_url: SB_URL + "/functions/v1/mp-webhook",
    payer: { email: String(o.email ?? ""), first_name: String(o.name ?? "").split(" ")[0] || "Cliente" },
  };
  const r = await mp("/v1/payments", {
    method: "POST",
    headers: { "X-Idempotency-Key": `${o.id}-${cents}-${attempt}` },
    body: JSON.stringify(body),
  });
  const p = await r.json().catch(() => ({}));
  if (!r.ok || !p?.id) {
    console.error("mp_create_failed", r.status, JSON.stringify(p).slice(0, 500));
    return json({ error: "mp_failed" }, 502);
  }

  const { error: upErr } = await db.from("orders").update({
    mp_payment_id: String(p.id), mp_amount: amount, total: amount,
  }).eq("id", o.id);
  if (upErr) { console.error("db_update_failed", upErr.message); return json({ error: "db" }, 500); }

  return json({ status: "pending", amount, ...pixData(p) });
});
