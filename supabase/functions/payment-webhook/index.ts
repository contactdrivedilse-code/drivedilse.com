// Razorpay payment.captured webhook — the fallback path that confirms a
// booking when the client-side /payment/verify call never happens.
//
// Normal flow: the customer pays, Razorpay's checkout.js runs our `handler`
// callback in the browser, which calls /payment/verify to create the
// booking. On mobile, paying via a UPI app (GPay/PhonePe/etc.) sends the
// browser away to that app and back; if the OS reloads or kills the tab
// during that switch, the callback never fires — the money is captured on
// Razorpay's side but the browser never tells us, so no booking gets made.
//
// This webhook is the server-to-server safety net: Razorpay calls it
// directly whenever a payment is captured, regardless of what the browser
// did. It looks up the pending_orders row that /payment/order or
// /payment/guest-order saved at checkout time and creates the booking from
// that, using the same createBooking() logic /verify uses — so whichever
// path (browser callback or webhook) gets there first wins, and the other
// is a no-op (see the unique index on bookings.razorpay_order_id).
//
// Deployed with --no-verify-jwt: Razorpay can't send our Supabase anon key,
// so this function must skip the platform's own gateway auth. Instead it
// authenticates the request itself via the x-razorpay-signature header,
// HMAC'd over the raw body with RAZORPAY_WEBHOOK_SECRET (set that same
// value as the webhook's secret in the Razorpay Dashboard).
import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { verifyWebhookSignature, computeOrderPaymentSignature } from "../_shared/razorpay.ts";
import { createBooking } from "../_shared/booking.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");
  const valid = await verifyWebhookSignature(rawBody, signature, Deno.env.get("RAZORPAY_WEBHOOK_SECRET")!);
  if (!valid) return json({ error: "Invalid signature" }, 400);

  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON" }, 400); }

  // Only payment.captured actually needs handling here. Acknowledge
  // everything else so Razorpay doesn't retry events we don't care about.
  if (body.event !== "payment.captured") return json({ received: true });

  try {
    const payment = ((body.payload as Record<string, unknown>)?.payment as Record<string, unknown>)?.entity as Record<string, unknown>;
    const orderId = payment?.order_id as string;
    const paymentId = payment?.id as string;
    if (!orderId || !paymentId) return json({ received: true });

    // Already handled — either the browser's own /verify call got there
    // first, or a previous delivery of this same webhook already did.
    const { data: existingBooking } = await sb.from("bookings").select("id").eq("razorpay_order_id", orderId).maybeSingle();
    if (existingBooking) return json({ received: true });

    const { data: pending } = await sb.from("pending_orders").select("*").eq("razorpay_order_id", orderId).is("consumed_at", null).maybeSingle();
    if (!pending) {
      // Nothing we recognize to reconstruct — log for manual follow-up since
      // Razorpay has definitely captured real money against this order.
      console.error("[payment-webhook] payment.captured with no pending_orders match", orderId, paymentId);
      return json({ received: true });
    }
    const po = pending as Record<string, unknown>;

    const razorpaySignature = await computeOrderPaymentSignature(orderId, paymentId, Deno.env.get("RAZORPAY_KEY_SECRET")!);
    const result = await createBooking(sb, {
      userId: po.user_id as string, carId: po.car_id as string,
      pickupDate: po.pickup_date as string, dropDate: po.drop_date as string,
      pickupLocation: po.pickup_location as string | undefined, dropLocation: po.drop_location as string | undefined,
      deliveryCharge: po.delivery_fee, couponCode: po.coupon_code as string | undefined,
      depositChoice: po.deposit_choice, sessionId: po.session_id as string | undefined,
      razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature,
      // The customer's browser is gone by the time this webhook runs — there's
      // no one to show a "car just got booked" error to, and the money is
      // already captured, so this path favors still recording the booking.
      skipConflictCheck: true,
    });

    if (result.ok) {
      await sb.from("pending_orders").update({ consumed_at: new Date().toISOString() }).eq("razorpay_order_id", orderId);
    } else {
      // Blacklisted phone — captured payment with no booking created.
      // Needs a human to arrange a refund; nothing more this webhook can do.
      console.error("[payment-webhook] payment.captured but booking blocked:", result.reason, orderId, paymentId);
    }
    return json({ received: true });
  } catch (e) {
    console.error("[payment-webhook] 500", (e as Error).message);
    // Non-2xx so Razorpay retries — this branch means something transient
    // (DB, etc.) broke, not a business-logic decision.
    return json({ error: "Internal server error" }, 500);
  }
});
