import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { auth } from "@/auth";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const sessionId = searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  try {
    const authSession = await auth();
    if (!authSession?.user?.id) {
      return NextResponse.redirect(new URL("/auth/signin", request.url));
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer", "line_items"],
    });

    if (session.metadata?.userId !== authSession.user.id) {
      console.error("Session user mismatch");
      return NextResponse.redirect(new URL("/dashboard?subscription=error", request.url));
    }

    if (session.payment_status === "paid") {
      
      if (session.metadata?.organizationId) {
        const org = await db.organization.findUnique({
          where: { id: session.metadata.organizationId },
          select: { 
            stripeSubscriptionId: true,
            subscriptionStatus: true 
          }
        });

        if (org?.stripeSubscriptionId) {
          console.log(`Subscription created successfully for org ${session.metadata.organizationId}`);
          return NextResponse.redirect(new URL("/dashboard?subscription=success", request.url));
        } else {
          console.log("Subscription pending webhook processing");
          return NextResponse.redirect(new URL("/dashboard?subscription=processing", request.url));
        }
      }
    } else if (session.payment_status === "unpaid") {
      return NextResponse.redirect(new URL("/dashboard?subscription=unpaid", request.url));
    }

    return NextResponse.redirect(new URL("/dashboard?subscription=pending", request.url));
  } catch (error) {
    console.error("Error handling checkout success:", error);
    return NextResponse.redirect(new URL("/dashboard?subscription=error", request.url));
  }
}