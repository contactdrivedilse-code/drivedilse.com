// Cross-checks Razorpay's captured payments against our bookings table and
// reports any payment that was captured but never turned into a booking —
// e.g. the browser-callback-lost case the payment.captured webhook (see
// payment-webhook/index.ts) now prevents going forward, plus anything from
// before that webhook existed.
//
// Not part of the admin JWT auth model — this is an ops/debugging tool
// called directly with a shared secret, the same pattern as cleanup/index.ts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);

  const secret = req.headers.get("x-reconcile-secret");
  if (!secret || secret !== Deno.env.get("RECONCILE_SECRET"))
    return json({ error: "Unauthorized" }, 401);

  try {
    const url  = new URL(req.url);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7));
    const from = Math.floor((Date.now() - days * 86400000) / 1000);
    const auth = btoa(`${Deno.env.get("RAZORPAY_KEY_ID")}:${Deno.env.get("RAZORPAY_KEY_SECRET")}`);

    const payments: Record<string, unknown>[] = [];
    let skip = 0;
    while (true) {
      const res = await fetch(`https://api.razorpay.com/v1/payments?from=${from}&count=100&skip=${skip}`, {
        headers: { "Authorization": `Basic ${auth}` },
      });
      if (!res.ok) throw new Error(await res.text());
      const page = await res.json();
      const items = (page.items ?? []) as Record<string, unknown>[];
      payments.push(...items);
      if (items.length < 100) break;
      skip += 100;
      if (skip >= 1000) break; // safety cap
    }

    const captured = payments.filter((p) => p.status === "captured");
    const paymentIds = captured.map((p) => p.id as string);
    const { data: matched } = paymentIds.length
      ? await sb.from("bookings").select("razorpay_payment_id").in("razorpay_payment_id", paymentIds)
      : { data: [] as Record<string, unknown>[] };
    const matchedIds = new Set(((matched ?? []) as Record<string, unknown>[]).map((b) => b.razorpay_payment_id as string));

    const orphaned = captured
      .filter((p) => !matchedIds.has(p.id as string))
      .map((p) => ({
        paymentId: p.id, orderId: p.order_id, amount: (p.amount as number) / 100,
        createdAt: new Date((p.created_at as number) * 1000).toISOString(),
        contact: p.contact, email: p.email, method: p.method,
      }));

    return json({ daysChecked: days, capturedCount: captured.length, orphanedCount: orphaned.length, orphaned });
  } catch (e) {
    console.error("[reconcile-payments] error", (e as Error).message);
    return json({ error: "Internal server error" }, 500);
  }
});
