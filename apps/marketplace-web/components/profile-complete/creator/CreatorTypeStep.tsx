"use client";

import Image from "next/image";
import { CheckIcon, PaperAirplaneIcon, SparklesIcon } from "@heroicons/react/24/outline";
import type { CreatorType } from "@/lib/types";

interface CreatorTypeStepProps {
  selectedType: CreatorType | undefined;
  onSelect: (type: CreatorType) => void;
}

const CREATOR_TYPES = [
  {
    type: "Lifestyle" as CreatorType,
    icon: SparklesIcon,
    image: "/creator-category-lifestyle.jpg",
    label: "Lifestyle",
    description: "Hotels, food, wellness, and everyday experiences.",
  },
  {
    type: "Travel" as CreatorType,
    icon: PaperAirplaneIcon,
    image: "/creator-category-travel.jpg",
    label: "Travel",
    description: "Destinations, stays, itineraries, and local discoveries.",
  },
  {
    type: "Other" as CreatorType,
    icon: SparklesIcon,
    image: "/creator-category-other.jpg",
    label: "Something else",
    description: "A different niche with a strong fit for hotel collaborations.",
  },
];

export function CreatorTypeStep({ selectedType, onSelect }: CreatorTypeStepProps) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {CREATOR_TYPES.map(({ type, icon: Icon, image, label, description }) => {
        const isSelected = selectedType === type;

        return (
          <button
            key={type}
            type="button"
            onClick={() => onSelect(type)}
            aria-pressed={isSelected}
            className={`group relative rounded-3xl bg-white p-3 pb-5 text-left shadow-[0_22px_55px_-32px_rgba(15,23,42,0.5)] ring-1 transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 md:hover:-translate-y-1 ${
              isSelected ? "ring-2 ring-primary-500" : "ring-gray-200 hover:ring-gray-300"
            }`}
          >
            <span className="relative block aspect-[16/9] overflow-hidden rounded-2xl bg-gray-100">
              <Image
                src={image}
                alt=""
                fill
                priority
                sizes="(min-width: 768px) 280px, 100vw"
                className="object-cover transition duration-300 group-hover:scale-105"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-gray-950/20 to-transparent" />
              <span
                className={`absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full ${
                  isSelected ? "bg-primary-600 text-white" : "bg-white/90 text-transparent"
                }`}
                aria-hidden="true"
              >
                <CheckIcon className="h-4 w-4" />
              </span>
            </span>

            <span className="mt-4 flex items-start gap-3">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  isSelected ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600"
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-base font-semibold text-gray-950">{label}</span>
                <span className="mt-1 block text-sm leading-5 text-gray-600">{description}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
