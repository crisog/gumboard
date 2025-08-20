import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { auth } from "@/auth";
import { getBaseUrl } from "@/lib/utils";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { sendInviteEmail } from "@/lib/email";

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

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.userId !== authSession.user.id) {
      console.error("Session user mismatch");
      return NextResponse.redirect(new URL("/dashboard?subscription=error", request.url));
    }

    if (session.payment_status === "paid") {
      // Send team member invitations after successful payment
      if (session.metadata?.teamEmails) {
        try {
          const teamEmails = JSON.parse(session.metadata.teamEmails);
          if (teamEmails.length > 0) {
            const user = await db.user.findUnique({
              where: { id: authSession.user.id },
              include: { organization: true },
            });

            if (user?.organization) {
              const baseUrl = getBaseUrl(await headers());
              
              // Send team invitations
              for (const email of teamEmails) {
                try {
                  const cleanEmail = email.trim().toLowerCase();
                  
                  const invite = await db.organizationInvite.create({
                    data: {
                      email: cleanEmail,
                      organizationId: user.organization.id,
                      invitedBy: authSession.user.id,
                      status: "PENDING",
                    },
                  });

                  await sendInviteEmail(cleanEmail, user.organization.name, invite.id, baseUrl);
                } catch (inviteError) {
                  console.error(`Failed to send invite to ${email}:`, inviteError);
                }
              }
              console.log(`📧 Sent ${teamEmails.length} team invitations`);
            }
          }
        } catch (emailError) {
          console.error("❌ Error sending team invitations:", emailError);
          // Don't fail the entire flow if email sending fails
        }
      }

      return NextResponse.redirect(new URL("/dashboard?subscription=success", request.url));
    } else if (session.payment_status === "unpaid") {
      return NextResponse.redirect(new URL("/dashboard?subscription=unpaid", request.url));
    }

    return NextResponse.redirect(new URL("/dashboard?subscription=pending", request.url));
  } catch (error) {
    console.error("Error handling checkout success:", error);
    return NextResponse.redirect(new URL("/dashboard?subscription=error", request.url));
  }
}