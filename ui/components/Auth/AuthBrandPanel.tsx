/** Left promise panel — shared by sign-in (matches onboarding redesign prototype). */

export function AuthBrandPanel() {
  return (
    <aside className="onboarding-split-l">
      <div className="onboarding-split-brand">
        <svg
          className="onboarding-split-mark"
          viewBox="0 0 105 124"
          fill="none"
          aria-hidden
        >
          <defs>
            <linearGradient
              id="onboardingPaprGrad"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#0060E0" />
              <stop offset="60%" stopColor="#00ACFA" />
              <stop offset="100%" stopColor="#0BCDFF" />
            </linearGradient>
          </defs>
          <path
            d="M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z"
            stroke="url(#onboardingPaprGrad)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="onboarding-split-word">Papr</span>
      </div>
      <h2 className="onboarding-split-promise">
        Personalize small software that runs your work.
      </h2>
      <p className="onboarding-split-sub">Powered by your company brain.</p>
    </aside>
  );
}

export function AuthFormFold() {
  return (
    <div className="onboarding-fold" aria-hidden>
      <svg viewBox="0 0 300 270" fill="none">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M300 262C300 266.418 296.418 270 292 270L54.5454 270L300 0L300 262Z"
          fill="#0080FF"
        />
        <path
          opacity="0.04"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M54.5454 40.5L54.5454 67.5L300 0L54.5454 40.5Z"
          fill="#212721"
        />
        <path
          opacity="0.48"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M54.5455 270L0 81L300 0L54.5455 270Z"
          fill="#0080FF"
        />
      </svg>
    </div>
  );
}
