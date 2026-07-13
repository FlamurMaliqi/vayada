import type { StepIndicatorProps } from "./types";

export function StepIndicators({ steps, currentStep }: StepIndicatorProps) {
  const currentStepTitle = steps[currentStep - 1];

  return (
    <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
      <p className="text-sm font-semibold text-gray-500">
        Step {currentStep} of {steps.length}
        {currentStepTitle ? ` · ${currentStepTitle}` : ""}
      </p>
      <ol className="flex items-center justify-center gap-2" aria-label="Profile setup progress">
        {steps.map((step, index) => {
          const stepNumber = index + 1;
          const isActive = currentStep === stepNumber;
          const isCompleted = currentStep > stepNumber;

          return (
            <li
              key={step}
              aria-current={isActive ? "step" : undefined}
              title={step}
              className={`h-2 rounded-full transition-all duration-300 ${
                isActive || isCompleted ? "w-10 bg-primary-600" : "w-3 bg-primary-100"
              }`}
            >
              <span className="sr-only">{step}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
