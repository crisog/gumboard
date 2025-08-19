import "server-only";
import Stripe from "stripe";
import { env } from "@/lib/env";

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-07-30.basil",
  typescript: true,
});

export const getStripeUrl = (path: string = "") => {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
  return `${baseUrl}${path}`;
};

export async function createCheckoutSession(
  organizationId: string, 
  userId: string,
  stripePriceId: string,
  planId: string
) {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [
      {
        price: stripePriceId,
        quantity: 1,
      },
    ],
    success_url: getStripeUrl("/api/stripe/checkout-success?session_id={CHECKOUT_SESSION_ID}"),
    cancel_url: getStripeUrl("/dashboard?canceled=true"),
    client_reference_id: userId, // Track which user initiated the checkout
    allow_promotion_codes: true, // Enable discount codes
    metadata: {
      organizationId,
      userId,
      planId,
    },
    subscription_data: {
      metadata: {
        organizationId,
        userId,
        planId,
      },
    },
  });

  return session;
}

export async function createPortalSession(customerId: string, returnUrl?: string) {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl || getStripeUrl("/dashboard/organization"),
  });

  return session;
}