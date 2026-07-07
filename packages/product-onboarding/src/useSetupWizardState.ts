import { useState, useEffect, useRef } from "react";
import { createEmptyRoom, type RoomType } from "./RoomsStep";
import { createEmptyLastMinuteConfig, type LastMinuteConfig } from "./LastMinuteStep";
import { type SetupAddon } from "./AddonsStep";

export type RoomTab = "details" | "pricing" | "media" | "benefits";

export interface SetupWizardOptions {
  uploadSingleImage: (file: File) => Promise<string>;
  uploadImages: (files: File[]) => Promise<string[]>;
  defaultCurrency?: string;
  defaultCheckInFrom?: string;
  defaultEnableReferAGuest?: boolean;
  defaultBookingFilters?: string[];
  syncAddonCurrency?: boolean;
}

const BASE_BOOKING_FILTERS = ["includeBreakfast", "freeCancellation", "payAtHotel"];

export function useSetupWizardState({
  uploadSingleImage,
  uploadImages,
  defaultCurrency = "USD",
  defaultCheckInFrom = "14:00",
  defaultEnableReferAGuest = false,
  defaultBookingFilters = BASE_BOOKING_FILTERS,
  syncAddonCurrency = true,
}: SetupWizardOptions) {
  const [propertyName, setPropertyName] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [address, setAddress] = useState("");
  const [reservationEmail, setReservationEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [instagram, setInstagram] = useState("");
  const [facebook, setFacebook] = useState("");
  const [tiktok, setTiktok] = useState("");
  const [youtube, setYoutube] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [defaultLanguage, setDefaultLanguage] = useState("en");
  const [supportedCurrencies, setSupportedCurrencies] = useState<string[]>([]);
  const [supportedLanguages, setSupportedLanguages] = useState<string[]>([]);

  const [heroImage, setHeroImage] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#4F46E5");
  const [accentColor, setAccentColor] = useState("#F5F3EF");
  const [selectedFont, setSelectedFont] = useState("high-end-serif");
  const [propertyDescription, setPropertyDescription] = useState("");
  const [bookingFilters, setBookingFilters] = useState<string[]>(defaultBookingFilters);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const [rooms, setRooms] = useState<RoomType[]>([createEmptyRoom()]);
  const [activeRoomIndex, setActiveRoomIndex] = useState(0);
  const [activeRoomTab, setActiveRoomTab] = useState<RoomTab>("details");
  const [amenityInput, setAmenityInput] = useState("");
  const [featureInput, setFeatureInput] = useState("");
  const roomFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingRoomImages, setUploadingRoomImages] = useState(false);
  const [roomImageUploadError, setRoomImageUploadError] = useState("");

  const [setupAddons, setSetupAddons] = useState<SetupAddon[]>([]);
  const [benefits, setBenefits] = useState<string[]>([]);
  const [lastMinuteConfig, setLastMinuteConfig] = useState<LastMinuteConfig>(
    createEmptyLastMinuteConfig(),
  );

  const [checkInFrom, setCheckInFrom] = useState(defaultCheckInFrom);
  const [checkInUntil, setCheckInUntil] = useState("22:00");
  const [checkOutFrom, setCheckOutFrom] = useState("07:00");
  const [checkOutUntil, setCheckOutUntil] = useState("11:00");
  const [payAtHotel, setPayAtHotel] = useState(true);
  const [payAtHotelMethods, setPayAtHotelMethods] = useState<string[]>(["cash", "card"]);
  const [onlineCardPayment, setOnlineCardPayment] = useState(false);
  const [bankTransfer, setBankTransfer] = useState(false);
  const [payoutAccountHolder, setPayoutAccountHolder] = useState("");
  const [payoutAccountType, setPayoutAccountType] = useState<"iban" | "account_number">("iban");
  const [payoutIban, setPayoutIban] = useState("");
  const [payoutAccountNumber, setPayoutAccountNumber] = useState("");
  const [payoutBankName, setPayoutBankName] = useState("");
  const [payoutSwift, setPayoutSwift] = useState("");
  const [specialRequests, setSpecialRequests] = useState(true);
  const [estimatedArrivalTime, setEstimatedArrivalTime] = useState(false);
  const [numberOfGuests, setNumberOfGuests] = useState(false);
  const [enableReferAGuest, setEnableReferAGuest] = useState(defaultEnableReferAGuest);
  const [paymentProvider, setPaymentProvider] = useState<"stripe" | "xendit" | "vayada">("vayada");
  const [xenditChannelCode, setXenditChannelCode] = useState("ID_BCA");
  const [xenditAccountNumber, setXenditAccountNumber] = useState("");
  const [xenditAccountHolderName, setXenditAccountHolderName] = useState("");

  // The property currency is the single source of truth — rooms/addons must
  // always follow it so prices entered in the visible currency aren't stored
  // under a stale currency and double-converted by the booking engine.
  useEffect(() => {
    setRooms((prev) => prev.map((r) => ({ ...r, currency })));
    if (syncAddonCurrency) {
      setSetupAddons((prev) => prev.map((a) => ({ ...a, currency })));
    }
  }, [currency, syncAddonCurrency]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    setHeroImage(previewUrl);
    try {
      setUploading(true);
      const s3Url = await uploadSingleImage(file);
      URL.revokeObjectURL(previewUrl);
      setHeroImage(s3Url);
    } catch (err) {
      console.error("Image upload failed:", err);
    } finally {
      setUploading(false);
    }
  };

  const handleRoomImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleRoomImageFiles(Array.from(e.target.files ?? []));
  };

  const handleRoomImageFiles = async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    try {
      setRoomImageUploadError("");
      setUploadingRoomImages(true);
      const urls = await uploadImages(imageFiles);
      setRooms((prev) =>
        prev.map((r, i) => (i === activeRoomIndex ? { ...r, images: [...r.images, ...urls] } : r)),
      );
    } catch (err) {
      console.error("Room image upload failed:", err);
      setRoomImageUploadError("Room image upload failed. Please try again.");
    } finally {
      setUploadingRoomImages(false);
      if (roomFileInputRef.current) roomFileInputRef.current.value = "";
    }
  };

  const reset = () => {
    setRoomImageUploadError("");
    setPropertyName("");
    setCity("");
    setCountry("");
    setAddress("");
    setReservationEmail("");
    setPhoneNumber("");
    setWhatsapp("");
    setInstagram("");
    setFacebook("");
    setTiktok("");
    setYoutube("");
    setCurrency(defaultCurrency);
    setDefaultLanguage("en");
    setSupportedCurrencies([]);
    setSupportedLanguages([]);
    setHeroImage("");
    setPrimaryColor("#4F46E5");
    setAccentColor("#F5F3EF");
    setSelectedFont("high-end-serif");
    setPropertyDescription("");
    setBookingFilters(defaultBookingFilters);
    setRooms([createEmptyRoom()]);
    setActiveRoomIndex(0);
    setActiveRoomTab("details");
    setAmenityInput("");
    setFeatureInput("");
    setSetupAddons([]);
    setBenefits([]);
    setLastMinuteConfig(createEmptyLastMinuteConfig());
    setCheckInFrom(defaultCheckInFrom);
    setCheckInUntil("22:00");
    setCheckOutFrom("07:00");
    setCheckOutUntil("11:00");
    setPayAtHotel(true);
    setPayAtHotelMethods(["cash", "card"]);
    setOnlineCardPayment(false);
    setBankTransfer(false);
    setPayoutAccountHolder("");
    setPayoutAccountType("iban");
    setPayoutIban("");
    setPayoutAccountNumber("");
    setPayoutBankName("");
    setPayoutSwift("");
    setSpecialRequests(true);
    setEstimatedArrivalTime(false);
    setNumberOfGuests(false);
    setEnableReferAGuest(defaultEnableReferAGuest);
    setPaymentProvider("vayada");
    setXenditChannelCode("ID_BCA");
    setXenditAccountNumber("");
    setXenditAccountHolderName("");
  };

  return {
    propertyName,
    setPropertyName,
    city,
    setCity,
    country,
    setCountry,
    address,
    setAddress,
    reservationEmail,
    setReservationEmail,
    phoneNumber,
    setPhoneNumber,
    whatsapp,
    setWhatsapp,
    instagram,
    setInstagram,
    facebook,
    setFacebook,
    tiktok,
    setTiktok,
    youtube,
    setYoutube,
    currency,
    setCurrency,
    defaultLanguage,
    setDefaultLanguage,
    supportedCurrencies,
    setSupportedCurrencies,
    supportedLanguages,
    setSupportedLanguages,
    heroImage,
    setHeroImage,
    primaryColor,
    setPrimaryColor,
    accentColor,
    setAccentColor,
    selectedFont,
    setSelectedFont,
    propertyDescription,
    setPropertyDescription,
    bookingFilters,
    setBookingFilters,
    fileInputRef,
    uploading,
    handleImageUpload,
    rooms,
    setRooms,
    activeRoomIndex,
    setActiveRoomIndex,
    activeRoomTab,
    setActiveRoomTab,
    amenityInput,
    setAmenityInput,
    featureInput,
    setFeatureInput,
    roomFileInputRef,
    uploadingRoomImages,
    roomImageUploadError,
    handleRoomImageUpload,
    handleRoomImageFiles,
    setupAddons,
    setSetupAddons,
    benefits,
    setBenefits,
    lastMinuteConfig,
    setLastMinuteConfig,
    checkInFrom,
    setCheckInFrom,
    checkInUntil,
    setCheckInUntil,
    checkOutFrom,
    setCheckOutFrom,
    checkOutUntil,
    setCheckOutUntil,
    payAtHotel,
    setPayAtHotel,
    payAtHotelMethods,
    setPayAtHotelMethods,
    onlineCardPayment,
    setOnlineCardPayment,
    bankTransfer,
    setBankTransfer,
    payoutAccountHolder,
    setPayoutAccountHolder,
    payoutAccountType,
    setPayoutAccountType,
    payoutIban,
    setPayoutIban,
    payoutAccountNumber,
    setPayoutAccountNumber,
    payoutBankName,
    setPayoutBankName,
    payoutSwift,
    setPayoutSwift,
    specialRequests,
    setSpecialRequests,
    estimatedArrivalTime,
    setEstimatedArrivalTime,
    numberOfGuests,
    setNumberOfGuests,
    enableReferAGuest,
    setEnableReferAGuest,
    paymentProvider,
    setPaymentProvider,
    xenditChannelCode,
    setXenditChannelCode,
    xenditAccountNumber,
    setXenditAccountNumber,
    xenditAccountHolderName,
    setXenditAccountHolderName,
    reset,
  };
}
