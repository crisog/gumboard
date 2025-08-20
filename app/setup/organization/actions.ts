"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getBaseUrl } from "@/lib/utils";
import { headers } from "next/headers";
import { sendInviteEmail } from "@/lib/email";

export async function createOrganization(orgName: string, teamEmails: string[], skipMemberLimit: boolean = false) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Not authenticated");
  }

  if (!orgName?.trim()) {
    throw new Error("Organization name is required");
  }

  // Enforce member limits for free plan (unless skipped for team plan)
  if (!skipMemberLimit && teamEmails.length > 2) {
    throw new Error("Free plan is limited to 3 members total (1 creator + 2 invites)");
  }

  // Create organization without plan (null = free tier)
  const organization = await db.organization.create({
    data: {
      name: orgName.trim(),
      // planId is null by default = free tier
    },
  });

  await db.user.update({
    where: { id: session.user.id },
    data: {
      organizationId: organization.id,
      isAdmin: true,
    },
  });

  // Send invitations immediately only for free plan
  // For team plan, invitations will be sent after payment confirmation
  if (teamEmails.length > 0 && !skipMemberLimit) {
    const baseUrl = getBaseUrl(await headers());
    
    for (const email of teamEmails) {
      try {
        const cleanEmail = email.trim().toLowerCase();
        
        const invite = await db.organizationInvite.create({
          data: {
            email: cleanEmail,
            organizationId: organization.id,
            invitedBy: session.user.id,
            status: "PENDING",
          },
        });

        await sendInviteEmail(cleanEmail, organization.name, invite.id, baseUrl);
      } catch (inviteError) {
        console.error(`Failed to send invite to ${email}:`, inviteError);
      }
    }
  }

  return { success: true, organization, teamEmails: skipMemberLimit ? teamEmails : [] };
}