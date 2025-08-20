import type { Stripe } from "stripe";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { SubscriptionStatus } from "@prisma/client";
import { z } from "zod";

// Use invoice.payment_succeeded as single source of truth
const relevantEvents = new Set([
  "invoice.payment_succeeded",
  "invoice.payment_failed", 
  "customer.subscription.deleted",
  "customer.subscription.updated",
]);

const subscriptionMetadataSchema = z.object({
  organizationId: z.string().min(1, "Organization ID is required"),
  userId: z.string().optional(),
  planId: z.string().min(1, "Plan ID is required"),
});

async function ensureIdempotency(eventId: string, eventType: string): Promise<boolean> {
  try {
    await db.stripeWebhookEvent.create({
      data: {
        stripeEventId: eventId,
        eventType: eventType,
        processed: true,
      },
    });
    return true;
  } catch {
    console.log(`Event ${eventId} already processed, skipping`);
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "No signature" }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Webhook signature verification failed:", errorMessage);
    return NextResponse.json(
      { error: `Webhook Error: ${errorMessage}` },
      { status: 400 }
    );
  }

  if (!relevantEvents.has(event.type)) {
    return NextResponse.json({ received: true });
  }

  // Ensure idempotency
  const shouldProcess = await ensureIdempotency(event.id, event.type);
  if (!shouldProcess) {
    return NextResponse.json({ received: true });
  }

  try {
    switch (event.type) {
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentSucceeded(invoice);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(subscription);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook handler error:", error);
    // Remove the event record to allow retry
    await db.stripeWebhookEvent.delete({
      where: { stripeEventId: event.id },
    }).catch(() => {
      // Ignore deletion errors
    });
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}

function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  for (const lineItem of invoice.lines.data) {
    if (lineItem.subscription) {
      return typeof lineItem.subscription === 'string' 
        ? lineItem.subscription 
        : lineItem.subscription.id;
    }
  }
  return null;
}

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  console.log(`Processing invoice payment succeeded: ${invoice.id}`);

  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) {
    console.log("Invoice not associated with subscription, skipping");
    return;
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.product']
    });

    const metadataValidation = subscriptionMetadataSchema.safeParse(subscription.metadata);
    if (!metadataValidation.success) {
      console.error("Invalid subscription metadata:", metadataValidation.error.issues);
      throw new Error(`Invalid subscription metadata: ${metadataValidation.error.issues.map(i => i.message).join(', ')}`);
    }

    const { organizationId, planId } = metadataValidation.data;
    
    // Get subscription details
    const subscriptionItem = subscription.items.data[0];
    if (!subscriptionItem) {
      throw new Error("No subscription items found");
    }

    // Defensive programming: Use upsert to handle race conditions
    await db.organization.upsert({
      where: { id: organizationId },
      update: {
        stripeCustomerId: subscription.customer as string,
        stripeSubscriptionId: subscription.id,
        stripeCurrentPeriodEnd: new Date(subscriptionItem.current_period_end * 1000),
        subscriptionStatus: mapStripeStatus(subscription.status),
        planId: planId,
      },
      create: {
        id: organizationId,
        name: "Organization", // Default name, should be updated elsewhere
        stripeCustomerId: subscription.customer as string,
        stripeSubscriptionId: subscription.id,
        stripeCurrentPeriodEnd: new Date(subscriptionItem.current_period_end * 1000),
        subscriptionStatus: mapStripeStatus(subscription.status),
        planId: planId,
      },
    });

    console.log(`Successfully processed payment for organization ${organizationId}`);
  } catch (error) {
    console.error("Error handling invoice payment succeeded:", error);
    throw error;
  }
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  console.log(`Processing invoice payment failed: ${invoice.id}`);

  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) {
    console.log("Failed invoice not associated with subscription, skipping");
    return;
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const organizationId = subscription.metadata?.organizationId;

    if (organizationId) {
      await db.organization.update({
        where: { id: organizationId },
        data: {
          subscriptionStatus: "PAST_DUE",
        },
      });

      console.log(`Payment failed for organization ${organizationId}`);
    }
  } catch (error) {
    console.error("Error handling failed payment:", error);
    throw error;
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  console.log(`Processing subscription deleted: ${subscription.id}`);

  const organizationId = subscription.metadata?.organizationId;
  if (!organizationId) {
    console.error("No organizationId in subscription metadata");
    throw new Error("Missing organizationId in subscription metadata");
  }

  try {
    await db.organization.update({
      where: { id: organizationId },
      data: {
        stripeSubscriptionId: null,
        stripeCurrentPeriodEnd: null,
        subscriptionStatus: "CANCELED",
        planId: null,
      },
    });

    console.log(`Subscription deleted for organization ${organizationId}`);
  } catch (error) {
    console.error("Error handling subscription deletion:", error);
    throw error;
  }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  console.log(`Processing subscription updated: ${subscription.id}`);

  const metadataValidation = subscriptionMetadataSchema.safeParse(subscription.metadata);
  if (!metadataValidation.success) {
    console.error("Invalid subscription metadata:", metadataValidation.error.issues);
    throw new Error(`Invalid subscription metadata: ${metadataValidation.error.issues.map(i => i.message).join(', ')}`);
  }

  const { organizationId, planId } = metadataValidation.data;
  
  try {
    // Get subscription item details
    const subscriptionItem = subscription.items.data[0];
    if (!subscriptionItem) {
      throw new Error("No subscription items found");
    }

    // Get the current period end from the subscription item
    const currentPeriodEnd = subscriptionItem.current_period_end 
      ? new Date(subscriptionItem.current_period_end * 1000) 
      : null;

    await db.organization.update({
      where: { id: organizationId },
      data: {
        stripeSubscriptionId: subscription.id,
        stripeCurrentPeriodEnd: currentPeriodEnd,
        subscriptionStatus: mapStripeStatus(subscription.status),
        planId: planId,
      },
    });

    console.log(`Subscription updated for organization ${organizationId} - Status: ${subscription.status}, Plan: ${planId}`);
  } catch (error) {
    console.error("Error handling subscription update:", error);
    throw error;
  }
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "canceled": 
      return "CANCELED";
    case "past_due":
      return "PAST_DUE";
    case "trialing":
      return "TRIALING";
    case "unpaid":
      return "UNPAID";
    default:
      return "INACTIVE";
  }
}

