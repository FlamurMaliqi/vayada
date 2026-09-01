"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { Textarea } from "@/components/ui/Textarea";
import {
  ArrowLeftIcon,
  PlusIcon,
  TrashIcon,
  PhotoIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  XMarkIcon,
  GiftIcon,
  CurrencyDollarIcon,
  TagIcon,
  LinkIcon,
  CalendarIcon,
} from "@heroicons/react/24/outline";
import { usersService, uploadService } from "@/services/api";
import { ApiErrorResponse } from "@/services/api/client";
import { CURRENCY_OPTIONS } from "@/lib/constants/booking";

const AGE_GROUPS = ["18-24", "25-34", "35-44", "45-54", "55+"] as const;

const ACCOMMODATION_TYPES = [
  "Hotel",
  "Boutiques Hotel",
  "City Hotel",
  "Luxury Hotel",
  "Apartment",
  "Villa",
  "Lodge",
] as const;
const COLLABORATION_TYPES = ["Free Stay", "Paid", "Discount", "Affiliate"] as const;
const PLATFORMS = ["Instagram", "TikTok", "YouTube", "Facebook"] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// Common countries list
const COUNTRIES = [
  "Afghanistan",
  "Albania",
  "Algeria",
  "Argentina",
  "Australia",
  "Austria",
  "Bangladesh",
  "Belgium",
  "Brazil",
  "Bulgaria",
  "Canada",
  "Chile",
  "China",
  "Colombia",
  "Croatia",
  "Czech Republic",
  "Denmark",
  "Egypt",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "India",
  "Indonesia",
  "Iran",
  "Ireland",
  "Israel",
  "Italy",
  "Japan",
  "Kenya",
  "Malaysia",
  "Mexico",
  "Morocco",
  "Netherlands",
  "New Zealand",
  "Nigeria",
  "Norway",
  "Pakistan",
  "Philippines",
  "Poland",
  "Portugal",
  "Romania",
  "Russia",
  "Saudi Arabia",
  "Singapore",
  "South Africa",
  "South Korea",
  "Spain",
  "Sweden",
  "Switzerland",
  "Thailand",
  "Turkey",
  "Ukraine",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "Vietnam",
].sort();

interface PlatformForm {
  name: "Instagram" | "TikTok" | "YouTube" | "Facebook";
  handle: string;
  followers: string;
  engagementRate: string;
  // Optional fields
  topCountries: Array<{ country: string; percentage: string }>;
  topAgeGroups: Array<{ ageRange: string }>;
  genderSplit: { male: string; female: string };
  showAdvanced: boolean;
}

export default function CreateUserPage() {
  const router = useRouter();
  const [userType, setUserType] = useState<"creator" | "hotel">("creator");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Basic user fields
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    name: "",
    status: "pending" as "pending" | "verified" | "rejected" | "suspended",
    emailVerified: false,
  });

  // Creator profile fields
  const [creatorProfile, setCreatorProfile] = useState({
    location: "",
    shortDescription: "",
    portfolioLink: "",
    phone: "",
    profilePicture: "",
  });

  // Profile picture upload state
  const [profilePictureFile, setProfilePictureFile] = useState<File | null>(null);
  const [profilePicturePreview, setProfilePicturePreview] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");

  // Platforms for creator
  const [platforms, setPlatforms] = useState<PlatformForm[]>([]);
  const [countrySearch, setCountrySearch] = useState<{ [platformIndex: number]: string }>({});
  const [countryDropdownOpen, setCountryDropdownOpen] = useState<{
    [platformIndex: number]: boolean;
  }>({});
  const countryDropdownRefs = useRef<{ [platformIndex: number]: HTMLDivElement | null }>({});

  // Hotel profile fields
  const [hotelProfile, setHotelProfile] = useState({
    name: "",
    location: "",
    about: "",
    website: "",
    phone: "",
  });

  // Listings for hotel
  interface CollaborationOffering {
    collaborationType: "Free Stay" | "Paid" | "Discount" | "Affiliate";
    availabilityMonths: string[];
    platforms: string[];
    freeStayMinNights?: string;
    freeStayMaxNights?: string;
    paidMaxAmount?: string;
    currency?: string;
    discountPercentage?: string;
    commissionPercentage?: string;
  }

  interface CreatorRequirement {
    platforms: string[];
    targetCountries: string[];
    targetAgeGroups: string[];
  }

  interface ListingForm {
    name: string;
    location: string;
    description: string;
    accommodationType: string;
    images: string[];
    collaborationOfferings: CollaborationOffering[];
    creatorRequirements: CreatorRequirement;
  }

  const [listings, setListings] = useState<ListingForm[]>([]);
  const [listingImageFiles, setListingImageFiles] = useState<{ [listingIndex: number]: File[] }>(
    {},
  );
  const [targetCountrySearch, setTargetCountrySearch] = useState<{
    [listingIndex: number]: string;
  }>({});
  const [targetCountryDropdownOpen, setTargetCountryDropdownOpen] = useState<{
    [listingIndex: number]: boolean;
  }>({});
  const targetCountryDropdownRefs = useRef<{ [listingIndex: number]: HTMLDivElement | null }>({});

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      Object.keys(countryDropdownRefs.current).forEach((key) => {
        const ref = countryDropdownRefs.current[parseInt(key)];
        if (ref && !ref.contains(event.target as Node)) {
          setCountryDropdownOpen((prev) => ({ ...prev, [parseInt(key)]: false }));
        }
      });
      Object.keys(targetCountryDropdownRefs.current).forEach((key) => {
        const ref = targetCountryDropdownRefs.current[parseInt(key)];
        if (ref && !ref.contains(event.target as Node)) {
          setTargetCountryDropdownOpen((prev) => ({ ...prev, [parseInt(key)]: false }));
        }
      });
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleBasicChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    if (type === "checkbox") {
      setFormData((prev) => ({ ...prev, [name]: (e.target as HTMLInputElement).checked }));
    } else {
      setFormData((prev) => ({ ...prev, [name]: value }));
    }
  };

  const handleCreatorProfileChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setCreatorProfile((prev) => ({ ...prev, [name]: value }));
  };

  const handleHotelProfileChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setHotelProfile((prev) => ({ ...prev, [name]: value }));
  };

  const handleAddListing = () => {
    setListings((prev) => [
      ...prev,
      {
        name: "",
        location: "",
        description: "",
        accommodationType: "",
        images: [],
        collaborationOfferings: [],
        creatorRequirements: {
          platforms: [],
          targetCountries: [],
          targetAgeGroups: [],
        },
      },
    ]);
  };

  const handleRemoveListing = (index: number) => {
    setListings((prev) => prev.filter((_, i) => i !== index));
    setListingImageFiles((prev) => {
      const newFiles = { ...prev };
      delete newFiles[index];
      return newFiles;
    });
  };

  const handleListingImageChange = (listingIndex: number, files: FileList | null) => {
    if (!files) return;

    const fileArray = Array.from(files);
    const imageFiles = fileArray.filter((file) => file.type.startsWith("image/"));

    setListingImageFiles((prev) => ({
      ...prev,
      [listingIndex]: [...(prev[listingIndex] || []), ...imageFiles],
    }));
  };

  const handleRemoveListingImage = (listingIndex: number, imageIndex: number) => {
    setListingImageFiles((prev) => {
      const newFiles = { ...prev };
      if (newFiles[listingIndex]) {
        newFiles[listingIndex] = newFiles[listingIndex].filter((_, i) => i !== imageIndex);
      }
      return newFiles;
    });
  };

  const handleListingChange = (index: number, field: keyof ListingForm, value: any) => {
    setListings((prev) =>
      prev.map((listing, i) => (i === index ? { ...listing, [field]: value } : listing)),
    );
  };

  const handleAddCollaborationOffering = (listingIndex: number) => {
    setListings((prev) =>
      prev.map((listing, i) =>
        i === listingIndex
          ? {
              ...listing,
              collaborationOfferings: [
                ...listing.collaborationOfferings,
                {
                  collaborationType: "Free Stay",
                  availabilityMonths: [],
                  platforms: [],
                },
              ],
            }
          : listing,
      ),
    );
  };

  const handleRemoveCollaborationOffering = (listingIndex: number, offeringIndex: number) => {
    setListings((prev) =>
      prev.map((listing, i) =>
        i === listingIndex
          ? {
              ...listing,
              collaborationOfferings: listing.collaborationOfferings.filter(
                (_, oi) => oi !== offeringIndex,
              ),
            }
          : listing,
      ),
    );
  };

  const handleCollaborationOfferingChange = (
    listingIndex: number,
    offeringIndex: number,
    field: keyof CollaborationOffering,
    value: any,
  ) => {
    setListings((prev) =>
      prev.map((listing, i) =>
        i === listingIndex
          ? {
              ...listing,
              collaborationOfferings: listing.collaborationOfferings.map((offering, oi) =>
                oi === offeringIndex ? { ...offering, [field]: value } : offering,
              ),
            }
          : listing,
      ),
    );
  };

  const handleCreatorRequirementChange = (
    listingIndex: number,
    field: keyof CreatorRequirement,
    value: any,
  ) => {
    setListings((prev) =>
      prev.map((listing, i) =>
        i === listingIndex
          ? {
              ...listing,
              creatorRequirements: { ...listing.creatorRequirements, [field]: value },
            }
          : listing,
      ),
    );
  };

  const handleTargetCountrySearchChange = (listingIndex: number, value: string) => {
    setTargetCountrySearch((prev) => ({ ...prev, [listingIndex]: value }));
    setTargetCountryDropdownOpen((prev) => ({ ...prev, [listingIndex]: true }));
  };

  const handleSelectTargetCountry = (listingIndex: number, country: string) => {
    const listing = listings[listingIndex];
    // Check if country is already selected or if we've reached the limit
    if (
      listing.creatorRequirements.targetCountries.includes(country) ||
      listing.creatorRequirements.targetCountries.length >= 3
    ) {
      return;
    }

    setListings((prev) =>
      prev.map((listing, i) =>
        i === listingIndex
          ? {
              ...listing,
              creatorRequirements: {
                ...listing.creatorRequirements,
                targetCountries: [...listing.creatorRequirements.targetCountries, country],
              },
            }
          : listing,
      ),
    );

    // Clear search and close dropdown
    setTargetCountrySearch((prev) => ({ ...prev, [listingIndex]: "" }));
    setTargetCountryDropdownOpen((prev) => ({ ...prev, [listingIndex]: false }));
  };

  const handleRemoveTargetCountry = (listingIndex: number, country: string) => {
    setListings((prev) =>
      prev.map((listing, i) =>
        i === listingIndex
          ? {
              ...listing,
              creatorRequirements: {
                ...listing.creatorRequirements,
                targetCountries: listing.creatorRequirements.targetCountries.filter(
                  (c) => c !== country,
                ),
              },
            }
          : listing,
      ),
    );
  };

  const handleToggleTargetAgeGroup = (listingIndex: number, ageRange: string) => {
    setListings((prev) =>
      prev.map((listing, i) => {
        if (i !== listingIndex) return listing;

        const existingIndex = listing.creatorRequirements.targetAgeGroups.indexOf(ageRange);

        if (existingIndex >= 0) {
          // Remove if already selected
          return {
            ...listing,
            creatorRequirements: {
              ...listing.creatorRequirements,
              targetAgeGroups: listing.creatorRequirements.targetAgeGroups.filter(
                (_, ai) => ai !== existingIndex,
              ),
            },
          };
        } else {
          // Add if not selected and less than 3
          if (listing.creatorRequirements.targetAgeGroups.length < 3) {
            return {
              ...listing,
              creatorRequirements: {
                ...listing.creatorRequirements,
                targetAgeGroups: [...listing.creatorRequirements.targetAgeGroups, ageRange],
              },
            };
          }
          return listing;
        }
      }),
    );
  };

  const handleAddPlatform = () => {
    setPlatforms((prev) => [
      ...prev,
      {
        name: "Instagram",
        handle: "",
        followers: "",
        engagementRate: "",
        topCountries: [],
        topAgeGroups: [],
        genderSplit: { male: "", female: "" },
        showAdvanced: false,
      },
    ]);
  };

  const handleRemovePlatform = (index: number) => {
    setPlatforms((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePlatformChange = (
    index: number,
    field: keyof PlatformForm,
    value: string | boolean,
  ) => {
    setPlatforms((prev) =>
      prev.map((platform, i) => (i === index ? { ...platform, [field]: value } : platform)),
    );
  };

  const handleGenderSplitChange = (index: number, field: "male" | "female", value: string) => {
    setPlatforms((prev) =>
      prev.map((platform, i) =>
        i === index
          ? {
              ...platform,
              genderSplit: { ...platform.genderSplit, [field]: value },
            }
          : platform,
      ),
    );
  };

  const handleCountrySearchChange = (platformIndex: number, value: string) => {
    setCountrySearch((prev) => ({ ...prev, [platformIndex]: value }));
    setCountryDropdownOpen((prev) => ({ ...prev, [platformIndex]: true }));
  };

  const handleSelectCountry = (platformIndex: number, country: string) => {
    const platform = platforms[platformIndex];
    // Check if country is already selected or if we've reached the limit
    if (
      platform.topCountries.some((tc) => tc.country === country) ||
      platform.topCountries.length >= 3
    ) {
      return;
    }

    setPlatforms((prev) =>
      prev.map((platform, i) =>
        i === platformIndex
          ? { ...platform, topCountries: [...platform.topCountries, { country, percentage: "" }] }
          : platform,
      ),
    );

    // Clear search and close dropdown
    setCountrySearch((prev) => ({ ...prev, [platformIndex]: "" }));
    setCountryDropdownOpen((prev) => ({ ...prev, [platformIndex]: false }));
  };

  const handleRemoveTopCountry = (platformIndex: number, country: string) => {
    setPlatforms((prev) =>
      prev.map((platform, i) =>
        i === platformIndex
          ? {
              ...platform,
              topCountries: platform.topCountries.filter((tc) => tc.country !== country),
            }
          : platform,
      ),
    );
  };

  const handleTopCountryPercentageChange = (
    platformIndex: number,
    country: string,
    percentage: string,
  ) => {
    setPlatforms((prev) =>
      prev.map((platform, i) =>
        i === platformIndex
          ? {
              ...platform,
              topCountries: platform.topCountries.map((tc) =>
                tc.country === country ? { ...tc, percentage } : tc,
              ),
            }
          : platform,
      ),
    );
  };

  const handleToggleAgeGroup = (platformIndex: number, ageRange: string) => {
    setPlatforms((prev) =>
      prev.map((platform, i) => {
        if (i !== platformIndex) return platform;

        const existingIndex = platform.topAgeGroups.findIndex((ag) => ag.ageRange === ageRange);

        if (existingIndex >= 0) {
          // Remove if already selected
          return {
            ...platform,
            topAgeGroups: platform.topAgeGroups.filter((_, ai) => ai !== existingIndex),
          };
        } else {
          // Add if not selected and less than 3
          if (platform.topAgeGroups.length < 3) {
            return {
              ...platform,
              topAgeGroups: [...platform.topAgeGroups, { ageRange }],
            };
          }
          return platform;
        }
      }),
    );
  };

  const handleProfilePictureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      setUploadError("Please select an image file");
      return;
    }

    // Validate file size (max 20MB)
    if (file.size > 20 * 1024 * 1024) {
      setUploadError("Image size must be less than 20MB");
      return;
    }

    setUploadError("");
    setProfilePictureFile(file);

    // Create preview only (no upload yet - will upload after user creation)
    const reader = new FileReader();
    reader.onloadend = () => {
      setProfilePicturePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveProfilePicture = () => {
    setProfilePictureFile(null);
    setProfilePicturePreview(null);
    setUploadError("");
  };

  const validateForm = (): boolean => {
    if (!formData.email || !formData.password || !formData.name) {
      setError("Email, password, and name are required");
      return false;
    }

    if (formData.password.length < 8) {
      setError("Password must be at least 8 characters");
      return false;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setError("Please enter a valid email address");
      return false;
    }

    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      const requestData: any = {
        email: formData.email,
        password: formData.password,
        name: formData.name,
        type: userType,
        status: formData.status,
        emailVerified: formData.emailVerified,
      };

      if (userType === "creator") {
        requestData.creatorProfile = {
          ...(creatorProfile.location && { location: creatorProfile.location }),
          ...(creatorProfile.shortDescription && {
            shortDescription: creatorProfile.shortDescription,
          }),
          ...(creatorProfile.portfolioLink && { portfolioLink: creatorProfile.portfolioLink }),
          ...(creatorProfile.phone && { phone: creatorProfile.phone }),
          // Note: profilePicture is NOT included here - we'll add it in step 3
        };

        // Add platforms if any
        if (platforms.length > 0) {
          requestData.creatorProfile.platforms = platforms
            .filter((p) => p.handle && p.followers && p.engagementRate)
            .map((p) => {
              const platformData: any = {
                name: p.name,
                handle: p.handle,
                followers: parseInt(p.followers) || 0,
                engagementRate: parseFloat(p.engagementRate) || 0,
              };

              // Add optional fields if provided
              if (p.topCountries && p.topCountries.length > 0) {
                const validCountries = p.topCountries.filter((tc) => tc.country && tc.percentage);
                if (validCountries.length > 0) {
                  platformData.topCountries = validCountries.map((tc) => ({
                    country: tc.country,
                    percentage: parseFloat(tc.percentage) || 0,
                  }));
                }
              }

              if (p.topAgeGroups && p.topAgeGroups.length > 0) {
                const validAgeGroups = p.topAgeGroups.filter((ag) => ag.ageRange);
                if (validAgeGroups.length > 0) {
                  platformData.topAgeGroups = validAgeGroups.map((ag) => ({
                    ageRange: ag.ageRange,
                  }));
                }
              }

              if (p.genderSplit && (p.genderSplit.male || p.genderSplit.female)) {
                platformData.genderSplit = {
                  male: p.genderSplit.male ? parseFloat(p.genderSplit.male) : 0,
                  female: p.genderSplit.female ? parseFloat(p.genderSplit.female) : 0,
                };
              }

              return platformData;
            });
        }
      }

      if (userType === "hotel") {
        requestData.hotelProfile = {
          ...(hotelProfile.name && { name: hotelProfile.name }),
          ...(hotelProfile.location && { location: hotelProfile.location }),
          ...(hotelProfile.about && { about: hotelProfile.about }),
          ...(hotelProfile.website && { website: hotelProfile.website }),
          ...(hotelProfile.phone && { phone: hotelProfile.phone }),
        };
        // Note: NO listings here - they will be created separately in Step 3
      }

      // Step 1: Create user first (without profilePicture for creators, without listings for hotels)
      const createdUser = await usersService.createUser(requestData);

      // Step 2 & 3: Handle creator profile picture
      if (userType === "creator" && profilePictureFile) {
        try {
          // Step 2: Upload image using the creator's user_id
          const uploadResponse = await uploadService.uploadCreatorProfileImage(
            profilePictureFile,
            createdUser.id,
          );

          // Step 3: Update creator profile with the uploaded media object
          await usersService.updateCreatorProfile(createdUser.id, {
            profilePictureMediaObjectId: uploadResponse.mediaObjectId,
          });
        } catch (uploadError) {
          // If upload fails, still redirect but log the error
          console.error("Failed to upload profile picture:", uploadError);
          setError(
            "User created successfully, but profile picture upload failed. You can update it later.",
          );
        }
      }

      // Step 2 & 3: Handle collaboration offers (if any)
      if (userType === "hotel" && listings.length > 0) {
        const failedOfferNames: string[] = [];

        // Process each listing with its original index
        for (let listingIndex = 0; listingIndex < listings.length; listingIndex++) {
          const listing = listings[listingIndex];

          // Skip invalid listings
          if (
            !listing.name ||
            !listing.location ||
            !listing.description ||
            listing.description.length < 10
          ) {
            continue;
          }

          try {
            let imageUrls: string[] = [];

            // Step 2: Upload offer media if there are any files
            const imageFiles = listingImageFiles[listingIndex] || [];

            if (imageFiles.length > 0) {
              try {
                const uploadResponse = await uploadService.uploadListingImages(
                  imageFiles,
                  createdUser.id,
                );
                imageUrls = uploadResponse.images.map((img) => img.url);
              } catch (uploadError) {
                console.error("Failed to upload offer media:", uploadError);
                // Continue without images - user can add them later
              }
            }

            // Step 3: Create listing with uploaded image URLs
            const listingData: any = {
              name: listing.name,
              location: listing.location,
              description: listing.description,
              ...(listing.accommodationType && { accommodationType: listing.accommodationType }),
              ...(imageUrls.length > 0 && { images: imageUrls }),
              collaborationOfferings: listing.collaborationOfferings
                .filter((co) => co.platforms.length > 0 && co.availabilityMonths.length > 0)
                .map((co) => {
                  const offering: any = {
                    collaborationType: co.collaborationType,
                    availabilityMonths: co.availabilityMonths,
                    platforms: co.platforms,
                  };

                  if (co.collaborationType === "Free Stay") {
                    if (co.freeStayMinNights && co.freeStayMaxNights) {
                      offering.freeStayMinNights = parseInt(co.freeStayMinNights);
                      offering.freeStayMaxNights = parseInt(co.freeStayMaxNights);
                    }
                  } else if (co.collaborationType === "Paid") {
                    if (co.paidMaxAmount) {
                      offering.paidMaxAmount = parseFloat(co.paidMaxAmount);
                    }
                    offering.currency = co.currency || "USD";
                  } else if (co.collaborationType === "Discount") {
                    if (co.discountPercentage) {
                      offering.discountPercentage = parseInt(co.discountPercentage);
                    }
                  } else if (co.collaborationType === "Affiliate") {
                    if (co.commissionPercentage) {
                      offering.commissionPercentage = parseInt(co.commissionPercentage);
                    }
                  }

                  return offering;
                }),
              creatorRequirements: {
                platforms: listing.creatorRequirements.platforms,
                targetCountries: listing.creatorRequirements.targetCountries,
                ...(listing.creatorRequirements.targetAgeGroups.length > 0 &&
                  (() => {
                    // Convert age groups to min/max
                    const ageValues: number[] = [];
                    listing.creatorRequirements.targetAgeGroups.forEach((ageGroup) => {
                      if (ageGroup === "55+") {
                        ageValues.push(55);
                      } else {
                        const [min, max] = ageGroup.split("-").map(Number);
                        ageValues.push(min, max);
                      }
                    });
                    const minAge = Math.min(...ageValues);
                    const maxAge = ageValues.some((v) => v >= 55) ? 100 : Math.max(...ageValues);
                    return {
                      targetAgeMin: minAge,
                      targetAgeMax: maxAge,
                    };
                  })()),
              },
            };

            await usersService.createOffer(createdUser.id, listingData);
          } catch (listingError) {
            console.error("Failed to create offer:", listingError);
            failedOfferNames.push(listing.name);
          }
        }

        if (failedOfferNames.length > 0) {
          setLoading(false);
          setError(
            "User created, but these offers failed: " +
              failedOfferNames.join(", ") +
              ". Open the user from the dashboard to retry them.",
          );
          return;
        }
      }

      // Redirect to user detail page
      router.push(`/dashboard/users/${createdUser.id}`);
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiErrorResponse) {
        if (err.status === 400) {
          const detail = err.data.detail;
          if (Array.isArray(detail)) {
            const errorMessages = detail.map((d: any) => d.msg).join(", ");
            setError(errorMessages);
          } else {
            setError((detail as string) || "Validation error");
          }
        } else {
          setError((err.data.detail as string) || "Failed to create user");
        }
      } else {
        setError("Failed to create user. Please try again.");
      }
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center space-x-4">
            <Button variant="outline" size="sm" onClick={() => router.push("/dashboard")}>
              <ArrowLeftIcon className="w-4 h-4 mr-2" />
              Back to Dashboard
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Create New User</h1>
              <p className="text-sm text-gray-600">Add a new creator or hotel to the system</p>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white shadow rounded-lg overflow-hidden">
            {/* User Type Selection */}
            <div className="px-6 py-4 border-b border-gray-200">
              <label className="block text-sm font-medium text-gray-700 mb-3">User Type</label>
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setUserType("creator")}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    userType === "creator"
                      ? "bg-indigo-100 text-indigo-800 border-2 border-indigo-500"
                      : "bg-gray-100 text-gray-700 border-2 border-transparent hover:bg-gray-200"
                  }`}
                >
                  Creator
                </button>
                <button
                  type="button"
                  onClick={() => setUserType("hotel")}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    userType === "hotel"
                      ? "bg-blue-100 text-blue-800 border-2 border-blue-500"
                      : "bg-gray-100 text-gray-700 border-2 border-transparent hover:bg-gray-200"
                  }`}
                >
                  Hotel
                </button>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="px-6 py-6 space-y-6">
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              )}

              {/* Basic Information */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Input
                    label="Name"
                    name="name"
                    value={formData.name}
                    onChange={handleBasicChange}
                    required
                    placeholder="John Doe"
                  />
                  <Input
                    label="Email"
                    name="email"
                    type="email"
                    value={formData.email}
                    onChange={handleBasicChange}
                    required
                    placeholder="user@example.com"
                  />
                  <Input
                    label="Password"
                    name="password"
                    type="password"
                    value={formData.password}
                    onChange={handleBasicChange}
                    required
                    placeholder="Minimum 8 characters"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Password must be at least 8 characters
                  </p>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
                    <select
                      name="status"
                      value={formData.status}
                      onChange={handleBasicChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
                    >
                      <option value="pending">Pending</option>
                      <option value="verified">Verified</option>
                      <option value="rejected">Rejected</option>
                      <option value="suspended">Suspended</option>
                    </select>
                  </div>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="emailVerified"
                      name="emailVerified"
                      checked={formData.emailVerified}
                      onChange={handleBasicChange}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    />
                    <label htmlFor="emailVerified" className="ml-2 block text-sm text-gray-700">
                      Email Verified
                    </label>
                  </div>
                </div>
              </div>

              {/* Creator Profile Section */}
              {userType === "creator" && (
                <>
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Creator Profile</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <Input
                        label="Location"
                        name="location"
                        value={creatorProfile.location}
                        onChange={handleCreatorProfileChange}
                        placeholder="New York, USA"
                      />
                      <Input
                        label="Phone"
                        name="phone"
                        type="tel"
                        value={creatorProfile.phone}
                        onChange={handleCreatorProfileChange}
                        placeholder="+1-555-1234"
                      />
                      <div className="md:col-span-2">
                        <Textarea
                          label="Short Description"
                          name="shortDescription"
                          value={creatorProfile.shortDescription}
                          onChange={handleCreatorProfileChange}
                          rows={3}
                          placeholder="Brief description about the creator"
                        />
                      </div>
                      <Input
                        label="Portfolio Link"
                        name="portfolioLink"
                        type="url"
                        value={creatorProfile.portfolioLink}
                        onChange={handleCreatorProfileChange}
                        placeholder="https://portfolio.com"
                      />
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Profile Picture (Optional)
                        </label>
                        {profilePicturePreview ? (
                          <div className="mt-2">
                            <div className="relative inline-block">
                              <img
                                src={profilePicturePreview}
                                alt="Profile preview"
                                className="h-32 w-32 object-cover rounded-lg border border-gray-300"
                              />
                              <button
                                type="button"
                                onClick={handleRemoveProfilePicture}
                                className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                              >
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-2">
                            <label
                              htmlFor="profilePicture"
                              className="flex flex-col items-center justify-center w-full h-32 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100 transition-colors"
                            >
                              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                <PhotoIcon className="w-10 h-10 mb-2 text-gray-400" />
                                <p className="mb-2 text-sm text-gray-500">
                                  <span className="font-semibold">Click to upload</span> or drag and
                                  drop
                                </p>
                                <p className="text-xs text-gray-500">PNG, JPG, GIF up to 20MB</p>
                              </div>
                              <input
                                id="profilePicture"
                                type="file"
                                className="hidden"
                                accept="image/*"
                                onChange={handleProfilePictureChange}
                              />
                            </label>
                            {uploadError && (
                              <p className="mt-2 text-sm text-red-600">{uploadError}</p>
                            )}
                            {profilePictureFile && (
                              <p className="mt-2 text-xs text-gray-500">
                                Image will be uploaded after user creation
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Social Media Platforms */}
                  <div className="border-t pt-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-semibold text-gray-900">
                        Social Media Platforms
                      </h3>
                      <Button type="button" variant="outline" size="sm" onClick={handleAddPlatform}>
                        <PlusIcon className="w-4 h-4 mr-1" />
                        Add Platform
                      </Button>
                    </div>

                    {platforms.length === 0 ? (
                      <p className="text-sm text-gray-500">
                        No platforms added. Click "Add Platform" to add one.
                      </p>
                    ) : (
                      <div className="space-y-4">
                        {platforms.map((platform, index) => (
                          <div key={index} className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex items-center justify-between mb-4">
                              <h4 className="font-medium text-gray-900">Platform {index + 1}</h4>
                              <button
                                type="button"
                                onClick={() => handleRemovePlatform(index)}
                                className="text-red-600 hover:text-red-800"
                              >
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  Platform
                                </label>
                                <select
                                  value={platform.name}
                                  onChange={(e) =>
                                    handlePlatformChange(index, "name", e.target.value)
                                  }
                                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
                                >
                                  <option value="Instagram">Instagram</option>
                                  <option value="TikTok">TikTok</option>
                                  <option value="YouTube">YouTube</option>
                                  <option value="Facebook">Facebook</option>
                                </select>
                              </div>
                              <Input
                                label="Handle"
                                value={platform.handle}
                                onChange={(e) =>
                                  handlePlatformChange(index, "handle", e.target.value)
                                }
                                placeholder="@username"
                                required
                              />
                              <Input
                                label="Followers"
                                type="number"
                                value={platform.followers}
                                onChange={(e) =>
                                  handlePlatformChange(index, "followers", e.target.value)
                                }
                                placeholder="100000"
                                required
                              />
                              <Input
                                label="Engagement Rate (%)"
                                type="number"
                                step="0.1"
                                value={platform.engagementRate}
                                onChange={(e) =>
                                  handlePlatformChange(index, "engagementRate", e.target.value)
                                }
                                placeholder="4.5"
                                required
                              />
                            </div>

                            {/* Advanced Options Toggle */}
                            <div className="mt-4 pt-4 border-t">
                              <button
                                type="button"
                                onClick={() =>
                                  handlePlatformChange(
                                    index,
                                    "showAdvanced",
                                    !platform.showAdvanced,
                                  )
                                }
                                className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
                              >
                                {platform.showAdvanced ? (
                                  <>
                                    <ChevronUpIcon className="w-4 h-4" />
                                    Hide Advanced Options
                                  </>
                                ) : (
                                  <>
                                    <ChevronDownIcon className="w-4 h-4" />
                                    Show Advanced Options
                                  </>
                                )}
                              </button>
                            </div>

                            {/* Advanced Options */}
                            {platform.showAdvanced && (
                              <div className="mt-4 space-y-6 pt-4 border-t">
                                {/* Top Countries */}
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Top Countries
                                  </label>
                                  <p className="text-sm text-gray-500 mb-3">
                                    Select up to 3 countries with their audience percentage
                                  </p>

                                  {/* Country Search Input */}
                                  <div
                                    ref={(el) => {
                                      countryDropdownRefs.current[index] = el;
                                    }}
                                    className="relative mb-4"
                                  >
                                    <input
                                      type="text"
                                      value={countrySearch[index] || ""}
                                      onChange={(e) =>
                                        handleCountrySearchChange(index, e.target.value)
                                      }
                                      onFocus={() =>
                                        setCountryDropdownOpen((prev) => ({
                                          ...prev,
                                          [index]: true,
                                        }))
                                      }
                                      placeholder="Search countries..."
                                      disabled={platform.topCountries.length >= 3}
                                      className="w-full px-4 py-3 border border-gray-300 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 placeholder-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
                                    />

                                    {/* Dropdown with filtered countries */}
                                    {countryDropdownOpen[index] &&
                                      (countrySearch[index] || "").length > 0 && (
                                        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                                          {COUNTRIES.filter(
                                            (country) =>
                                              country
                                                .toLowerCase()
                                                .includes(
                                                  (countrySearch[index] || "").toLowerCase(),
                                                ) &&
                                              !platform.topCountries.some(
                                                (tc) => tc.country === country,
                                              ),
                                          )
                                            .slice(0, 10)
                                            .map((country) => (
                                              <button
                                                key={country}
                                                type="button"
                                                onClick={() => handleSelectCountry(index, country)}
                                                className="w-full px-4 py-2 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none text-gray-900"
                                              >
                                                {country}
                                              </button>
                                            ))}
                                          {COUNTRIES.filter(
                                            (country) =>
                                              country
                                                .toLowerCase()
                                                .includes(
                                                  (countrySearch[index] || "").toLowerCase(),
                                                ) &&
                                              !platform.topCountries.some(
                                                (tc) => tc.country === country,
                                              ),
                                          ).length === 0 && (
                                            <div className="px-4 py-2 text-sm text-gray-500">
                                              No countries found
                                            </div>
                                          )}
                                        </div>
                                      )}
                                  </div>

                                  {/* Selected Countries */}
                                  {platform.topCountries.length > 0 && (
                                    <div className="space-y-3">
                                      {platform.topCountries.map((countryData) => (
                                        <div
                                          key={countryData.country}
                                          className="bg-blue-50 border border-blue-200 rounded-lg p-4"
                                        >
                                          <div className="flex items-center justify-between">
                                            <div className="flex-1">
                                              <div className="font-medium text-gray-900 mb-2">
                                                {countryData.country}
                                              </div>
                                              <div className="flex items-center gap-2">
                                                <label className="text-sm text-gray-600">
                                                  Audience percentage
                                                </label>
                                                <div className="flex items-center gap-1">
                                                  <input
                                                    type="number"
                                                    step="0.1"
                                                    value={countryData.percentage}
                                                    onChange={(e) =>
                                                      handleTopCountryPercentageChange(
                                                        index,
                                                        countryData.country,
                                                        e.target.value,
                                                      )
                                                    }
                                                    placeholder="0"
                                                    className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                                                  />
                                                  <span className="text-sm text-gray-600">%</span>
                                                </div>
                                              </div>
                                            </div>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                handleRemoveTopCountry(index, countryData.country)
                                              }
                                              className="ml-4 text-gray-400 hover:text-red-600 transition-colors"
                                            >
                                              <XMarkIcon className="w-5 h-5" />
                                            </button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>

                                {/* Top Age Groups */}
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Age Groups
                                  </label>
                                  <p className="text-sm text-gray-500 mb-3">
                                    Select up to 3 age groups with their audience percentage
                                  </p>

                                  {/* Age Group Selection Buttons */}
                                  <div className="flex flex-wrap gap-2 mb-4">
                                    {AGE_GROUPS.map((ageRange) => {
                                      const isSelected = platform.topAgeGroups.some(
                                        (ag) => ag.ageRange === ageRange,
                                      );
                                      const isDisabled =
                                        !isSelected && platform.topAgeGroups.length >= 3;

                                      return (
                                        <button
                                          key={ageRange}
                                          type="button"
                                          onClick={() => handleToggleAgeGroup(index, ageRange)}
                                          disabled={isDisabled}
                                          className={`
                                            px-4 py-2 rounded-full text-sm font-medium transition-colors
                                            ${
                                              isSelected
                                                ? "bg-blue-100 text-blue-700 border-2 border-blue-300"
                                                : "bg-white text-gray-700 border-2 border-gray-300 hover:border-gray-400"
                                            }
                                            ${isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
                                          `}
                                        >
                                          {ageRange}
                                        </button>
                                      );
                                    })}
                                  </div>

                                  {/* Selected Age Groups Display */}
                                  {platform.topAgeGroups.length > 0 && (
                                    <div className="mt-3">
                                      <p className="text-sm text-gray-600 mb-2">
                                        Selected age groups:
                                      </p>
                                      <div className="flex flex-wrap gap-2">
                                        {platform.topAgeGroups.map((ageGroup) => (
                                          <div
                                            key={ageGroup.ageRange}
                                            className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-100 text-blue-700 rounded-full text-sm font-medium"
                                          >
                                            <span>{ageGroup.ageRange}</span>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                handleToggleAgeGroup(index, ageGroup.ageRange)
                                              }
                                              className="text-blue-700 hover:text-red-600 transition-colors"
                                            >
                                              <XMarkIcon className="w-4 h-4" />
                                            </button>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {/* Gender Split */}
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-3">
                                    Gender Split (%)
                                  </label>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <Input
                                      label="Male"
                                      type="number"
                                      step="0.1"
                                      value={platform.genderSplit.male}
                                      onChange={(e) =>
                                        handleGenderSplitChange(index, "male", e.target.value)
                                      }
                                      placeholder="55.0"
                                    />
                                    <Input
                                      label="Female"
                                      type="number"
                                      step="0.1"
                                      value={platform.genderSplit.female}
                                      onChange={(e) =>
                                        handleGenderSplitChange(index, "female", e.target.value)
                                      }
                                      placeholder="40.0"
                                    />
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Hotel Profile Section */}
              {userType === "hotel" && (
                <>
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Hotel Profile</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <Input
                        label="Hotel Name"
                        name="name"
                        value={hotelProfile.name}
                        onChange={handleHotelProfileChange}
                        placeholder="Grand Hotel"
                      />
                      <Input
                        label="Location"
                        name="location"
                        value={hotelProfile.location}
                        onChange={handleHotelProfileChange}
                        placeholder="Paris, France"
                      />
                      <Input
                        label="Phone"
                        name="phone"
                        value={hotelProfile.phone}
                        onChange={handleHotelProfileChange}
                        placeholder="+33-1-23-45-67-89"
                      />
                      <Input
                        label="Website"
                        name="website"
                        type="url"
                        value={hotelProfile.website}
                        onChange={handleHotelProfileChange}
                        placeholder="https://hotel.com"
                      />
                      <div className="md:col-span-2">
                        <Textarea
                          label="About"
                          name="about"
                          value={hotelProfile.about}
                          onChange={handleHotelProfileChange}
                          rows={4}
                          placeholder="Description of the hotel"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Offers Section */}
                  <div className="border-t pt-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-semibold text-gray-900">Offers (Optional)</h3>
                      <Button type="button" variant="outline" size="sm" onClick={handleAddListing}>
                        <PlusIcon className="w-4 h-4 mr-1" />
                        Add Offer
                      </Button>
                    </div>

                    {listings.length === 0 ? (
                      <p className="text-sm text-gray-500">
                        No offers added. Click "Add Offer" to add one.
                      </p>
                    ) : (
                      <div className="space-y-6">
                        {listings.map((listing, listingIndex) => (
                          <div key={listingIndex} className="border rounded-lg p-6 bg-gray-50">
                            <div className="flex items-center justify-between mb-4">
                              <h4 className="font-medium text-gray-900">
                                Offer {listingIndex + 1}
                              </h4>
                              <button
                                type="button"
                                onClick={() => handleRemoveListing(listingIndex)}
                                className="text-red-600 hover:text-red-800"
                              >
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </div>

                            {/* Basic Offer Info */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                              <Input
                                label="Offer title"
                                value={listing.name}
                                onChange={(e) =>
                                  handleListingChange(listingIndex, "name", e.target.value)
                                }
                                placeholder="Beachfront Villa"
                                required
                              />
                              <Input
                                label="Location"
                                value={listing.location}
                                onChange={(e) =>
                                  handleListingChange(listingIndex, "location", e.target.value)
                                }
                                placeholder="Maldives"
                                required
                              />
                              <div className="md:col-span-2">
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  Accommodation Type
                                </label>
                                <select
                                  value={listing.accommodationType}
                                  onChange={(e) =>
                                    handleListingChange(
                                      listingIndex,
                                      "accommodationType",
                                      e.target.value,
                                    )
                                  }
                                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
                                >
                                  <option value="">Select type</option>
                                  {ACCOMMODATION_TYPES.map((type) => (
                                    <option key={type} value={type}>
                                      {type}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="md:col-span-2">
                                <Textarea
                                  label="Description"
                                  value={listing.description}
                                  onChange={(e) =>
                                    handleListingChange(listingIndex, "description", e.target.value)
                                  }
                                  rows={3}
                                  placeholder="Describe the collaboration offer (min 10 characters)"
                                  required
                                />
                              </div>
                              <div className="md:col-span-2">
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  Property Photos
                                </label>
                                <p className="text-sm text-gray-500 mb-3">
                                  Upload images of the property (you can select multiple)
                                </p>

                                {/* File Upload */}
                                <div className="mb-4">
                                  <label
                                    htmlFor={`listing-images-${listingIndex}`}
                                    className="flex flex-col items-center justify-center w-full h-32 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100 transition-colors"
                                  >
                                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                      <PhotoIcon className="w-10 h-10 mb-2 text-gray-400" />
                                      <p className="mb-2 text-sm text-gray-500">
                                        <span className="font-semibold">Click to upload</span> or
                                        drag and drop
                                      </p>
                                      <p className="text-xs text-gray-500">
                                        PNG, JPG, GIF up to 20MB each
                                      </p>
                                    </div>
                                    <input
                                      id={`listing-images-${listingIndex}`}
                                      type="file"
                                      className="hidden"
                                      multiple
                                      accept="image/*"
                                      onChange={(e) =>
                                        handleListingImageChange(listingIndex, e.target.files)
                                      }
                                    />
                                  </label>
                                </div>

                                {/* Image Previews */}
                                {listingImageFiles[listingIndex]?.length > 0 && (
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                    {/* Preview uploaded files */}
                                    {listingImageFiles[listingIndex]?.map((file, imageIndex) => {
                                      const previewUrl = URL.createObjectURL(file);
                                      return (
                                        <div key={imageIndex} className="relative group">
                                          <img
                                            src={previewUrl}
                                            alt={`Preview ${imageIndex + 1}`}
                                            className="w-full h-32 object-cover rounded-lg border border-gray-300"
                                          />
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleRemoveListingImage(listingIndex, imageIndex)
                                            }
                                            className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                                          >
                                            <XMarkIcon className="w-4 h-4" />
                                          </button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Collaboration Offerings */}
                            <div className="border-t pt-4 mb-4">
                              <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-2">
                                  <div className="w-1 h-6 bg-blue-500 rounded"></div>
                                  <h3 className="text-lg font-semibold text-gray-900">Offerings</h3>
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleAddCollaborationOffering(listingIndex)}
                                >
                                  <PlusIcon className="w-4 h-4 mr-1" />
                                  Add Offering
                                </Button>
                              </div>
                              {listing.collaborationOfferings.length === 0 ? (
                                <p className="text-sm text-gray-500">
                                  No collaboration offerings added
                                </p>
                              ) : (
                                <div className="space-y-4">
                                  {listing.collaborationOfferings.map((offering, offeringIndex) => (
                                    <div
                                      key={offeringIndex}
                                      className="border rounded-lg p-4 bg-white"
                                    >
                                      <div className="flex items-center justify-between mb-3">
                                        <h5 className="font-medium text-gray-900">
                                          Offering {offeringIndex + 1}
                                        </h5>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleRemoveCollaborationOffering(
                                              listingIndex,
                                              offeringIndex,
                                            )
                                          }
                                          className="text-red-600 hover:text-red-800"
                                        >
                                          <TrashIcon className="w-4 h-4" />
                                        </button>
                                      </div>
                                      <div className="space-y-6 mt-4">
                                        {/* Collaboration Types */}
                                        <div>
                                          <label className="block text-sm font-medium text-gray-700 mb-3">
                                            Collaboration Types{" "}
                                            <span className="text-red-500">*</span>
                                          </label>
                                          <div className="flex gap-4">
                                            {COLLABORATION_TYPES.map((type) => {
                                              const isSelected =
                                                offering.collaborationType === type;
                                              const getIcon = () => {
                                                if (type === "Free Stay")
                                                  return <GiftIcon className="w-8 h-8" />;
                                                if (type === "Paid")
                                                  return <CurrencyDollarIcon className="w-8 h-8" />;
                                                if (type === "Discount")
                                                  return <TagIcon className="w-8 h-8" />;
                                                if (type === "Affiliate")
                                                  return <LinkIcon className="w-8 h-8" />;
                                              };

                                              return (
                                                <button
                                                  key={type}
                                                  type="button"
                                                  onClick={() =>
                                                    handleCollaborationOfferingChange(
                                                      listingIndex,
                                                      offeringIndex,
                                                      "collaborationType",
                                                      type,
                                                    )
                                                  }
                                                  className={`
                                                    flex flex-col items-center justify-center p-6 border-2 rounded-lg transition-all
                                                    ${
                                                      isSelected
                                                        ? "border-blue-500 bg-blue-50"
                                                        : "border-gray-300 bg-white hover:border-gray-400"
                                                    }
                                                  `}
                                                >
                                                  <div
                                                    className={`mb-2 ${isSelected ? "text-blue-600" : "text-gray-400"}`}
                                                  >
                                                    {getIcon()}
                                                  </div>
                                                  <span
                                                    className={`text-sm font-medium ${isSelected ? "text-blue-700" : "text-gray-700"}`}
                                                  >
                                                    {type}
                                                  </span>
                                                </button>
                                              );
                                            })}
                                          </div>
                                        </div>
                                        {/* Type-specific fields */}
                                        {offering.collaborationType === "Free Stay" && (
                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <Input
                                              label="Min Nights"
                                              type="number"
                                              value={offering.freeStayMinNights || ""}
                                              onChange={(e) =>
                                                handleCollaborationOfferingChange(
                                                  listingIndex,
                                                  offeringIndex,
                                                  "freeStayMinNights",
                                                  e.target.value,
                                                )
                                              }
                                              placeholder="2"
                                              required
                                            />
                                            <Input
                                              label="Max Nights"
                                              type="number"
                                              value={offering.freeStayMaxNights || ""}
                                              onChange={(e) =>
                                                handleCollaborationOfferingChange(
                                                  listingIndex,
                                                  offeringIndex,
                                                  "freeStayMaxNights",
                                                  e.target.value,
                                                )
                                              }
                                              placeholder="5"
                                              required
                                            />
                                          </div>
                                        )}
                                        {offering.collaborationType === "Paid" && (
                                          <div className="flex gap-2">
                                            <div className="w-28">
                                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                                Currency
                                              </label>
                                              <select
                                                value={offering.currency || "USD"}
                                                onChange={(e) =>
                                                  handleCollaborationOfferingChange(
                                                    listingIndex,
                                                    offeringIndex,
                                                    "currency",
                                                    e.target.value,
                                                  )
                                                }
                                                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                              >
                                                {CURRENCY_OPTIONS.map((c) => (
                                                  <option key={c.code} value={c.code}>
                                                    {c.code}
                                                  </option>
                                                ))}
                                              </select>
                                            </div>
                                            <div className="flex-1">
                                              <Input
                                                label="Max Amount"
                                                type="number"
                                                value={offering.paidMaxAmount || ""}
                                                onChange={(e) =>
                                                  handleCollaborationOfferingChange(
                                                    listingIndex,
                                                    offeringIndex,
                                                    "paidMaxAmount",
                                                    e.target.value,
                                                  )
                                                }
                                                placeholder="1000"
                                                required
                                              />
                                            </div>
                                          </div>
                                        )}
                                        {offering.collaborationType === "Discount" && (
                                          <div>
                                            <Input
                                              label="Discount Percentage"
                                              type="number"
                                              min="1"
                                              max="100"
                                              value={offering.discountPercentage || ""}
                                              onChange={(e) =>
                                                handleCollaborationOfferingChange(
                                                  listingIndex,
                                                  offeringIndex,
                                                  "discountPercentage",
                                                  e.target.value,
                                                )
                                              }
                                              placeholder="30"
                                              required
                                            />
                                          </div>
                                        )}
                                        {offering.collaborationType === "Affiliate" && (
                                          <div>
                                            <Input
                                              label="Commission Percentage"
                                              type="number"
                                              min="1"
                                              max="100"
                                              value={offering.commissionPercentage || ""}
                                              onChange={(e) =>
                                                handleCollaborationOfferingChange(
                                                  listingIndex,
                                                  offeringIndex,
                                                  "commissionPercentage",
                                                  e.target.value,
                                                )
                                              }
                                              placeholder="10"
                                              required
                                            />
                                          </div>
                                        )}
                                        {/* Property Posting Platforms */}
                                        <div>
                                          <label className="block text-sm font-medium text-gray-700 mb-2">
                                            Property posting platforms
                                          </label>
                                          <p className="text-sm text-gray-600 mb-3">
                                            On which platforms is your property active?
                                          </p>
                                          <div className="flex gap-4">
                                            {PLATFORMS.map((platform) => {
                                              const isSelected =
                                                offering.platforms.includes(platform);
                                              return (
                                                <label
                                                  key={platform}
                                                  className="flex items-center cursor-pointer"
                                                >
                                                  <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={(e) => {
                                                      const newPlatforms = e.target.checked
                                                        ? [...offering.platforms, platform]
                                                        : offering.platforms.filter(
                                                            (p) => p !== platform,
                                                          );
                                                      handleCollaborationOfferingChange(
                                                        listingIndex,
                                                        offeringIndex,
                                                        "platforms",
                                                        newPlatforms,
                                                      );
                                                    }}
                                                    className="mr-2 w-4 h-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                                                  />
                                                  <span className="text-sm text-gray-700">
                                                    {platform}
                                                  </span>
                                                </label>
                                              );
                                            })}
                                          </div>
                                        </div>
                                        {/* Availability */}
                                        <div>
                                          <label className="block text-sm font-medium text-gray-700 mb-3">
                                            <CalendarIcon className="w-4 h-4 inline mr-1" />
                                            Availability <span className="text-red-500">*</span>
                                          </label>
                                          <div className="grid grid-cols-6 gap-2">
                                            {MONTHS.map((month, idx) => {
                                              const isSelected =
                                                offering.availabilityMonths.includes(month);
                                              return (
                                                <button
                                                  key={month}
                                                  type="button"
                                                  onClick={() => {
                                                    const newMonths = isSelected
                                                      ? offering.availabilityMonths.filter(
                                                          (m) => m !== month,
                                                        )
                                                      : [...offering.availabilityMonths, month];
                                                    handleCollaborationOfferingChange(
                                                      listingIndex,
                                                      offeringIndex,
                                                      "availabilityMonths",
                                                      newMonths,
                                                    );
                                                  }}
                                                  className={`
                                                    px-3 py-2 text-sm font-medium rounded-lg border-2 transition-all
                                                    ${
                                                      isSelected
                                                        ? "bg-blue-100 text-blue-700 border-blue-300"
                                                        : "bg-gray-50 text-gray-700 border-gray-300 hover:border-gray-400"
                                                    }
                                                  `}
                                                >
                                                  {MONTHS_SHORT[idx]}
                                                </button>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Creator Requirements */}
                            <div className="border-t pt-4">
                              <label className="block text-sm font-medium text-gray-700 mb-3">
                                Creator Requirements
                              </label>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="md:col-span-2">
                                  <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Required Platforms
                                  </label>
                                  <div className="flex flex-wrap gap-2">
                                    {PLATFORMS.map((platform) => (
                                      <label key={platform} className="flex items-center">
                                        <input
                                          type="checkbox"
                                          checked={listing.creatorRequirements.platforms.includes(
                                            platform,
                                          )}
                                          onChange={(e) => {
                                            const newPlatforms = e.target.checked
                                              ? [...listing.creatorRequirements.platforms, platform]
                                              : listing.creatorRequirements.platforms.filter(
                                                  (p) => p !== platform,
                                                );
                                            handleCreatorRequirementChange(
                                              listingIndex,
                                              "platforms",
                                              newPlatforms,
                                            );
                                          }}
                                          className="mr-2"
                                        />
                                        <span className="text-sm text-gray-700">{platform}</span>
                                      </label>
                                    ))}
                                  </div>
                                </div>
                                <div className="md:col-span-2">
                                  <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Target Countries
                                  </label>
                                  <p className="text-sm text-gray-500 mb-3">
                                    Select up to 3 countries your target audience is from
                                  </p>

                                  {/* Target Country Search Input */}
                                  <div
                                    ref={(el) => {
                                      targetCountryDropdownRefs.current[listingIndex] = el;
                                    }}
                                    className="relative mb-4"
                                  >
                                    <input
                                      type="text"
                                      value={targetCountrySearch[listingIndex] || ""}
                                      onChange={(e) =>
                                        handleTargetCountrySearchChange(
                                          listingIndex,
                                          e.target.value,
                                        )
                                      }
                                      onFocus={() =>
                                        setTargetCountryDropdownOpen((prev) => ({
                                          ...prev,
                                          [listingIndex]: true,
                                        }))
                                      }
                                      placeholder="Search countries..."
                                      disabled={
                                        listing.creatorRequirements.targetCountries.length >= 3
                                      }
                                      className="w-full px-4 py-3 border border-gray-300 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 placeholder-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
                                    />

                                    {/* Dropdown with filtered countries */}
                                    {targetCountryDropdownOpen[listingIndex] &&
                                      (targetCountrySearch[listingIndex] || "").length > 0 && (
                                        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                                          {COUNTRIES.filter(
                                            (country) =>
                                              country
                                                .toLowerCase()
                                                .includes(
                                                  (
                                                    targetCountrySearch[listingIndex] || ""
                                                  ).toLowerCase(),
                                                ) &&
                                              !listing.creatorRequirements.targetCountries.includes(
                                                country,
                                              ),
                                          )
                                            .slice(0, 10)
                                            .map((country) => (
                                              <button
                                                key={country}
                                                type="button"
                                                onClick={() =>
                                                  handleSelectTargetCountry(listingIndex, country)
                                                }
                                                className="w-full px-4 py-2 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none text-gray-900"
                                              >
                                                {country}
                                              </button>
                                            ))}
                                          {COUNTRIES.filter(
                                            (country) =>
                                              country
                                                .toLowerCase()
                                                .includes(
                                                  (
                                                    targetCountrySearch[listingIndex] || ""
                                                  ).toLowerCase(),
                                                ) &&
                                              !listing.creatorRequirements.targetCountries.includes(
                                                country,
                                              ),
                                          ).length === 0 && (
                                            <div className="px-4 py-2 text-sm text-gray-500">
                                              No countries found
                                            </div>
                                          )}
                                        </div>
                                      )}
                                  </div>

                                  {/* Selected Target Countries */}
                                  {listing.creatorRequirements.targetCountries.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                      {listing.creatorRequirements.targetCountries.map(
                                        (country) => (
                                          <div
                                            key={country}
                                            className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-100 text-blue-700 rounded-full text-sm font-medium"
                                          >
                                            <span>{country}</span>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                handleRemoveTargetCountry(listingIndex, country)
                                              }
                                              className="text-blue-700 hover:text-red-600 transition-colors"
                                            >
                                              <XMarkIcon className="w-4 h-4" />
                                            </button>
                                          </div>
                                        ),
                                      )}
                                    </div>
                                  )}
                                </div>
                                <div className="md:col-span-2">
                                  <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Age Groups
                                  </label>
                                  <p className="text-sm text-gray-500 mb-3">
                                    Select up to 3 age groups you want to target
                                  </p>

                                  {/* Age Group Selection Buttons */}
                                  <div className="flex flex-wrap gap-2 mb-4">
                                    {AGE_GROUPS.map((ageRange) => {
                                      const isSelected =
                                        listing.creatorRequirements.targetAgeGroups.includes(
                                          ageRange,
                                        );
                                      const isDisabled =
                                        !isSelected &&
                                        listing.creatorRequirements.targetAgeGroups.length >= 3;

                                      return (
                                        <button
                                          key={ageRange}
                                          type="button"
                                          onClick={() =>
                                            handleToggleTargetAgeGroup(listingIndex, ageRange)
                                          }
                                          disabled={isDisabled}
                                          className={`
                                            px-4 py-2 rounded-full text-sm font-medium transition-colors
                                            ${
                                              isSelected
                                                ? "bg-blue-100 text-blue-700 border-2 border-blue-300"
                                                : "bg-white text-gray-700 border-2 border-gray-300 hover:border-gray-400"
                                            }
                                            ${isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
                                          `}
                                        >
                                          {ageRange}
                                        </button>
                                      );
                                    })}
                                  </div>

                                  {/* Selected Age Groups Display */}
                                  {listing.creatorRequirements.targetAgeGroups.length > 0 && (
                                    <div className="mt-3">
                                      <p className="text-sm text-gray-600 mb-2">
                                        Selected age groups:
                                      </p>
                                      <div className="flex flex-wrap gap-2">
                                        {listing.creatorRequirements.targetAgeGroups.map(
                                          (ageGroup) => (
                                            <div
                                              key={ageGroup}
                                              className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-100 text-blue-700 rounded-full text-sm font-medium"
                                            >
                                              <span>{ageGroup}</span>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  handleToggleTargetAgeGroup(listingIndex, ageGroup)
                                                }
                                                className="text-blue-700 hover:text-red-600 transition-colors"
                                              >
                                                <XMarkIcon className="w-4 h-4" />
                                              </button>
                                            </div>
                                          ),
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Submit Buttons */}
              <div className="flex justify-end gap-3 pt-6 border-t">
                <Button type="button" variant="outline" onClick={() => router.push("/dashboard")}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={loading}>
                  {loading ? "Creating..." : "Create User"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
