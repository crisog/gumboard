"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useUser } from "@/app/contexts/UserContext";
import { createOrganization } from "./actions";
import { Plan } from "@prisma/client";

interface OrganizationSetupFormProps {
  maxMembers: number | null;
  isTeamPlan?: boolean;
}

export default function OrganizationSetupForm({ maxMembers, isTeamPlan = false }: OrganizationSetupFormProps) {
  const [orgName, setOrgName] = useState("");
  const [teamEmails, setTeamEmails] = useState<string[]>([""]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();
  const { refreshUser } = useUser();

  const addEmailField = () => {
    if (maxMembers && teamEmails.length >= maxMembers) {
      return;
    }
    setTeamEmails([...teamEmails, ""]);
  };

  const removeEmailField = (index: number) => {
    if (teamEmails.length > 1) {
      setTeamEmails(teamEmails.filter((_, i) => i !== index));
    }
  };

  const updateEmail = (index: number, value: string) => {
    const updated = [...teamEmails];
    updated[index] = value;
    setTeamEmails(updated);
  };

  const hasValidEmails = () => {
    return teamEmails.filter((email) => email.trim() && email.includes("@")).length > 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) return;

    setIsSubmitting(true);
    try {
      const validEmails = teamEmails.filter((email) => email.trim() && email.includes("@"));
      
      // Always create organization first (with free plan)
      const result = await createOrganization(
        orgName.trim(), 
        validEmails,
        isTeamPlan // Skip member limit for team plan
      );
      
      if (result?.success) {
        await refreshUser();
        
        if (isTeamPlan) {
          // For team plan, redirect to Stripe checkout after org creation
          try {
            // Get the team plan from database
            const plansResponse = await fetch("/api/plans");
            const plans: Plan[] = await plansResponse.json();
            const teamPlan = plans.find((p) => p.name.toLowerCase() === "team");
            
            if (!teamPlan) {
              console.error("Team plan not found");
              setIsSubmitting(false);
              return;
            }

            // Create Stripe checkout session
            const checkoutResponse = await fetch("/api/stripe/checkout", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                planId: teamPlan.id,
                teamEmails: JSON.stringify(validEmails),
              }),
            });

            if (!checkoutResponse.ok) {
              console.error("Checkout failed:", await checkoutResponse.text());
              setIsSubmitting(false);
              return;
            }

            const { url } = await checkoutResponse.json();
            
            if (url) {
              // Redirect to Stripe Checkout
              window.location.href = url;
            } else {
              console.error("No checkout URL received");
              setIsSubmitting(false);
            }
          } catch (error) {
            console.error("Error creating checkout session:", error);
            setIsSubmitting(false);
          }
        } else {
          // For free plan, go directly to dashboard
          router.push("/dashboard");
        }
      } else {
        setIsSubmitting(false);
      }
    } catch (error) {
      console.error("Error:", error);
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 dark:text-zinc-400">
      <div className="space-y-2">
        <Label htmlFor="organizationName">Organization Name</Label>
        <Input
          id="organizationName"
          type="text"
          placeholder="Enter your organization name"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          required
          className="w-full"
        />
      </div>

      <div className="space-y-4">
        <Label>Team Member Email Addresses</Label>

        <div className="space-y-3">
          {teamEmails.map((email, index) => (
            <div key={index} className="flex gap-2">
              <Input
                type="email"
                placeholder="teammate@company.com"
                value={email}
                onChange={(e) => updateEmail(index, e.target.value)}
                className="flex-1"
              />
              {teamEmails.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => removeEmailField(index)}
                  className="shrink-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>

        <Button 
          type="button" 
          variant="outline" 
          onClick={addEmailField} 
          className="w-full"
          disabled={maxMembers !== null && teamEmails.length >= maxMembers}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Team Member
        </Button>

        {maxMembers && !isTeamPlan && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Free plan is limited to 3 members total (1 creator + 2 invites).
          </p>
        )}
        
        {isTeamPlan && (
          <p className="text-xs text-blue-600 dark:text-blue-400">
            Team plan includes unlimited members. You&apos;ll be redirected to payment after setup.
          </p>
        )}
        
        <p className="text-xs text-muted-foreground">
          {`We'll send invitations to join your organization to these email addresses.`}
        </p>
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? "Creating..." : hasValidEmails() ? "Save & Send Invites" : "Save"}
      </Button>
    </form>
  );
}
