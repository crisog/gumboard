import { auth } from "@/auth";
import { db } from "@/lib/db";
import { createCheckoutSession } from "@/lib/stripe";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const checkoutRequestSchema = z.object({
  planId: z.string().min(1, "Plan ID is required"),
  teamEmails: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const validationResult = checkoutRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Invalid request", details: validationResult.error.issues },
        { status: 400 }
      );
    }

    const { planId, teamEmails } = validationResult.data;

    const plan = await db.plan.findUnique({
      where: { id: planId },
    });

    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    if (!plan.stripePriceId) {
      return NextResponse.json({ error: "Plan is not configured for payments" }, { status: 400 });
    }

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      include: {
        organization: true,
      },
    });

    if (!user?.organizationId || !user.organization) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }

    if (!user.isAdmin) {
      return NextResponse.json(
        { error: "Only admins can manage billing" },
        { status: 403 }
      );
    }

    // Allow upgrade from free plan (no active subscription) to paid plan
    if (user.organization.stripeCustomerId && user.organization.stripeSubscriptionId) {
      return NextResponse.json(
        { error: "Organization already has an active subscription. Use billing portal to change plans." },
        { status: 400 }
      );
    }

    const checkoutSession = await createCheckoutSession(
      user.organizationId,
      user.id,
      plan.stripePriceId,
      plan.id,
      teamEmails
    );

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("Checkout session creation error:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}