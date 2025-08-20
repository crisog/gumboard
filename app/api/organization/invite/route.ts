import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/utils";
import { FREE_PLAN_MEMBER_LIMIT } from "@/lib/constants";
import { sendInviteEmail } from "@/lib/email";
import { z } from "zod";

const inviteRequestSchema = z.object({
  email: z.string().email("Invalid email address").min(1, "Email is required"),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    const body = await request.json();
    const validationResult = inviteRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        { 
          error: "Invalid request", 
          details: validationResult.error.issues.map(issue => issue.message)
        }, 
        { status: 400 }
      );
    }

    const { email } = validationResult.data;
    const cleanEmail = email.trim().toLowerCase();

    // Get user with organization and plan
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        isAdmin: true,
        organizationId: true,
        organization: {
          include: {
            plan: true,
            members: true,
            invites: {
              where: {
                status: "PENDING"
              }
            }
          }
        },
      },
    });

    if (!user?.organizationId || !user.organization) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    // Only admins can invite new members
    if (!user.isAdmin) {
      return NextResponse.json({ error: "Only admins can invite new members" }, { status: 403 });
    }

    // Check member limits for free plan (null planId = free tier)
    if (!user.organization.plan) {
      const activeMembers = user.organization.members.length;
      const pendingInvites = user.organization.invites.length;
      const totalAfterInvite = activeMembers + pendingInvites + 1;

      if (totalAfterInvite > FREE_PLAN_MEMBER_LIMIT) {
        return NextResponse.json({
          error: `Free plan is limited to ${FREE_PLAN_MEMBER_LIMIT} members total (${activeMembers} current + ${pendingInvites} pending). Upgrade to Team plan for unlimited members.`
        }, { status: 400 });
      }
    }

    // Check for existing user or invite
    const [existingUser, existingInvite] = await Promise.all([
      db.user.findUnique({
        where: { email: cleanEmail },
        select: { organizationId: true }
      }),
      db.organizationInvite.findUnique({
        where: {
          email_organizationId: {
            email: cleanEmail,
            organizationId: user.organizationId!
          }
        }
      })
    ]);

    if (existingUser?.organizationId === user.organizationId) {
      return NextResponse.json({ error: "User is already a member of this organization" }, { status: 400 });
    }

    if (existingInvite?.status === "PENDING") {
      return NextResponse.json({ error: "Invite already sent to this email" }, { status: 400 });
    }

    // Create or update invite
    const invite = await db.organizationInvite.upsert({
      where: {
        email_organizationId: {
          email: cleanEmail,
          organizationId: user.organizationId!
        }
      },
      update: {
        status: "PENDING",
        createdAt: new Date()
      },
      create: {
        email: cleanEmail,
        organizationId: user.organizationId!,
        invitedBy: userId,
        status: "PENDING"
      }
    });

    // Send email
    try {
      await sendInviteEmail(cleanEmail, user.organization.name, invite.id, getBaseUrl(request));
    } catch (emailError) {
      console.error("Failed to send invitation email:", emailError);
    }

    return NextResponse.json({ invite }, { status: 201 });
  } catch (error) {
    console.error("Error creating invite:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
