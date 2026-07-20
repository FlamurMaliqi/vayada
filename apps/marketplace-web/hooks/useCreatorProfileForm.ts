"use client";

import { useState, useCallback } from "react";
import { countries } from "countries-list";
import type { CreatorFormState, PlatformFormData } from "@/lib/types";
import { CREATOR_TYPE_OPTIONS } from "@/lib/constants/options";

const COUNTRIES = Object.values(countries)
  .map((country) => country.name)
  .sort();

interface UseCreatorProfileFormOptions {
  initialName?: string;
  onError?: (message: string) => void;
}

export function useCreatorProfileForm(options: UseCreatorProfileFormOptions = {}) {
  const { initialName = "", onError } = options;

  // Form state
  const [form, setForm] = useState<CreatorFormState>({
    name: initialName,
    location: "",
    short_description: "",
    portfolio_link: "",
    phone: "",
    creator_type: undefined,
  });

  // Platforms state
  const [platforms, setPlatforms] = useState<PlatformFormData[]>([]);
  const [platformCountryInputs, setPlatformCountryInputs] = useState<Record<number, string>>({});
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<number>>(new Set());
  const [collapsedPlatformCards, setCollapsedPlatformCards] = useState<Set<number>>(new Set());

  // Form change handler
  const handleFormChange = useCallback((updates: Partial<CreatorFormState>) => {
    setForm((prev) => ({ ...prev, ...updates }));
  }, []);

  // Platform handlers
  const addPlatform = useCallback((name: string) => {
    setPlatforms((prev) => [
      ...prev,
      {
        name,
        handle: "",
        followers: "",
        engagement_rate: "",
      },
    ]);
  }, []);

  const removePlatform = useCallback((index: number) => {
    setPlatforms((prev) => prev.filter((_, i) => i !== index));

    // Clean up collapsed cards
    setCollapsedPlatformCards((prev) => {
      const newCollapsed = new Set<number>();
      prev.forEach((collapsedIndex) => {
        if (collapsedIndex < index) {
          newCollapsed.add(collapsedIndex);
        } else if (collapsedIndex > index) {
          newCollapsed.add(collapsedIndex - 1);
        }
      });
      return newCollapsed;
    });

    // Clean up expanded platforms
    setExpandedPlatforms((prev) => {
      const newExpanded = new Set<number>();
      prev.forEach((expandedIndex) => {
        if (expandedIndex < index) {
          newExpanded.add(expandedIndex);
        } else if (expandedIndex > index) {
          newExpanded.add(expandedIndex - 1);
        }
      });
      return newExpanded;
    });

    // Clean up country inputs
    setPlatformCountryInputs((prev) => {
      const next = { ...prev };
      delete next[index];
      const shifted: Record<number, string> = {};
      Object.entries(next).forEach(([k, v]) => {
        const num = Number(k);
        shifted[num > index ? num - 1 : num] = v;
      });
      return shifted;
    });
  }, []);

  const updatePlatform = useCallback(
    (
      index: number,
      field: keyof PlatformFormData,
      value: PlatformFormData[keyof PlatformFormData],
    ) => {
      setPlatforms((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], [field]: value };
        return updated;
      });
    },
    [],
  );

  const togglePlatformExpanded = useCallback((index: number) => {
    setExpandedPlatforms((prev) => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(index)) {
        newExpanded.delete(index);
      } else {
        newExpanded.add(index);
      }
      return newExpanded;
    });
  }, []);

  // Country handlers
  const handleCountryInputChange = useCallback((platformIndex: number, value: string) => {
    setPlatformCountryInputs((prev) => ({ ...prev, [platformIndex]: value }));
  }, []);

  const addCountryFromInput = useCallback(
    (platformIndex: number, overrideValue?: string) => {
      const value = (overrideValue ?? platformCountryInputs[platformIndex])?.trim();
      if (!value) return;

      setPlatforms((prev) => {
        const updated = [...prev];
        if (!updated[platformIndex].top_countries) {
          updated[platformIndex].top_countries = [];
        }
        if (updated[platformIndex].top_countries!.length >= 3) return prev;
        const exists = updated[platformIndex].top_countries!.some(
          (c) => c.country.toLowerCase() === value.toLowerCase(),
        );
        if (exists) return prev;
        updated[platformIndex].top_countries!.push({ country: value, percentage: 0 });
        return updated;
      });

      setPlatformCountryInputs((prev) => ({ ...prev, [platformIndex]: "" }));
    },
    [platformCountryInputs],
  );

  const removeCountry = useCallback((platformIndex: number, countryIndex: number) => {
    setPlatforms((prev) => {
      const updated = [...prev];
      if (updated[platformIndex].top_countries) {
        updated[platformIndex].top_countries = updated[platformIndex].top_countries!.filter(
          (_, i) => i !== countryIndex,
        );
      }
      return updated;
    });
  }, []);

  const updateCountryPercentage = useCallback(
    (platformIndex: number, countryIndex: number, percentage: number) => {
      setPlatforms((prev) => {
        const updated = [...prev];
        if (updated[platformIndex].top_countries) {
          const safeValue = Math.max(0, Math.min(100, Number.isNaN(percentage) ? 0 : percentage));
          updated[platformIndex].top_countries![countryIndex] = {
            ...updated[platformIndex].top_countries![countryIndex],
            percentage: safeValue,
          };
        }
        return updated;
      });
    },
    [],
  );

  const getAvailableCountries = useCallback(
    (platformIndex: number) => {
      const selected = platforms[platformIndex]?.top_countries?.map((c) => c.country) || [];
      const query = (platformCountryInputs[platformIndex] || "").toLowerCase();
      if (!query.trim()) return [];
      return COUNTRIES.filter(
        (c) => !selected.includes(c) && c.toLowerCase().includes(query),
      ).slice(0, 8);
    },
    [platforms, platformCountryInputs],
  );

  // Age group handlers
  const toggleAgeGroup = useCallback((platformIndex: number, ageRange: string) => {
    setPlatforms((prev) => {
      const updated = [...prev];
      if (!updated[platformIndex].top_age_groups) {
        updated[platformIndex].top_age_groups = [];
      }
      const existingIndex = updated[platformIndex].top_age_groups!.findIndex(
        (a) => a.ageRange === ageRange,
      );
      if (existingIndex >= 0) {
        updated[platformIndex].top_age_groups = updated[platformIndex].top_age_groups!.filter(
          (_, i) => i !== existingIndex,
        );
      } else {
        if (updated[platformIndex].top_age_groups!.length >= 3) return prev;
        updated[platformIndex].top_age_groups!.push({ ageRange, percentage: 0 });
      }
      return updated;
    });
  }, []);

  // Gender split handler
  const updateGenderSplit = useCallback(
    (platformIndex: number, field: "male" | "female", value: string) => {
      setPlatforms((prev) => {
        const updated = [...prev];
        if (!updated[platformIndex].gender_split) {
          updated[platformIndex].gender_split = { male: 0, female: 0 };
        }
        if (value === "" || value === null || value === undefined) {
          updated[platformIndex].gender_split![field] = 0;
        } else {
          const numValue = parseFloat(value) || 0;
          const clampedValue = Math.max(0, Math.min(100, numValue));
          updated[platformIndex].gender_split![field] = clampedValue;
        }
        return updated;
      });
    },
    [],
  );

  // Validation
  const validateForm = useCallback((): boolean => {
    if (!form.creator_type || !CREATOR_TYPE_OPTIONS.includes(form.creator_type)) {
      onError?.("Please select your creator category");
      return false;
    }
    if (!form.name.trim()) {
      onError?.("Name is required");
      return false;
    }
    if (!form.location.trim()) {
      onError?.("Location is required");
      return false;
    }
    if (!form.short_description.trim()) {
      onError?.("Short description is required");
      return false;
    }
    if (form.short_description.trim().length < 10) {
      onError?.("Short description must be at least 10 characters");
      return false;
    }
    if (form.short_description.trim().length > 500) {
      onError?.("Short description must be at most 500 characters");
      return false;
    }
    if (platforms.length === 0) {
      onError?.("At least one platform is required");
      return false;
    }

    for (let i = 0; i < platforms.length; i++) {
      const platform = platforms[i];
      if (!platform.name) {
        onError?.(`Platform ${i + 1}: Platform name is required`);
        return false;
      }
      if (!platform.handle.trim()) {
        onError?.(
          `Platform ${i + 1}: ${platform.name === "Other" ? "Platform name" : "Handle"} is required`,
        );
        return false;
      }
      if (platform.name === "Other") {
        const profileUrl = platform.profile_url?.trim();
        if (!profileUrl) {
          onError?.(`Platform ${i + 1}: Profile link is required`);
          return false;
        }
        try {
          if (new URL(profileUrl).protocol !== "https:") throw new Error();
        } catch {
          onError?.(`Platform ${i + 1}: Profile link must be a valid HTTPS URL`);
          return false;
        }
      }
      if (platform.followers === "" || Number(platform.followers) <= 0) {
        onError?.(`Platform ${i + 1}: Followers must be greater than 0`);
        return false;
      }
      const engagementRate = Number(platform.engagement_rate);
      if (
        platform.engagement_rate === "" ||
        !Number.isFinite(engagementRate) ||
        engagementRate < 0
      ) {
        onError?.(`Platform ${i + 1}: Engagement rate must be a non-negative number`);
        return false;
      }
      if (platform.top_age_groups && platform.top_age_groups.length > 0) {
        const invalidAgeGroups = platform.top_age_groups.filter(
          (tag) => !tag.ageRange || !tag.ageRange.trim(),
        );
        if (invalidAgeGroups.length > 0) {
          onError?.(`Platform ${i + 1}: All age groups must have a valid age range selected`);
          return false;
        }
      }
    }

    return true;
  }, [form, platforms, onError]);

  // Can proceed to next step - Step 1: Creator Type
  const canProceedCreatorType = useCallback((): boolean => {
    return !!form.creator_type && CREATOR_TYPE_OPTIONS.includes(form.creator_type);
  }, [form.creator_type]);

  // Can proceed to next step - Step 2: Basic Info (was step 1)
  const canProceedStep1 = useCallback((): boolean => {
    return !!(
      form.name.trim() &&
      form.location.trim() &&
      form.short_description.trim() &&
      form.short_description.trim().length >= 10
    );
  }, [form]);

  return {
    // State
    form,
    platforms,
    platformCountryInputs,
    expandedPlatforms,
    collapsedPlatformCards,

    // Form handlers
    handleFormChange,

    // Platform handlers
    addPlatform,
    removePlatform,
    updatePlatform,
    togglePlatformExpanded,

    // Country handlers
    handleCountryInputChange,
    addCountryFromInput,
    removeCountry,
    updateCountryPercentage,
    getAvailableCountries,

    // Age/gender handlers
    toggleAgeGroup,
    updateGenderSplit,

    // Validation & progress
    validateForm,
    canProceedCreatorType,
    canProceedStep1,

    // State setters for external control
    setForm,
    setPlatforms,
  };
}
