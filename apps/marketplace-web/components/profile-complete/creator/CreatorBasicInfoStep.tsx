"use client";

import { useState } from "react";
import { Input, Textarea } from "@/components/ui";
import { LinkIcon, MapPinIcon } from "@heroicons/react/24/outline";
import type { CreatorFormState } from "@/lib/types";

interface CreatorBasicInfoStepProps {
  form: CreatorFormState;
  onFormChange: (updates: Partial<CreatorFormState>) => void;
  error: string;
}

export function CreatorBasicInfoStep({ form, onFormChange, error }: CreatorBasicInfoStepProps) {
  const [showFallbackName] = useState(() => !form.name.trim());

  return (
    <div className="space-y-2">
      {showFallbackName && (
        <Input
          id="creator-name"
          aria-label="Name"
          label="Name"
          type="text"
          value={form.name}
          onChange={(e) => onFormChange({ name: e.target.value })}
          required
          placeholder="Your full name"
          error={error && error.includes("Name") ? error : undefined}
          className="rounded-xl border-gray-200 bg-white"
        />
      )}

      <Input
        id="creator-location"
        aria-label="Location"
        label="Location"
        type="text"
        value={form.location}
        onChange={(e) => onFormChange({ location: e.target.value })}
        required
        placeholder="e.g. Berlin, Germany"
        error={error && error.includes("Location") ? error : undefined}
        leadingIcon={<MapPinIcon className="h-5 w-5 text-gray-400" />}
        className="rounded-xl border-gray-200 bg-white"
      />

      <div className="space-y-1">
        <Textarea
          id="creator-bio"
          aria-label="Creator bio"
          label="Creator bio"
          value={form.short_description}
          onChange={(e) => onFormChange({ short_description: e.target.value })}
          required
          placeholder="Tell hotels about your content, audience, and point of view."
          rows={3}
          maxLength={500}
          error={error && error.includes("description") ? error : undefined}
          className="rounded-xl border-gray-200 bg-white"
        />
        <p
          className={`text-xs ${
            form.short_description.trim().length >= 10
              ? "text-emerald-600"
              : form.short_description.trim().length > 0
                ? "text-red-500"
                : "text-gray-500"
          }`}
        >
          {form.short_description.length}/500 characters
          {form.short_description.trim().length > 0 &&
            form.short_description.trim().length < 10 && <span> · minimum 10 characters</span>}
        </p>
      </div>

      <Input
        id="creator-portfolio"
        aria-label="Portfolio link"
        label="Portfolio link"
        type="url"
        value={form.portfolio_link}
        onChange={(e) => onFormChange({ portfolio_link: e.target.value })}
        placeholder="https://your-portfolio.com"
        helperText="Optional · website, media kit, or featured content"
        leadingIcon={<LinkIcon className="h-5 w-5 text-gray-400" />}
        className="rounded-xl border-gray-200 bg-white"
      />
    </div>
  );
}
