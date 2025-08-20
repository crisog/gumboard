import { env } from "@/lib/env";
import { Resend } from "resend";

const resend = new Resend(env.AUTH_RESEND_KEY);

export async function sendInviteEmail(to: string, organizationName: string, inviteId: string, baseUrl: string) {
  return resend.emails.send({
    from: env.EMAIL_FROM!,
    to,
    subject: `You're invited to join ${organizationName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>You're invited to join ${organizationName}!</h2>
        <p>You've been invited to join the team on Gumboard.</p>
        <p>Click the link below to accept the invitation:</p>
        <a href="${baseUrl}/invite/accept?token=${inviteId}" 
           style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
          Accept Invitation
        </a>
        <p style="margin-top: 20px; color: #666;">
          If you don't want to receive these emails, please ignore this message.
        </p>
      </div>
    `,
  });
}