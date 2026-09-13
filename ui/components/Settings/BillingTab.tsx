/**
 * BillingTab — Plan, usage, and Papr Cloud subscription (separate from Profile).
 */

import React from "react";
import { PaprPlanSection } from "./PaprPlanSection";

export function BillingTab(): React.ReactElement {
  return (
    <div className="settings-section">
      <h2>Billing</h2>
      <PaprPlanSection />
    </div>
  );
}
