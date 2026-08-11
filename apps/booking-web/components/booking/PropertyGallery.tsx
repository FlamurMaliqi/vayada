"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Squares2X2Icon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type PropertyGalleryProps = {
  hotelName: string;
  images: string[];
};

const MAX_PROPERTY_GALLERY_PHOTOS = 10;

export default function PropertyGallery({ hotelName, images }: PropertyGalleryProps) {
  const t = useTranslations("home.gallery");
  const galleryImages = Array.from(new Set(images.filter(Boolean))).slice(
    0,
    MAX_PROPERTY_GALLERY_PHOTOS,
  );
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number | null>(null);
  const hasMultipleImages = galleryImages.length > 1;

  const close = useCallback(() => setOpen(false), []);
  const previous = useCallback(() => {
    if (!hasMultipleImages) return;
    setIndex((current) => (current - 1 + galleryImages.length) % galleryImages.length);
  }, [galleryImages.length, hasMultipleImages]);
  const next = useCallback(() => {
    if (!hasMultipleImages) return;
    setIndex((current) => (current + 1) % galleryImages.length);
  }, [galleryImages.length, hasMultipleImages]);

  useEffect(() => {
    if (index >= galleryImages.length) setIndex(0);
  }, [galleryImages.length, index]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      } else if (event.key === "ArrowLeft") {
        previous();
      } else if (event.key === "ArrowRight") {
        next();
      } else if (event.key === "Tab") {
        trapDialogFocus(event, dialogRef.current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
      trigger?.focus();
    };
  }, [close, next, open, previous]);

  if (galleryImages.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setIndex(0);
          setOpen(true);
        }}
        className="absolute bottom-14 right-4 z-20 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/25 bg-gray-950/70 px-4 py-2.5 text-sm font-semibold text-white shadow-lg backdrop-blur-md transition hover:bg-gray-950/85 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-transparent md:right-8"
        aria-haspopup="dialog"
      >
        <Squares2X2Icon className="h-5 w-5" />
        {t("viewPhotos", { count: galleryImages.length })}
      </button>

      {open &&
        createPortal(
          <div
            ref={dialogRef}
            className="fixed inset-0 z-[120] flex flex-col bg-gray-950/95 text-white backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label={t("dialogLabel", { hotelName })}
            onClick={close}
          >
            <div className="flex h-16 shrink-0 items-center justify-between px-4 md:px-6">
              <p className="text-sm font-semibold tabular-nums" aria-live="polite">
                {index + 1} / {galleryImages.length}
              </p>
              <button
                ref={closeRef}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  close();
                }}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white"
                aria-label={t("close")}
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-6 md:px-20">
              <div
                className="relative h-full w-full max-w-7xl"
                onTouchStart={(event) => {
                  touchStartX.current = event.touches[0]?.clientX ?? null;
                }}
                onTouchEnd={(event) => {
                  if (touchStartX.current === null || !hasMultipleImages) return;
                  const delta =
                    (event.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
                  if (Math.abs(delta) > 50) (delta < 0 ? next : previous)();
                  touchStartX.current = null;
                }}
              >
                <Image
                  src={galleryImages[index]!}
                  alt={t("photoAlt", { hotelName, index: index + 1 })}
                  fill
                  className="select-none object-contain"
                  quality={90}
                  sizes="100vw"
                  priority={index === 0}
                  onClick={keepContainedImageClickOpen}
                />
              </div>

              {hasMultipleImages && (
                <>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      previous();
                    }}
                    className="absolute left-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white md:left-6"
                    aria-label={t("previous")}
                  >
                    <ChevronLeftIcon className="h-7 w-7" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      next();
                    }}
                    className="absolute right-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white md:right-6"
                    aria-label={t("next")}
                  >
                    <ChevronRightIcon className="h-7 w-7" />
                  </button>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (!dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }

  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function keepContainedImageClickOpen(event: MouseEvent<HTMLImageElement>) {
  const image = event.currentTarget;
  if (!image.naturalWidth || !image.naturalHeight) return;
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const imageLeft = (bounds.width - renderedWidth) / 2;
  const imageTop = (bounds.height - renderedHeight) / 2;
  const clickX = event.clientX - bounds.left;
  const clickY = event.clientY - bounds.top;
  if (
    clickX >= imageLeft &&
    clickX <= imageLeft + renderedWidth &&
    clickY >= imageTop &&
    clickY <= imageTop + renderedHeight
  ) {
    event.stopPropagation();
  }
}
