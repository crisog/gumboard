import { auth } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { FREE_PLAN_MEMBER_LIMIT } from "@/lib/constants";
import { z } from "zod";

const emailSchema = z.string().email("Invalid email address").min(1, "Email is required");

async function joinOrganization(token: string) {
  "use server";

  const session = await auth();
  if (!session?.user?.id || !session?.user?.email) {
    throw new Error("Not authenticated");
  }

  const userId = session.user.id;

  // Use transaction to prevent race conditions
  await db.$transaction(async (tx) => {
    // Find and validate the self-serve invite
    const invite = await tx.organizationSelfServeInvite.findUnique({
      where: { token: token },
      include: { 
        organization: {
          include: {
            plan: true,
            members: true,
            invites: {
              where: { status: "PENDING" }
            }
          }
        }
      },
    });

    if (!invite) {
      throw new Error("Invalid or expired invitation link");
    }

    if (!invite.isActive) {
      throw new Error("This invitation link has been deactivated");
    }

    // Check if invite has expired
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      throw new Error("This invitation link has expired");
    }

    // Check if usage limit has been reached (with fresh data)
    if (invite.usageLimit && invite.usageCount >= invite.usageLimit) {
      throw new Error("This invitation link has reached its usage limit");
    }

    // Check member limits for free plan (null planId = free tier)
    if (!invite.organization.plan) {
      
      const activeMembers = invite.organization.members.length;
      const pendingInvites = invite.organization.invites.length;
      const totalAfterJoin = activeMembers + pendingInvites + 1;

      if (totalAfterJoin > FREE_PLAN_MEMBER_LIMIT) {
        throw new Error(`Free plan is limited to ${FREE_PLAN_MEMBER_LIMIT} members total (${activeMembers} current + ${pendingInvites} pending). Upgrade to Team plan for unlimited members.`);
      }
    }

    // Check if user is already in an organization
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { organization: true },
    });

    if (user?.organizationId === invite.organizationId) {
      throw new Error("You are already a member of this organization");
    }

    if (user?.organizationId) {
      throw new Error(
        "You are already a member of another organization. Please leave your current organization first."
      );
    }

    // Atomic join: update user and increment usage count
    // This prevents the usage limit from being exceeded
    const updatedInvite = await tx.organizationSelfServeInvite.update({
      where: { token: token },
      data: { usageCount: { increment: 1 } },
    });

    // Double-check usage limit after increment (defensive programming)
    if (updatedInvite.usageLimit && updatedInvite.usageCount > updatedInvite.usageLimit) {
      throw new Error("This invitation link has reached its usage limit");
    }

    // Join the organization
    await tx.user.update({
      where: { id: userId },
      data: { organizationId: invite.organizationId },
    });
  });

  redirect("/dashboard");
}

async function autoCreateAccountAndJoin(token: string, formData: FormData) {
  "use server";

  const email = formData.get("email")?.toString();
  
  const validationResult = emailSchema.safeParse(email);
  if (!validationResult.success) {
    throw new Error(validationResult.error.issues[0].message);
  }

  const cleanEmail = validationResult.data.trim().toLowerCase();

  try {
    // Use transaction to prevent race conditions
    const result = await db.$transaction(async (tx) => {
      // Find and validate the self-serve invite
      const invite = await tx.organizationSelfServeInvite.findUnique({
        where: { token: token },
        include: { 
          organization: {
            include: {
              plan: true,
              members: true,
              invites: {
                where: { status: "PENDING" }
              }
            }
          }
        },
      });

      if (!invite || !invite.isActive) {
        throw new Error("Invalid or inactive invitation link");
      }

      // Check if invite has expired
      if (invite.expiresAt && invite.expiresAt < new Date()) {
        throw new Error("This invitation link has expired");
      }

      // Check if usage limit has been reached (with fresh data)
      if (invite.usageLimit && invite.usageCount >= invite.usageLimit) {
        throw new Error("This invitation link has reached its usage limit");
      }

      // Check member limits for free plan (null planId = free tier)
      if (!invite.organization.plan) {
        
        const activeMembers = invite.organization.members.length;
        const pendingInvites = invite.organization.invites.length;
        const totalAfterJoin = activeMembers + pendingInvites + 1;

        if (totalAfterJoin > FREE_PLAN_MEMBER_LIMIT) {
          throw new Error(`Free plan is limited to ${FREE_PLAN_MEMBER_LIMIT} members total (${activeMembers} current + ${pendingInvites} pending). Upgrade to Team plan for unlimited members.`);
        }
      }

      // Check if user already exists
      let user = await tx.user.findUnique({
        where: { email: cleanEmail },
      });

      let isNewJoin = false;

      if (!user) {
        // Increment usage count first to reserve a spot
        const updatedInvite = await tx.organizationSelfServeInvite.update({
          where: { token: token },
          data: { usageCount: { increment: 1 } },
        });

        // Double-check usage limit after increment
        if (updatedInvite.usageLimit && updatedInvite.usageCount > updatedInvite.usageLimit) {
          throw new Error("This invitation link has reached its usage limit");
        }

        // Create user with verified email and auto-join organization
        user = await tx.user.create({
          data: {
            email: cleanEmail,
            emailVerified: new Date(), // Auto-verify since they clicked the invite link
            organizationId: invite.organizationId, // Auto-join the organization
          },
        });
        isNewJoin = true;
      } else if (!user.organizationId) {
        // Increment usage count first to reserve a spot
        const updatedInvite = await tx.organizationSelfServeInvite.update({
          where: { token: token },
          data: { usageCount: { increment: 1 } },
        });

        // Double-check usage limit after increment
        if (updatedInvite.usageLimit && updatedInvite.usageCount > updatedInvite.usageLimit) {
          throw new Error("This invitation link has reached its usage limit");
        }

        // User exists but isn't in an organization, add them to this one
        user = await tx.user.update({
          where: { id: user.id },
          data: { 
            organizationId: invite.organizationId,
            emailVerified: user.emailVerified || new Date() // Verify if not already verified
          },
        });
        isNewJoin = true;
      } else if (user.organizationId === invite.organizationId) {
        // User is already in this organization, just continue (no usage increment)
      } else {
        throw new Error("You are already a member of another organization");
      }

      return { user, isNewJoin };
    });

    // Create a session for the user (outside transaction to avoid long locks)
    const sessionToken = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db.session.create({
      data: {
        sessionToken,
        userId: result.user.id,
        expires,
      },
    });

    // Redirect to a special endpoint that will set the session cookie and redirect to dashboard
    redirect(
      `/api/auth/set-session?token=${sessionToken}&redirectTo=${encodeURIComponent("/dashboard")}`
    );
  } catch (error) {
    console.error("Auto-join error:", error);
    // Fallback to regular auth flow
    redirect(
      `/auth/signin?email=${encodeURIComponent(cleanEmail)}&callbackUrl=${encodeURIComponent(`/join/${token}`)}`
    );
  }
}

interface JoinPageProps {
  params: Promise<{
    token: string;
  }>;
}

export default async function JoinPage({ params }: JoinPageProps) {
  const session = await auth();
  const { token } = await params;

  if (!token) {
    return (
      <ErrorCard
        title="Invalid Link"
        description="This invitation link is invalid or missing required information."
      />
    );
  }

  // Find the self-serve invite by token
  const invite = await db.organizationSelfServeInvite.findUnique({
    where: { token: token },
    include: {
      organization: true,
      user: true, // The user who created the invite
    },
  });

  if (!invite) {
    return (
      <ErrorCard
        title="Invalid Invitation"
        description="This invitation link is invalid or has expired."
      />
    );
  }

  // Check if invite is active
  if (!invite.isActive) {
    return (
      <ErrorCard
        title="Invitation Deactivated"
        description="This invitation link has been deactivated by the organization."
      />
    );
  }

  // Check if invite has expired
  if (invite.expiresAt && invite.expiresAt < new Date()) {
    return (
      <ErrorCard
        title="Invitation Expired"
        description={`This invitation expired on ${invite.expiresAt.toLocaleDateString()}.`}
      />
    );
  }

  // Check if usage limit has been reached
  if (invite.usageLimit && invite.usageCount >= invite.usageLimit) {
    return (
      <ErrorCard
        title="Invitation Limit Reached"
        description={`This invitation has reached its maximum usage limit of ${invite.usageLimit} uses.`}
      />
    );
  }

  // If user is not authenticated, show join form
  if (!session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-3">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">
              Join {invite.organization.name} on Gumboard!
            </h1>
            <p className="text-lg text-slate-600 dark:text-slate-400">
              You&apos;ve been invited to join{" "}
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {invite.organization.name}
              </span>{" "}
              on Gumboard
            </p>
          </div>
          <Card className="border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950">
            <CardHeader className="text-center pb-6">
              <div className="mx-auto border border-slate-200 dark:border-zinc-800 mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-slate-200 dark:bg-zinc-800">
                <span className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                  {invite.organization.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <CardTitle className="text-2xl font-semibold text-slate-900 dark:text-slate-100 -mt-5">
                {invite.organization.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {(invite.usageLimit || invite.expiresAt) && (
                <div className="text-center space-y-2 rounded-lg">
                  {invite.usageLimit && (
                    <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                      Usage: {invite.usageCount}/{invite.usageLimit}
                    </p>
                  )}
                  {invite.expiresAt && (
                    <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                      Expires: {invite.expiresAt.toLocaleDateString()}
                    </p>
                  )}
                </div>
              )}
              <form
                action={autoCreateAccountAndJoin.bind(null, invite.token!)}
                className="space-y-5"
              >
                <div className="space-y-2">
                  <Label
                    htmlFor="email"
                    className="block text-sm font-semibold text-slate-700 dark:text-slate-300"
                  >
                    Email Address
                  </Label>
                  <Input
                    type="email"
                    id="email"
                    name="email"
                    required
                    className="px-4 py-5"
                    placeholder="Enter your email address"
                  />
                </div>
                <Button type="submit" className="w-full px-4 py-5">
                  Join {invite.organization.name}
                </Button>
              </form>
              <div className="text-center pt-4 border-t border-slate-200 dark:border-zinc-700">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Already have an account?{" "}
                  <a
                    href={`/auth/signin?callbackUrl=${encodeURIComponent(`/join/${invite.token}`)}`}
                    className="font-semibold text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                  >
                    Sign in instead
                  </a>
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Check if user is already in an organization
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    include: { organization: true },
  });

  if (user?.organizationId === invite.organizationId) {
    redirect("/dashboard");
  }

  if (user?.organizationId) {
    return (
      <ErrorCard
        title="Already in Organization"
        description={`You are already a member of ${user.organization?.name}. You can only be a member of one organization at a time.`}
      />
    );
  }

  const usageInfo = invite.usageLimit
    ? `${invite.usageCount}/${invite.usageLimit} used`
    : `${invite.usageCount} members joined`;

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100 leading-tight">
            Join {invite.organization.name} on Gumboard!
          </h1>
          <p className="text-lg text-slate-600 dark:text-slate-400 leading-relaxed">
            You&apos;ve been invited to join{" "}
            <span className="font-semibold text-slate-800 dark:text-slate-200">
              {invite.organization.name}
            </span>{" "}
            on Gumboard
          </p>
        </div>
        <Card className="border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 shadow-sm">
          <CardHeader className="text-center pb-6">
            <div className="mx-auto mb-3 flex h-24 w-24 items-center justify-center rounded-full bg-slate-200 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-800">
              <span className="text-3xl font-bold text-slate-900 dark:text-slate-100">
                {invite.organization.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <CardTitle className="text-2xl font-semibold text-slate-900 dark:text-slate-100 -mt-2">
              {invite.organization.name}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-center space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Created by</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {invite.user.name || invite.user.email}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Organization info
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">{usageInfo}</p>
              </div>
              {invite.expiresAt && (
                <div className="pt-2">
                  <p className="text-xs text-muted-foreground">
                    Expires: {invite.expiresAt.toLocaleDateString()}
                  </p>
                </div>
              )}
            </div>
            <form action={joinOrganization.bind(null, token)} className="pt-2">
              <Button type="submit" className="w-full h-12 text-base font-medium" size="lg">
                Join {invite.organization.name}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ErrorCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-zinc-950">
      <Card className="w-full max-w-md border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950">
        <CardHeader className="text-center space-y-2">
          <CardTitle className="text-2xl font-semibold text-red-600">{title}</CardTitle>
          <CardDescription className="text-slate-600 dark:text-slate-400">
            {description}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <Button asChild className="w-full px-4 py-5">
            <Link href="/dashboard">Go to Dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
