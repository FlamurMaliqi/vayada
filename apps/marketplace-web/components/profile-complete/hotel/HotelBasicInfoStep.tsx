"use client";

import { Textarea, HotelBadgeIcon } from "@/components/ui";
import type { HotelFormState } from "@/lib/types";

interface HotelBasicInfoStepProps {
  form: HotelFormState;
  onFormChange: (updates: Partial<HotelFormState>) => void;
  error: string;
}

export function HotelBasicInfoStep({ form, onFormChange, error }: HotelBasicInfoStepProps) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 pb-1">
        <HotelBadgeIcon active={false} />
        <div>
          <h3 className="text-base font-semibold text-gray-950">
            Introduce your hotel to creators
          </h3>
          <p className="mt-1 text-sm leading-5 text-gray-500">
            Your shared hotel details are already saved. Add only the pitch creators should see.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <Textarea
          label="Creator-facing introduction"
          aria-label="Creator-facing introduction"
          value={form.about}
          onChange={(e) => onFormChange({ about: e.target.value })}
          placeholder="Tell creators what makes your hotel and collaboration opportunity special."
          rows={4}
          maxLength={5000}
          required
          helperText={`Minimum 50 characters · ${form.about.length}/5000`}
          className="min-h-36 resize-none rounded-xl border-gray-200 bg-gray-50 px-4 py-3 focus:bg-white focus:ring-primary-100"
          error={
            (error && error.includes("introduction") ? error : undefined) ||
            (form.about.trim().length > 0 && form.about.trim().length < 50
              ? `Introduction must be at least 50 characters (${form.about.length}/5000)`
              : undefined)
          }
        />
      </div>
    </div>
  );
}
