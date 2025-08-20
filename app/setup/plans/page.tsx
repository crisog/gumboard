import { auth } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Check } from "lucide-react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import PlanButtons from "./plan-buttons";

export default async function PlansPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/auth/signin");
  }

  if (!session.user.name) {
    redirect("/setup/profile");
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    include: { organization: true },
  });

  if (user?.organization) {
    redirect("/dashboard");
  }

  // Fetch plans from database
  const plans = await db.plan.findMany({
    orderBy: { name: "asc" },
  });

  // Add Free plan (hardcoded) + database plans
  const freePlan = {
    id: "free",
    name: "Free",
    price: "Free",
    description: "Perfect for small teams getting started",
    features: [
      "Up to 3 team members",
      "Unlimited boards", 
      "Unlimited tasks",
      "Basic support"
    ],
    recommended: false,
    stripePriceId: null,
  };

  // Convert database plans to display format
  const paidPlans = plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    price: plan.displayPrice || '$9/month', // All DB plans have stripePriceId now
    description: plan.description || "Perfect for teams",
    features: plan.features || [],
    recommended: plan.name.toLowerCase() === "team",
    stripePriceId: plan.stripePriceId,
  }));

  const displayPlans = [freePlan, ...paidPlans];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-zinc-900 dark:to-zinc-950">
      <div className="container mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8">
          <div className="text-center">
            <h1 className="text-2xl sm:text-3xl font-bold mb-2 text-blue-700 dark:text-blue-300">
              Choose Your Plan
            </h1>
            <p className="text-sm sm:text-base text-muted-foreground dark:text-zinc-400">
              Select the plan that best fits your team
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
            {displayPlans.map((plan) => (
              <Card 
                key={plan.id} 
                className={`relative flex flex-col border-2 bg-white dark:bg-zinc-900 dark:border-zinc-800 ${
                  plan.recommended 
                    ? "border-blue-500 shadow-lg" 
                    : "border-gray-200 dark:border-zinc-700"
                }`}
              >
                {plan.recommended && (
                  <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                    <span className="bg-blue-500 text-white px-3 py-1 rounded-full text-xs font-medium">
                      Recommended
                    </span>
                  </div>
                )}
                
                <CardHeader className="text-center pb-6">
                  <CardTitle className="text-xl text-blue-700 dark:text-blue-300">
                    {plan.name}
                  </CardTitle>
                  <div className="text-3xl font-bold text-gray-900 dark:text-white">
                    {plan.price}
                  </div>
                  <CardDescription className="text-sm text-muted-foreground dark:text-zinc-400">
                    {plan.description}
                  </CardDescription>
                </CardHeader>

                <CardContent className="flex-1 flex flex-col space-y-4">
                  <ul className="space-y-3 flex-1">
                    {plan.features.map((feature, index) => (
                      <li key={index} className="flex items-center gap-3">
                        <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                        <span className="text-sm text-gray-700 dark:text-zinc-300">
                          {feature}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <div className="pt-4">
                    <PlanButtons 
                      planId={plan.id}
                      planName={plan.name}
                      stripePriceId={plan.stripePriceId}
                      recommended={plan.recommended}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="text-center">
            <p className="text-xs text-muted-foreground dark:text-zinc-500">
              You can change your plan anytime from settings
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}