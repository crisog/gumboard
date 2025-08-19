import type { Stripe } from "stripe";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { SubscriptionStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

const relevantEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
]);

const checkoutMetadataSchema = z.object({
  organizationId: z.string().min(1, "Organization ID is required"),
  userId: z.string().min(1, "User ID is required"),
  planId: z.string().min(1, "Plan ID is required"),
});

const subscriptionMetadataSchema = z.object({
  organizationId: z.string().min(1, "Organization ID is required"),
  userId: z.string().optional(),
  planId: z.string().optional(),
});

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

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        
        const metadataValidation = checkoutMetadataSchema.safeParse(session.metadata);
        if (!metadataValidation.success) {
          console.error("Invalid checkout session metadata:", metadataValidation.error.issues);
          return NextResponse.json(
            { error: "Invalid session metadata", details: metadataValidation.error.issues },
            { status: 400 }
          );
        }

        const { organizationId, planId } = metadataValidation.data;

        const subscriptionId = session.subscription as string;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        const subscriptionItem = subscription.items.data[0];
        if (!subscriptionItem) {
          console.error("No subscription items found");
          return NextResponse.json(
            { error: "No subscription items found" },
            { status: 400 }
          );
        }

        await db.organization.update({
          where: { id: organizationId },
          data: {
            stripeCustomerId: subscription.customer as string,
            stripeSubscriptionId: subscription.id,
            stripeCurrentPeriodEnd: new Date(
              subscriptionItem.current_period_end * 1000
            ),
            subscriptionStatus: mapStripeStatus(subscription.status),
            planId: planId,
          },
        });
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        
        const metadataValidation = subscriptionMetadataSchema.safeParse(subscription.metadata);
        if (!metadataValidation.success) {
          console.error("Invalid subscription metadata:", metadataValidation.error.issues);
          return NextResponse.json(
            { error: "Invalid subscription metadata", details: metadataValidation.error.issues },
            { status: 400 }
          );
        }

        const { organizationId, planId } = metadataValidation.data;

        // Get period information from the first subscription item
        const subscriptionItem = subscription.items.data[0];
        if (!subscriptionItem) {
          console.error("No subscription items found");
          return NextResponse.json(
            { error: "No subscription items found" },
            { status: 400 }
          );
        }

        const updateData: Prisma.OrganizationUpdateInput = {
          stripeSubscriptionId: subscription.id,
          stripeCurrentPeriodEnd: new Date(
            subscriptionItem.current_period_end * 1000
          ),
          subscriptionStatus: mapStripeStatus(subscription.status),
          // Only update planId if it's provided (for new subscriptions or plan changes)
          ...(planId && { planId }),
        };

        await db.organization.update({
          where: { id: organizationId },
          data: updateData,
        });
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        
        const organizationId = subscription.metadata?.organizationId;
        if (!organizationId) {
          console.error("No organizationId in subscription metadata");
          return NextResponse.json(
            { error: "Missing organizationId" },
            { status: 400 }
          );
        }

        await db.organization.update({
          where: { id: organizationId },
          data: {
            stripeSubscriptionId: null,
            stripeCurrentPeriodEnd: null,
            subscriptionStatus: "INACTIVE",
            planId: null,
          },
        });
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        
        // This handles successful subscription renewals
        const subscriptionId = await getSubscriptionIdFromInvoice(invoice);
        if (!subscriptionId) {
          console.log("Invoice not associated with subscription, skipping");
          break;
        }
        
        if (invoice.billing_reason === "subscription_cycle") {
          try {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const organizationId = subscription.metadata?.organizationId;
            
            if (organizationId) {
              const subscriptionItem = subscription.items.data[0];
              if (!subscriptionItem) {
                console.error("No subscription items found for renewal");
                break;
              }

              // Update the current period end for the organization
              await db.organization.update({
                where: { id: organizationId },
                data: {
                  stripeCurrentPeriodEnd: new Date(subscriptionItem.current_period_end * 1000),
                  subscriptionStatus: "ACTIVE",
                },
              });
              
              console.log(`Subscription renewed for organization ${organizationId}`);
            }
          } catch (error) {
            console.error("Error handling invoice payment:", error);
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        
        const subscriptionId = await getSubscriptionIdFromInvoice(invoice);
        if (!subscriptionId) {
          console.log("Failed invoice not associated with subscription, skipping");
          break;
        }
        
        try {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const organizationId = subscription.metadata?.organizationId;
          
          if (organizationId) {
            // Update subscription status to reflect payment failure
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
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook handler error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "canceled":
      return "CANCELED";
    case "incomplete":
      return "INCOMPLETE";
    case "incomplete_expired":
      return "INCOMPLETE_EXPIRED";
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

// Helper function to safely extract subscription ID from invoice
async function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): Promise<string | null> {
  // Check if this is a subscription invoice by looking at the line items
  for (const lineItem of invoice.lines.data) {
    if (lineItem.subscription) {
      const subId = typeof lineItem.subscription === 'string' 
        ? lineItem.subscription 
        : lineItem.subscription.id;
      return subId;
    }
  }

  // For subscription creation invoices, find subscription by customer and billing reason
  if (invoice.billing_reason === 'subscription_create' || invoice.billing_reason === 'subscription_cycle') {
    const customerId = typeof invoice.customer === 'string' 
      ? invoice.customer 
      : invoice.customer?.id;
      
    if (!customerId) {
      console.log('❌ No customer ID found in invoice');
      return null;
    }

    try {
      // Find active subscription for this customer
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10
      });

      // Return the most recent subscription
      if (subscriptions.data.length > 0) {
        return subscriptions.data[0].id;
      }
    } catch (error) {
      console.error('Error looking up subscription:', error);
    }
  }

  console.log("❌ No subscription ID found in invoice");
  return null;
}