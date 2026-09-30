/** Four-step progress dashes across pre-app onboarding (auth → org → connect → app). */

export type OnboardingDashIndex = 0 | 1 | 2 | 3;

interface AuthProgressDotsProps {
  activeIndex: OnboardingDashIndex;
}

export function AuthProgressDots({ activeIndex }: AuthProgressDotsProps) {
  return (
    <div
      className="onboarding-stepdots"
      aria-label={`Onboarding step ${activeIndex + 1} of 4`}
    >
      {([0, 1, 2, 3] as const).map((index) => {
        let stateClass = "";
        if (index < activeIndex) {
          stateClass = "done";
        } else if (index === activeIndex) {
          stateClass = "on";
        }
        return <i key={index} className={stateClass} aria-hidden />;
      })}
    </div>
  );
}
