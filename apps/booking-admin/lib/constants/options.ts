export {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  POPULAR_COUNTRY_CODES,
  POPULAR_CURRENCY_CODES,
  TIMEZONE_OPTIONS,
  type CountryOption,
  type CurrencyOption,
} from "@vayada/locale-constants";

export interface LanguageOption {
  code: string;
  name: string;
  nativeName: string;
  flag: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "en", name: "English", nativeName: "English", flag: "\u{1F1EC}\u{1F1E7}" },
  { code: "de", name: "German", nativeName: "Deutsch", flag: "\u{1F1E9}\u{1F1EA}" },
  { code: "fr", name: "French", nativeName: "Fran\u00e7ais", flag: "\u{1F1EB}\u{1F1F7}" },
  { code: "es", name: "Spanish", nativeName: "Espa\u00f1ol", flag: "\u{1F1EA}\u{1F1F8}" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", flag: "\u{1F1EE}\u{1F1E9}" },
  { code: "ja", name: "Japanese", nativeName: "\u65E5\u672C\u8A9E", flag: "\u{1F1EF}\u{1F1F5}" },
  { code: "zh", name: "Chinese", nativeName: "\u4E2D\u6587", flag: "\u{1F1E8}\u{1F1F3}" },
  {
    code: "ru",
    name: "Russian",
    nativeName: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439",
    flag: "\u{1F1F7}\u{1F1FA}",
  },
  { code: "it", name: "Italian", nativeName: "Italiano", flag: "\u{1F1EE}\u{1F1F9}" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", flag: "\u{1F1F3}\u{1F1F1}" },
  { code: "ko", name: "Korean", nativeName: "한국어", flag: "\u{1F1F0}\u{1F1F7}" },
];

export const POPULAR_LANGUAGE_CODES = ["id", "de", "fr", "es", "ja", "ru"];
