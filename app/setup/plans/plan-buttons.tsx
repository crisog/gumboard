"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface PlanButtonsProps {
  planId: string;
  planName: string;
  stripePriceId: string | null;
  recommended?: boolean;
}

export default function PlanButtons({ planId, planName, stripePriceId, recommended }: PlanButtonsProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handlePlanSelection = async () => {
    setIsLoading(true);
    
    if (planId === "free" || !stripePriceId) {
      // Free plan - no Stripe price ID
      router.push("/setup/organization");
    } else {
      router.push(`/setup/organization?plan=team&planId=${planId}`);
    }
  };

  return (
    <Button 
      onClick={handlePlanSelection}
      disabled={isLoading}
      className={`w-full ${
        recommended 
          ? "bg-blue-600 hover:bg-blue-700" 
          : "bg-gray-600 hover:bg-gray-700"
      }`}
    >
      {isLoading ? "Loading..." : `Continue with ${planName}`}
    </Button>
  );
}