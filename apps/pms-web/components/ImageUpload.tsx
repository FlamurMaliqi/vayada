"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { XMarkIcon, PhotoIcon, ArrowUpTrayIcon } from "@heroicons/react/24/outline";
import { imageReferenceUrl, isRoomImageReference, uploadService } from "@/services/upload";
import type { RoomImageReference, UploadedImage } from "@/services/upload";
import type { PlatformMediaResourceScope } from "@/services/platform-media";
import { useTranslation } from "@/lib/i18n";

interface ImageUploadProps {
  /** Already-uploaded image references (legacy URLs or platform media refs) */
  images: RoomImageReference[];
  /** Called when images change */
  onChange: (images: RoomImageReference[]) => void;
  /** Platform media scope for new uploads */
  mediaResource: PlatformMediaResourceScope;
  /** Max number of images */
  maxImages: number | null;
  /** Current property plan, or null while it loads */
  plan: "commission" | "fixed" | null;
  /** Max file size in MB */
  maxSizeMB?: number;
  /** Label text */
  label?: string;
  /** Whether to show compact style (for wizards) */
  compact?: boolean;
}

export default function ImageUpload({
  images,
  onChange,
  mediaResource,
  maxImages,
  plan,
  maxSizeMB = 20,
  label,
  compact = false,
}: ImageUploadProps) {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const validImages = useMemo(() => images.filter(isRoomImageReference), [images]);
  const isAtLimit = maxImages !== null && validImages.length >= maxImages;
  const canUpload = maxImages !== null && validImages.length < maxImages;
  const upgradeUrl = `${(
    process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com"
  ).replace(/\/$/, "")}/settings?section=billing`;

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      setError("");

      const fileArray = Array.from(files);

      // Validate count
      if (maxImages === null) {
        setError(t("images.limitLoadingError"));
        e.target.value = "";
        return;
      }
      if (validImages.length + fileArray.length > maxImages) {
        setError(photoLimitMessage(t, plan, validImages.length, maxImages));
        e.target.value = "";
        return;
      }

      // Validate each file
      for (const file of fileArray) {
        if (!file.type.startsWith("image/")) {
          setError(t("rooms.form.onlyImageFiles"));
          e.target.value = "";
          return;
        }
        if (file.size > maxSizeMB * 1024 * 1024) {
          setError(t("images.sizeError", { size: maxSizeMB }));
          e.target.value = "";
          return;
        }
      }

      setUploading(true);
      try {
        if (!mediaResource.targetResourceId) {
          onChange([
            ...validImages,
            ...fileArray.map((file) => ({
              url: URL.createObjectURL(file),
              pendingFile: file,
            })),
          ]);
          return;
        }
        const result = await uploadService.uploadImages(fileArray, mediaResource);
        const newImages = result.images.map((img: UploadedImage) => ({
          url: img.url,
          platformMediaObjectId: img.platformMediaObjectId,
        }));
        onChange([...validImages, ...newImages]);
      } catch (err: any) {
        setError(err.message || t("images.uploadError"));
      } finally {
        setUploading(false);
        e.target.value = "";
      }
    },
    [validImages, onChange, maxImages, maxSizeMB, mediaResource, plan, t],
  );

  const removeImage = useCallback(
    (index: number) => {
      const removed = validImages[index];
      if (typeof removed !== "string" && removed?.pendingFile && removed.url?.startsWith("blob:")) {
        URL.revokeObjectURL(removed.url);
      }
      const updated = validImages.filter((_, i) => i !== index);
      onChange(updated);
    },
    [validImages, onChange],
  );

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setOverIndex(index);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, dropIndex: number) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === dropIndex) {
        setDragIndex(null);
        setOverIndex(null);
        return;
      }
      const reordered = [...validImages];
      const [moved] = reordered.splice(dragIndex, 1);
      reordered.splice(dropIndex, 0, moved);
      onChange(reordered);
      setDragIndex(null);
      setOverIndex(null);
    },
    [dragIndex, validImages, onChange],
  );

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setOverIndex(null);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {label && (
          <label
            className={`block font-medium text-gray-700 ${compact ? "text-[13px]" : "text-sm"}`}
          >
            {label ?? t("rooms.form.roomImages")}
          </label>
        )}
        <span className={`font-medium text-gray-500 ${compact ? "text-[11px]" : "text-xs"}`}>
          {maxImages === null
            ? t("images.loadingLimit")
            : t("images.photoCount", { current: validImages.length, max: maxImages })}
        </span>
      </div>

      {/* Image grid */}
      {validImages.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {validImages.map((image, i) => {
            const url = imageReferenceUrl(image);
            return (
              <div
                key={url + i}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDrop={(e) => handleDrop(e, i)}
                onDragEnd={handleDragEnd}
                className={`relative group aspect-square rounded-lg overflow-hidden border-2 bg-gray-50 cursor-grab active:cursor-grabbing transition-all ${
                  dragIndex === i
                    ? "opacity-40 border-primary-300"
                    : overIndex === i && dragIndex !== null
                      ? "border-primary-500 scale-[1.03]"
                      : "border-gray-200"
                }`}
              >
                <img
                  src={url}
                  alt={t("images.roomImage", { number: i + 1 })}
                  className="w-full h-full object-cover pointer-events-none"
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  aria-label={t("images.removeImage", { number: i + 1 })}
                  className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <XMarkIcon className="w-3 h-3" />
                </button>
                {i === 0 && (
                  <span className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 text-white text-[10px] font-medium rounded">
                    {t("common.coverLabel")}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Upload zone */}
      {canUpload && (
        <div
          onClick={() => !uploading && fileInputRef.current?.click()}
          className={`
            border-2 border-dashed rounded-lg flex flex-col items-center justify-center cursor-pointer transition-colors
            ${uploading ? "border-primary-300 bg-primary-50 cursor-wait" : "border-gray-300 hover:border-primary-400 hover:bg-gray-50"}
            ${compact ? "py-4 px-3" : "py-6 px-4"}
          `}
        >
          {uploading ? (
            <>
              <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin mb-2" />
              <p className={`text-primary-600 font-medium ${compact ? "text-[12px]" : "text-sm"}`}>
                {t("common.uploading")}
              </p>
            </>
          ) : (
            <>
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mb-2">
                {validImages.length === 0 ? (
                  <PhotoIcon className="w-5 h-5 text-gray-400" />
                ) : (
                  <ArrowUpTrayIcon className="w-5 h-5 text-gray-400" />
                )}
              </div>
              <p className={`text-gray-700 font-medium ${compact ? "text-[12px]" : "text-sm"}`}>
                {validImages.length === 0
                  ? t("rooms.form.uploadRoomImages")
                  : t("rooms.form.addMoreImages")}
              </p>
              <p className={`text-gray-400 mt-0.5 ${compact ? "text-[11px]" : "text-xs"}`}>
                {t("images.formatsAndLimit", {
                  size: maxSizeMB,
                  current: validImages.length,
                  max: maxImages ?? 0,
                })}
              </p>
            </>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      )}

      {isAtLimit && maxImages !== null && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">
          <p>{photoLimitMessage(t, plan, validImages.length, maxImages)}</p>
          {plan === "commission" && (
            <a className="font-semibold text-primary-700 hover:underline" href={upgradeUrl}>
              {t("images.upgrade")}
            </a>
          )}
        </div>
      )}

      {!isAtLimit && plan === "commission" && (
        <a className="block text-xs font-medium text-primary-700 hover:underline" href={upgradeUrl}>
          {t("images.upgrade")}
        </a>
      )}

      {error && (
        <p className={`text-red-600 font-medium ${compact ? "text-[11px]" : "text-xs"}`}>{error}</p>
      )}
    </div>
  );
}

function photoLimitMessage(
  t: (key: string) => string,
  plan: "commission" | "fixed" | null,
  currentCount: number,
  maxImages: number,
): string {
  if (currentCount > maxImages) {
    return plan === "commission" ? t("images.overCommissionLimit") : t("images.overPaidLimit");
  }
  return plan === "commission" ? t("images.commissionLimit") : t("images.paidLimit");
}
