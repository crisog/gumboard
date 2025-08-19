import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { auth } from "@/auth";
import { z } from "zod";

const checkSessionRequestSchema = z.object({
  sessionId: z.string().min(1, "Session ID is required"),
});

const stripeSessionResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  payment_status: z.string(),
  customer_email: z.string().nullable(),
  customer_details: z.object({
    email: z.string().nullable(),
  }).nullable().optional(),
  subscription: z.union([z.string(), z.object({ id: z.string() })]).nullable(),
  metadata: z.record(z.string()).nullable(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const validationResult = checkSessionRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Invalid request", details: validationResult.error.issues },
        { status: 400 }
      );
    }

    const { sessionId } = validationResult.data;

    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });

    const sessionValidation = stripeSessionResponseSchema.safeParse(checkoutSession);
    if (!sessionValidation.success) {
      console.error("Invalid Stripe session response:", sessionValidation.error.issues);
      return NextResponse.json(
        { error: "Invalid session data from Stripe" },
        { status: 500 }
      );
    }

    if (checkoutSession.metadata?.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Session does not belong to authenticated user" },
        { status: 403 }
      );
    }

    return NextResponse.json({
      session: {
        id: checkoutSession.id,
        status: checkoutSession.status,
        payment_status: checkoutSession.payment_status,
        customer_email: checkoutSession.customer_email || checkoutSession.customer_details?.email,
        subscription_id: typeof checkoutSession.subscription === "string" 
          ? checkoutSession.subscription 
          : checkoutSession.subscription?.id,
        metadata: checkoutSession.metadata,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error checking session:", errorMessage);
    return NextResponse.json(
      { error: errorMessage },
      { status: 400 }
    );
  }
}