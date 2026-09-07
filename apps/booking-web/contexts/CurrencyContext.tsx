"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { bookingEngine } from "@/services/api/client";

interface CurrencyContextValue {
  selectedCurrency: string;
  setSelectedCurrency: (currency: string) => void;
  rates: Record<string, number>;
  loading: boolean;
  convertPrice: (amount: number, fromCurrency: string) => number;
  convertBetween: (amount: number, fromCurrency: string, toCurrency: string) => number;
  convertAndRound: (amount: number, fromCurrency: string) => number;
  formatPrice: (amount: number, fromCurrency: string) => string;
}

const CurrencyContext = createContext<CurrencyContextValue>({
  selectedCurrency: "EUR",
  setSelectedCurrency: () => {},
  rates: {},
  loading: true,
  convertPrice: (amount) => amount,
  convertBetween: (amount) => amount,
  convertAndRound: (amount) => Math.round(amount * 100) / 100,
  formatPrice: (amount) => String(amount),
});

const STORAGE_KEY_PREFIX = "vayada-selected-currency";

function getStorageKey(slug: string) {
  return `${STORAGE_KEY_PREFIX}-${slug}`;
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const baseCurrency = hotel?.currency || "EUR";

  // Always start with the hotel's base currency so SSR and the first client
  // render agree. The effect below replaces it with the persisted choice once
  // we're definitively on the client and the slug has been resolved.
  const [selectedCurrency, setSelectedCurrencyState] = useState<string>(baseCurrency);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hotel || !slug) return;
    const stored = localStorage.getItem(getStorageKey(slug));
    setSelectedCurrencyState(stored || hotel.currency);
  }, [hotel, slug]);

  // Fetch exchange rates with retry
  useEffect(() => {
    if (!baseCurrency) return;
    let cancelled = false;

    const fetchRates = async () => {
      setLoading(true);
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const data = await bookingEngine.get<{ base: string; rates: Record<string, number> }>(
            `/api/exchange-rates?base=${baseCurrency}`,
          );
          if (!cancelled) {
            setRates(data.rates);
            setLoading(false);
          }
          return;
        } catch {
          if (attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }
      if (!cancelled) setLoading(false);
    };

    fetchRates();
    return () => {
      cancelled = true;
    };
  }, [baseCurrency]);

  const setSelectedCurrency = useCallback(
    (currency: string) => {
      setSelectedCurrencyState(currency);
      if (typeof window !== "undefined" && slug) {
        localStorage.setItem(getStorageKey(slug), currency);
      }
    },
    [slug],
  );

  const convertPrice = useCallback(
    (amount: number, fromCurrency: string): number => {
      if (fromCurrency === selectedCurrency) return amount;
      // fromCurrency -> baseCurrency -> selectedCurrency
      let amountInBase = amount;
      if (fromCurrency !== baseCurrency) {
        const fromRate = rates[fromCurrency];
        if (!fromRate) return amount;
        amountInBase = amount / fromRate;
      }
      if (selectedCurrency === baseCurrency) return amountInBase;
      const toRate = rates[selectedCurrency];
      if (!toRate) return amount;
      return amountInBase * toRate;
    },
    [selectedCurrency, baseCurrency, rates],
  );

  const convertBetween = useCallback(
    (amount: number, fromCurrency: string, toCurrency: string): number => {
      if (fromCurrency === toCurrency) return amount;
      let amountInBase = amount;
      if (fromCurrency !== baseCurrency) {
        const fromRate = rates[fromCurrency];
        if (!fromRate) return amount;
        amountInBase = amount / fromRate;
      }
      if (toCurrency === baseCurrency) return amountInBase;
      const toRate = rates[toCurrency];
      if (!toRate) return amount;
      return amountInBase * toRate;
    },
    [baseCurrency, rates],
  );

  // Preserve currency minor units so displayed line amounts retain quoted cents.
  const convertAndRound = useCallback(
    (amount: number, fromCurrency: string): number => {
      let canConvert = true;
      if (fromCurrency !== selectedCurrency) {
        if (fromCurrency !== baseCurrency && !rates[fromCurrency]) canConvert = false;
        if (selectedCurrency !== baseCurrency && !rates[selectedCurrency]) canConvert = false;
      }
      const converted = canConvert ? convertPrice(amount, fromCurrency) : amount;
      const currency = canConvert ? selectedCurrency : fromCurrency;
      const digits = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits;
      const factor = 10 ** (digits ?? 2);
      return Math.round(converted * factor) / factor;
    },
    [convertPrice, selectedCurrency, baseCurrency, rates],
  );

  const formatPrice = useCallback(
    (amount: number, fromCurrency: string): string => {
      // Check if we can actually perform the conversion
      let canConvert = true;
      if (fromCurrency !== selectedCurrency) {
        if (fromCurrency !== baseCurrency && !rates[fromCurrency]) canConvert = false;
        if (selectedCurrency !== baseCurrency && !rates[selectedCurrency]) canConvert = false;
      }

      const displayCurrency = canConvert ? selectedCurrency : fromCurrency;
      const displayAmount = canConvert ? convertPrice(amount, fromCurrency) : amount;

      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: displayCurrency,
        minimumFractionDigits: 0,
      }).format(displayAmount);
    },
    [convertPrice, selectedCurrency, baseCurrency, rates],
  );

  return (
    <CurrencyContext.Provider
      value={{
        selectedCurrency,
        setSelectedCurrency,
        rates,
        loading,
        convertPrice,
        convertBetween,
        convertAndRound,
        formatPrice,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  return useContext(CurrencyContext);
}
