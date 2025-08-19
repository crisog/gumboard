import { auth } from "@/auth";
import { db } from "@/lib/db";
import { createPortalSession } from "@/lib/stripe";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    if (!user.organization.stripeCustomerId) {
      return NextResponse.json(
        { error: "No active subscription found" },
        { status: 404 }
      );
    }

    const portalSession = await createPortalSession(
      user.organization.stripeCustomerId
    );

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Portal session creation error:", error.message);
      
      // Handle specific Stripe errors
      if (error.message.includes("No such customer")) {
        return NextResponse.json(
          { error: "Customer not found in Stripe" },
          { status: 404 }
        );
      }
      
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }
    
    console.error("Portal session creation error:", error);
    return NextResponse.json(
      { error: "Failed to create portal session" },
      { status: 500 }
    );
  }
}