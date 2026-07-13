"use client";

import type { ProfileCompletionProgressProps } from "./types";

export function ProfileCompletionProgress({ percentage }: ProfileCompletionProgressProps) {
  return (
    <div className="border-b border-gray-100 bg-gray-50/70 px-4 py-2">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="block text-xs font-semibold uppercase tracking-wide text-primary-700">
            Profile setup
          </span>
          <span className="hidden text-xs text-gray-600 sm:block">
            Add the details needed to assess a collaboration.
          </span>
        </div>
        <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-gray-700 ring-1 ring-gray-200">
          {percentage}% complete
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Profile setup progress"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded-full bg-gray-100"
      >
        <div
          className="h-2 rounded-full bg-primary-600 transition-all duration-500 ease-out"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
