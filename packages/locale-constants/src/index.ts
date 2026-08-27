export interface CurrencyOption {
  code: string;
  name: string;
  flag: string;
}

export interface LanguageOption {
  code: string;
  name: string;
  nativeName: string;
  flag: string;
}

export type PaymentMethodLabelKey =
  | "card"
  | "creditCard"
  | "payAtProperty"
  | "bankTransfer"
  | "cash"
  | "manualCard"
  | "paypal"
  | "xendit"
  | "other";

const PAYMENT_METHOD_LABELS: Record<PaymentMethodLabelKey, string> = {
  card: "Card",
  creditCard: "Credit Card",
  payAtProperty: "Pay at Property",
  bankTransfer: "Bank Transfer",
  cash: "Cash",
  manualCard: "Manual Card",
  paypal: "PayPal",
  xendit: "Xendit",
  other: "Other",
};

export function paymentMethodLabelKey(value: string | null | undefined): PaymentMethodLabelKey {
  switch (value) {
    case "card":
      return "card";
    case "credit_card":
      return "creditCard";
    case "pay_at_property":
      return "payAtProperty";
    case "bank_transfer":
      return "bankTransfer";
    case "cash":
      return "cash";
    case "manual_card":
      return "manualCard";
    case "paypal":
      return "paypal";
    case "xendit":
      return "xendit";
    default:
      return "other";
  }
}

export function paymentMethodLabel(value: string | null | undefined): string {
  return PAYMENT_METHOD_LABELS[paymentMethodLabelKey(value)];
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "en", name: "English", nativeName: "English", flag: "🇬🇧" },
  { code: "de", name: "German", nativeName: "Deutsch", flag: "🇩🇪" },
  { code: "fr", name: "French", nativeName: "Français", flag: "🇫🇷" },
  { code: "es", name: "Spanish", nativeName: "Español", flag: "🇪🇸" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", flag: "🇮🇩" },
  { code: "ja", name: "Japanese", nativeName: "日本語", flag: "🇯🇵" },
  { code: "zh", name: "Chinese", nativeName: "中文", flag: "🇨🇳" },
  { code: "ru", name: "Russian", nativeName: "Русский", flag: "🇷🇺" },
  { code: "it", name: "Italian", nativeName: "Italiano", flag: "🇮🇹" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", flag: "🇳🇱" },
  { code: "ko", name: "Korean", nativeName: "한국어", flag: "🇰🇷" },
];

export const POPULAR_LANGUAGE_CODES = ["id", "de", "fr", "es", "ja", "ru"];

export const CURRENCY_OPTIONS: CurrencyOption[] = [
  { code: "AED", name: "UAE Dirham", flag: "🇦🇪" },
  { code: "AUD", name: "Australian Dollar", flag: "🇦🇺" },
  { code: "BGN", name: "Bulgarian Lev", flag: "🇧🇬" },
  { code: "BRL", name: "Brazilian Real", flag: "🇧🇷" },
  { code: "CAD", name: "Canadian Dollar", flag: "🇨🇦" },
  { code: "CHF", name: "Swiss Franc", flag: "🇨🇭" },
  { code: "CNY", name: "Chinese Yuan", flag: "🇨🇳" },
  { code: "CZK", name: "Czech Koruna", flag: "🇨🇿" },
  { code: "DKK", name: "Danish Krone", flag: "🇩🇰" },
  { code: "EUR", name: "Euro", flag: "🇪🇺" },
  { code: "GBP", name: "British Pound", flag: "🇬🇧" },
  { code: "HKD", name: "Hong Kong Dollar", flag: "🇭🇰" },
  { code: "HRK", name: "Croatian Kuna", flag: "🇭🇷" },
  { code: "HUF", name: "Hungarian Forint", flag: "🇭🇺" },
  { code: "IDR", name: "Indonesian Rupiah", flag: "🇮🇩" },
  { code: "INR", name: "Indian Rupee", flag: "🇮🇳" },
  { code: "JPY", name: "Japanese Yen", flag: "🇯🇵" },
  { code: "KRW", name: "South Korean Won", flag: "🇰🇷" },
  { code: "LKR", name: "Sri Lankan Rupee", flag: "🇱🇰" },
  { code: "MXN", name: "Mexican Peso", flag: "🇲🇽" },
  { code: "MYR", name: "Malaysian Ringgit", flag: "🇲🇾" },
  { code: "NOK", name: "Norwegian Krone", flag: "🇳🇴" },
  { code: "NZD", name: "New Zealand Dollar", flag: "🇳🇿" },
  { code: "PHP", name: "Philippine Peso", flag: "🇵🇭" },
  { code: "PLN", name: "Polish Zloty", flag: "🇵🇱" },
  { code: "RON", name: "Romanian Leu", flag: "🇷🇴" },
  { code: "RUB", name: "Russian Ruble", flag: "🇷🇺" },
  { code: "SEK", name: "Swedish Krona", flag: "🇸🇪" },
  { code: "SGD", name: "Singapore Dollar", flag: "🇸🇬" },
  { code: "THB", name: "Thai Baht", flag: "🇹🇭" },
  { code: "TRY", name: "Turkish Lira", flag: "🇹🇷" },
  { code: "USD", name: "US Dollar", flag: "🇺🇸" },
  { code: "VND", name: "Vietnamese Dong", flag: "🇻🇳" },
];

export const POPULAR_CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "SGD",
  "CHF",
  "CAD",
  "THB",
  "JPY",
];

export const TIMEZONE_OPTIONS = [
  "Etc/UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/Vienna",
  "Europe/Zurich",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Australia/Sydney",
];

export interface CountryOption {
  code: string;
  name: string;
  flag: string;
}

function countryFlag(code: string): string {
  return String.fromCodePoint(
    ...code.split("").map((character) => character.charCodeAt(0) + 127397),
  );
}

export const COUNTRY_OPTIONS: CountryOption[] = [
  { code: "AF", name: "Afghanistan", flag: "\u{1F1E6}\u{1F1EB}" },
  { code: "AL", name: "Albania", flag: "\u{1F1E6}\u{1F1F1}" },
  { code: "DZ", name: "Algeria", flag: "\u{1F1E9}\u{1F1FF}" },
  { code: "AD", name: "Andorra", flag: "\u{1F1E6}\u{1F1E9}" },
  { code: "AO", name: "Angola", flag: "\u{1F1E6}\u{1F1F4}" },
  { code: "AR", name: "Argentina", flag: "\u{1F1E6}\u{1F1F7}" },
  { code: "AM", name: "Armenia", flag: "\u{1F1E6}\u{1F1F2}" },
  { code: "AU", name: "Australia", flag: "\u{1F1E6}\u{1F1FA}" },
  { code: "AT", name: "Austria", flag: "\u{1F1E6}\u{1F1F9}" },
  { code: "AZ", name: "Azerbaijan", flag: "\u{1F1E6}\u{1F1FF}" },
  { code: "BS", name: "Bahamas", flag: "\u{1F1E7}\u{1F1F8}" },
  { code: "BH", name: "Bahrain", flag: "\u{1F1E7}\u{1F1ED}" },
  { code: "BD", name: "Bangladesh", flag: "\u{1F1E7}\u{1F1E9}" },
  { code: "BB", name: "Barbados", flag: "\u{1F1E7}\u{1F1E7}" },
  { code: "BY", name: "Belarus", flag: "\u{1F1E7}\u{1F1FE}" },
  { code: "BE", name: "Belgium", flag: "\u{1F1E7}\u{1F1EA}" },
  { code: "BZ", name: "Belize", flag: "\u{1F1E7}\u{1F1FF}" },
  { code: "BJ", name: "Benin", flag: "\u{1F1E7}\u{1F1EF}" },
  { code: "BT", name: "Bhutan", flag: "\u{1F1E7}\u{1F1F9}" },
  { code: "BO", name: "Bolivia", flag: "\u{1F1E7}\u{1F1F4}" },
  { code: "BA", name: "Bosnia and Herzegovina", flag: "\u{1F1E7}\u{1F1E6}" },
  { code: "BW", name: "Botswana", flag: "\u{1F1E7}\u{1F1FC}" },
  { code: "BR", name: "Brazil", flag: "\u{1F1E7}\u{1F1F7}" },
  { code: "BN", name: "Brunei", flag: "\u{1F1E7}\u{1F1F3}" },
  { code: "BG", name: "Bulgaria", flag: "\u{1F1E7}\u{1F1EC}" },
  { code: "BF", name: "Burkina Faso", flag: "\u{1F1E7}\u{1F1EB}" },
  { code: "BI", name: "Burundi", flag: "\u{1F1E7}\u{1F1EE}" },
  { code: "KH", name: "Cambodia", flag: "\u{1F1F0}\u{1F1ED}" },
  { code: "CM", name: "Cameroon", flag: "\u{1F1E8}\u{1F1F2}" },
  { code: "CA", name: "Canada", flag: "\u{1F1E8}\u{1F1E6}" },
  { code: "CV", name: "Cape Verde", flag: "\u{1F1E8}\u{1F1FB}" },
  { code: "CF", name: "Central African Republic", flag: "\u{1F1E8}\u{1F1EB}" },
  { code: "TD", name: "Chad", flag: "\u{1F1F9}\u{1F1E9}" },
  { code: "CL", name: "Chile", flag: "\u{1F1E8}\u{1F1F1}" },
  { code: "CN", name: "China", flag: "\u{1F1E8}\u{1F1F3}" },
  { code: "CO", name: "Colombia", flag: "\u{1F1E8}\u{1F1F4}" },
  { code: "KM", name: "Comoros", flag: "\u{1F1F0}\u{1F1F2}" },
  { code: "CG", name: "Congo", flag: "\u{1F1E8}\u{1F1EC}" },
  { code: "CR", name: "Costa Rica", flag: "\u{1F1E8}\u{1F1F7}" },
  { code: "HR", name: "Croatia", flag: "\u{1F1ED}\u{1F1F7}" },
  { code: "CU", name: "Cuba", flag: "\u{1F1E8}\u{1F1FA}" },
  { code: "CY", name: "Cyprus", flag: "\u{1F1E8}\u{1F1FE}" },
  { code: "CZ", name: "Czech Republic", flag: "\u{1F1E8}\u{1F1FF}" },
  { code: "DK", name: "Denmark", flag: "\u{1F1E9}\u{1F1F0}" },
  { code: "DJ", name: "Djibouti", flag: "\u{1F1E9}\u{1F1EF}" },
  { code: "DM", name: "Dominica", flag: "\u{1F1E9}\u{1F1F2}" },
  { code: "DO", name: "Dominican Republic", flag: "\u{1F1E9}\u{1F1F4}" },
  { code: "TL", name: "East Timor", flag: "\u{1F1F9}\u{1F1F1}" },
  { code: "EC", name: "Ecuador", flag: "\u{1F1EA}\u{1F1E8}" },
  { code: "EG", name: "Egypt", flag: "\u{1F1EA}\u{1F1EC}" },
  { code: "SV", name: "El Salvador", flag: "\u{1F1F8}\u{1F1FB}" },
  { code: "GQ", name: "Equatorial Guinea", flag: "\u{1F1EC}\u{1F1F6}" },
  { code: "ER", name: "Eritrea", flag: "\u{1F1EA}\u{1F1F7}" },
  { code: "EE", name: "Estonia", flag: "\u{1F1EA}\u{1F1EA}" },
  { code: "SZ", name: "Eswatini", flag: "\u{1F1F8}\u{1F1FF}" },
  { code: "ET", name: "Ethiopia", flag: "\u{1F1EA}\u{1F1F9}" },
  { code: "FJ", name: "Fiji", flag: "\u{1F1EB}\u{1F1EF}" },
  { code: "FI", name: "Finland", flag: "\u{1F1EB}\u{1F1EE}" },
  { code: "FR", name: "France", flag: "\u{1F1EB}\u{1F1F7}" },
  { code: "GA", name: "Gabon", flag: "\u{1F1EC}\u{1F1E6}" },
  { code: "GM", name: "Gambia", flag: "\u{1F1EC}\u{1F1F2}" },
  { code: "GE", name: "Georgia", flag: "\u{1F1EC}\u{1F1EA}" },
  { code: "DE", name: "Germany", flag: "\u{1F1E9}\u{1F1EA}" },
  { code: "GH", name: "Ghana", flag: "\u{1F1EC}\u{1F1ED}" },
  { code: "GR", name: "Greece", flag: "\u{1F1EC}\u{1F1F7}" },
  { code: "GD", name: "Grenada", flag: "\u{1F1EC}\u{1F1E9}" },
  { code: "GT", name: "Guatemala", flag: "\u{1F1EC}\u{1F1F9}" },
  { code: "GN", name: "Guinea", flag: "\u{1F1EC}\u{1F1F3}" },
  { code: "GW", name: "Guinea-Bissau", flag: "\u{1F1EC}\u{1F1FC}" },
  { code: "GY", name: "Guyana", flag: "\u{1F1EC}\u{1F1FE}" },
  { code: "HT", name: "Haiti", flag: "\u{1F1ED}\u{1F1F9}" },
  { code: "HN", name: "Honduras", flag: "\u{1F1ED}\u{1F1F3}" },
  { code: "HK", name: "Hong Kong", flag: "\u{1F1ED}\u{1F1F0}" },
  { code: "HU", name: "Hungary", flag: "\u{1F1ED}\u{1F1FA}" },
  { code: "IS", name: "Iceland", flag: "\u{1F1EE}\u{1F1F8}" },
  { code: "IN", name: "India", flag: "\u{1F1EE}\u{1F1F3}" },
  { code: "ID", name: "Indonesia", flag: "\u{1F1EE}\u{1F1E9}" },
  { code: "IR", name: "Iran", flag: "\u{1F1EE}\u{1F1F7}" },
  { code: "IQ", name: "Iraq", flag: "\u{1F1EE}\u{1F1F6}" },
  { code: "IE", name: "Ireland", flag: "\u{1F1EE}\u{1F1EA}" },
  { code: "IL", name: "Israel", flag: "\u{1F1EE}\u{1F1F1}" },
  { code: "IT", name: "Italy", flag: "\u{1F1EE}\u{1F1F9}" },
  { code: "JM", name: "Jamaica", flag: "\u{1F1EF}\u{1F1F2}" },
  { code: "JP", name: "Japan", flag: "\u{1F1EF}\u{1F1F5}" },
  { code: "JO", name: "Jordan", flag: "\u{1F1EF}\u{1F1F4}" },
  { code: "KZ", name: "Kazakhstan", flag: "\u{1F1F0}\u{1F1FF}" },
  { code: "KE", name: "Kenya", flag: "\u{1F1F0}\u{1F1EA}" },
  { code: "KI", name: "Kiribati", flag: "\u{1F1F0}\u{1F1EE}" },
  { code: "XK", name: "Kosovo", flag: "\u{1F1FD}\u{1F1F0}" },
  { code: "KW", name: "Kuwait", flag: "\u{1F1F0}\u{1F1FC}" },
  { code: "KG", name: "Kyrgyzstan", flag: "\u{1F1F0}\u{1F1EC}" },
  { code: "LA", name: "Laos", flag: "\u{1F1F1}\u{1F1E6}" },
  { code: "LV", name: "Latvia", flag: "\u{1F1F1}\u{1F1FB}" },
  { code: "LB", name: "Lebanon", flag: "\u{1F1F1}\u{1F1E7}" },
  { code: "LS", name: "Lesotho", flag: "\u{1F1F1}\u{1F1F8}" },
  { code: "LR", name: "Liberia", flag: "\u{1F1F1}\u{1F1F7}" },
  { code: "LY", name: "Libya", flag: "\u{1F1F1}\u{1F1FE}" },
  { code: "LI", name: "Liechtenstein", flag: "\u{1F1F1}\u{1F1EE}" },
  { code: "LT", name: "Lithuania", flag: "\u{1F1F1}\u{1F1F9}" },
  { code: "LU", name: "Luxembourg", flag: "\u{1F1F1}\u{1F1FA}" },
  { code: "MG", name: "Madagascar", flag: "\u{1F1F2}\u{1F1EC}" },
  { code: "MW", name: "Malawi", flag: "\u{1F1F2}\u{1F1FC}" },
  { code: "MY", name: "Malaysia", flag: "\u{1F1F2}\u{1F1FE}" },
  { code: "MV", name: "Maldives", flag: "\u{1F1F2}\u{1F1FB}" },
  { code: "ML", name: "Mali", flag: "\u{1F1F2}\u{1F1F1}" },
  { code: "MT", name: "Malta", flag: "\u{1F1F2}\u{1F1F9}" },
  { code: "MH", name: "Marshall Islands", flag: "\u{1F1F2}\u{1F1ED}" },
  { code: "MR", name: "Mauritania", flag: "\u{1F1F2}\u{1F1F7}" },
  { code: "MU", name: "Mauritius", flag: "\u{1F1F2}\u{1F1FA}" },
  { code: "MX", name: "Mexico", flag: "\u{1F1F2}\u{1F1FD}" },
  { code: "FM", name: "Micronesia", flag: "\u{1F1EB}\u{1F1F2}" },
  { code: "MD", name: "Moldova", flag: "\u{1F1F2}\u{1F1E9}" },
  { code: "MC", name: "Monaco", flag: "\u{1F1F2}\u{1F1E8}" },
  { code: "MN", name: "Mongolia", flag: "\u{1F1F2}\u{1F1F3}" },
  { code: "ME", name: "Montenegro", flag: "\u{1F1F2}\u{1F1EA}" },
  { code: "MA", name: "Morocco", flag: "\u{1F1F2}\u{1F1E6}" },
  { code: "MZ", name: "Mozambique", flag: "\u{1F1F2}\u{1F1FF}" },
  { code: "MM", name: "Myanmar", flag: "\u{1F1F2}\u{1F1F2}" },
  { code: "NA", name: "Namibia", flag: "\u{1F1F3}\u{1F1E6}" },
  { code: "NR", name: "Nauru", flag: "\u{1F1F3}\u{1F1F7}" },
  { code: "NP", name: "Nepal", flag: "\u{1F1F3}\u{1F1F5}" },
  { code: "NL", name: "Netherlands", flag: "\u{1F1F3}\u{1F1F1}" },
  { code: "NZ", name: "New Zealand", flag: "\u{1F1F3}\u{1F1FF}" },
  { code: "NI", name: "Nicaragua", flag: "\u{1F1F3}\u{1F1EE}" },
  { code: "NE", name: "Niger", flag: "\u{1F1F3}\u{1F1EA}" },
  { code: "NG", name: "Nigeria", flag: "\u{1F1F3}\u{1F1EC}" },
  { code: "KP", name: "North Korea", flag: "\u{1F1F0}\u{1F1F5}" },
  { code: "MK", name: "North Macedonia", flag: "\u{1F1F2}\u{1F1F0}" },
  { code: "NO", name: "Norway", flag: "\u{1F1F3}\u{1F1F4}" },
  { code: "OM", name: "Oman", flag: "\u{1F1F4}\u{1F1F2}" },
  { code: "PK", name: "Pakistan", flag: "\u{1F1F5}\u{1F1F0}" },
  { code: "PW", name: "Palau", flag: "\u{1F1F5}\u{1F1FC}" },
  { code: "PS", name: "Palestine", flag: "\u{1F1F5}\u{1F1F8}" },
  { code: "PA", name: "Panama", flag: "\u{1F1F5}\u{1F1E6}" },
  { code: "PG", name: "Papua New Guinea", flag: "\u{1F1F5}\u{1F1EC}" },
  { code: "PY", name: "Paraguay", flag: "\u{1F1F5}\u{1F1FE}" },
  { code: "PE", name: "Peru", flag: "\u{1F1F5}\u{1F1EA}" },
  { code: "PH", name: "Philippines", flag: "\u{1F1F5}\u{1F1ED}" },
  { code: "PL", name: "Poland", flag: "\u{1F1F5}\u{1F1F1}" },
  { code: "PT", name: "Portugal", flag: "\u{1F1F5}\u{1F1F9}" },
  { code: "QA", name: "Qatar", flag: "\u{1F1F6}\u{1F1E6}" },
  { code: "RO", name: "Romania", flag: "\u{1F1F7}\u{1F1F4}" },
  { code: "RU", name: "Russia", flag: "\u{1F1F7}\u{1F1FA}" },
  { code: "RW", name: "Rwanda", flag: "\u{1F1F7}\u{1F1FC}" },
  { code: "KN", name: "Saint Kitts and Nevis", flag: "\u{1F1F0}\u{1F1F3}" },
  { code: "LC", name: "Saint Lucia", flag: "\u{1F1F1}\u{1F1E8}" },
  { code: "VC", name: "Saint Vincent and the Grenadines", flag: "\u{1F1FB}\u{1F1E8}" },
  { code: "WS", name: "Samoa", flag: "\u{1F1FC}\u{1F1F8}" },
  { code: "SM", name: "San Marino", flag: "\u{1F1F8}\u{1F1F2}" },
  { code: "SA", name: "Saudi Arabia", flag: "\u{1F1F8}\u{1F1E6}" },
  { code: "SN", name: "Senegal", flag: "\u{1F1F8}\u{1F1F3}" },
  { code: "RS", name: "Serbia", flag: "\u{1F1F7}\u{1F1F8}" },
  { code: "SC", name: "Seychelles", flag: "\u{1F1F8}\u{1F1E8}" },
  { code: "SL", name: "Sierra Leone", flag: "\u{1F1F8}\u{1F1F1}" },
  { code: "SG", name: "Singapore", flag: "\u{1F1F8}\u{1F1EC}" },
  { code: "SK", name: "Slovakia", flag: "\u{1F1F8}\u{1F1F0}" },
  { code: "SI", name: "Slovenia", flag: "\u{1F1F8}\u{1F1EE}" },
  { code: "SB", name: "Solomon Islands", flag: "\u{1F1F8}\u{1F1E7}" },
  { code: "SO", name: "Somalia", flag: "\u{1F1F8}\u{1F1F4}" },
  { code: "ZA", name: "South Africa", flag: "\u{1F1FF}\u{1F1E6}" },
  { code: "KR", name: "South Korea", flag: "\u{1F1F0}\u{1F1F7}" },
  { code: "SS", name: "South Sudan", flag: "\u{1F1F8}\u{1F1F8}" },
  { code: "ES", name: "Spain", flag: "\u{1F1EA}\u{1F1F8}" },
  { code: "LK", name: "Sri Lanka", flag: "\u{1F1F1}\u{1F1F0}" },
  { code: "SD", name: "Sudan", flag: "\u{1F1F8}\u{1F1E9}" },
  { code: "SR", name: "Suriname", flag: "\u{1F1F8}\u{1F1F7}" },
  { code: "SE", name: "Sweden", flag: "\u{1F1F8}\u{1F1EA}" },
  { code: "CH", name: "Switzerland", flag: "\u{1F1E8}\u{1F1ED}" },
  { code: "SY", name: "Syria", flag: "\u{1F1F8}\u{1F1FE}" },
  { code: "TW", name: "Taiwan", flag: "\u{1F1F9}\u{1F1FC}" },
  { code: "TJ", name: "Tajikistan", flag: "\u{1F1F9}\u{1F1EF}" },
  { code: "TZ", name: "Tanzania", flag: "\u{1F1F9}\u{1F1FF}" },
  { code: "TH", name: "Thailand", flag: "\u{1F1F9}\u{1F1ED}" },
  { code: "TG", name: "Togo", flag: "\u{1F1F9}\u{1F1EC}" },
  { code: "TO", name: "Tonga", flag: "\u{1F1F9}\u{1F1F4}" },
  { code: "TT", name: "Trinidad and Tobago", flag: "\u{1F1F9}\u{1F1F9}" },
  { code: "TN", name: "Tunisia", flag: "\u{1F1F9}\u{1F1F3}" },
  { code: "TR", name: "Turkey", flag: "\u{1F1F9}\u{1F1F7}" },
  { code: "TM", name: "Turkmenistan", flag: "\u{1F1F9}\u{1F1F2}" },
  { code: "TV", name: "Tuvalu", flag: "\u{1F1F9}\u{1F1FB}" },
  { code: "UG", name: "Uganda", flag: "\u{1F1FA}\u{1F1EC}" },
  { code: "UA", name: "Ukraine", flag: "\u{1F1FA}\u{1F1E6}" },
  { code: "AE", name: "United Arab Emirates", flag: "\u{1F1E6}\u{1F1EA}" },
  { code: "GB", name: "United Kingdom", flag: "\u{1F1EC}\u{1F1E7}" },
  { code: "US", name: "United States", flag: "\u{1F1FA}\u{1F1F8}" },
  { code: "UY", name: "Uruguay", flag: "\u{1F1FA}\u{1F1FE}" },
  { code: "UZ", name: "Uzbekistan", flag: "\u{1F1FA}\u{1F1FF}" },
  { code: "VU", name: "Vanuatu", flag: "\u{1F1FB}\u{1F1FA}" },
  { code: "VA", name: "Vatican City", flag: "\u{1F1FB}\u{1F1E6}" },
  { code: "VE", name: "Venezuela", flag: "\u{1F1FB}\u{1F1EA}" },
  { code: "VN", name: "Vietnam", flag: "\u{1F1FB}\u{1F1F3}" },
  { code: "YE", name: "Yemen", flag: "\u{1F1FE}\u{1F1EA}" },
  { code: "ZM", name: "Zambia", flag: "\u{1F1FF}\u{1F1F2}" },
  { code: "ZW", name: "Zimbabwe", flag: "\u{1F1FF}\u{1F1FC}" },
  { code: "AG", name: "Antigua and Barbuda", flag: countryFlag("AG") },
  { code: "AI", name: "Anguilla", flag: countryFlag("AI") },
  { code: "AQ", name: "Antarctica", flag: countryFlag("AQ") },
  { code: "AS", name: "American Samoa", flag: countryFlag("AS") },
  { code: "AW", name: "Aruba", flag: countryFlag("AW") },
  { code: "AX", name: "Åland Islands", flag: countryFlag("AX") },
  { code: "BL", name: "Saint Barthélemy", flag: countryFlag("BL") },
  { code: "BM", name: "Bermuda", flag: countryFlag("BM") },
  { code: "BQ", name: "Caribbean Netherlands", flag: countryFlag("BQ") },
  { code: "BV", name: "Bouvet Island", flag: countryFlag("BV") },
  { code: "CC", name: "Cocos (Keeling) Islands", flag: countryFlag("CC") },
  { code: "CD", name: "Democratic Republic of the Congo", flag: countryFlag("CD") },
  { code: "CI", name: "Côte d’Ivoire", flag: countryFlag("CI") },
  { code: "CK", name: "Cook Islands", flag: countryFlag("CK") },
  { code: "CW", name: "Curaçao", flag: countryFlag("CW") },
  { code: "CX", name: "Christmas Island", flag: countryFlag("CX") },
  { code: "EH", name: "Western Sahara", flag: countryFlag("EH") },
  { code: "FK", name: "Falkland Islands", flag: countryFlag("FK") },
  { code: "FO", name: "Faroe Islands", flag: countryFlag("FO") },
  { code: "GF", name: "French Guiana", flag: countryFlag("GF") },
  { code: "GG", name: "Guernsey", flag: countryFlag("GG") },
  { code: "GI", name: "Gibraltar", flag: countryFlag("GI") },
  { code: "GL", name: "Greenland", flag: countryFlag("GL") },
  { code: "GP", name: "Guadeloupe", flag: countryFlag("GP") },
  {
    code: "GS",
    name: "South Georgia and the South Sandwich Islands",
    flag: countryFlag("GS"),
  },
  { code: "GU", name: "Guam", flag: countryFlag("GU") },
  { code: "HM", name: "Heard Island and McDonald Islands", flag: countryFlag("HM") },
  { code: "IM", name: "Isle of Man", flag: countryFlag("IM") },
  { code: "IO", name: "British Indian Ocean Territory", flag: countryFlag("IO") },
  { code: "JE", name: "Jersey", flag: countryFlag("JE") },
  { code: "KY", name: "Cayman Islands", flag: countryFlag("KY") },
  { code: "MF", name: "Saint Martin", flag: countryFlag("MF") },
  { code: "MO", name: "Macao", flag: countryFlag("MO") },
  { code: "MP", name: "Northern Mariana Islands", flag: countryFlag("MP") },
  { code: "MQ", name: "Martinique", flag: countryFlag("MQ") },
  { code: "MS", name: "Montserrat", flag: countryFlag("MS") },
  { code: "NC", name: "New Caledonia", flag: countryFlag("NC") },
  { code: "NF", name: "Norfolk Island", flag: countryFlag("NF") },
  { code: "NU", name: "Niue", flag: countryFlag("NU") },
  { code: "PF", name: "French Polynesia", flag: countryFlag("PF") },
  { code: "PM", name: "Saint Pierre and Miquelon", flag: countryFlag("PM") },
  { code: "PN", name: "Pitcairn Islands", flag: countryFlag("PN") },
  { code: "PR", name: "Puerto Rico", flag: countryFlag("PR") },
  { code: "RE", name: "Réunion", flag: countryFlag("RE") },
  { code: "SH", name: "Saint Helena", flag: countryFlag("SH") },
  { code: "SJ", name: "Svalbard and Jan Mayen", flag: countryFlag("SJ") },
  { code: "ST", name: "São Tomé and Príncipe", flag: countryFlag("ST") },
  { code: "SX", name: "Sint Maarten", flag: countryFlag("SX") },
  { code: "TC", name: "Turks and Caicos Islands", flag: countryFlag("TC") },
  { code: "TF", name: "French Southern Territories", flag: countryFlag("TF") },
  { code: "TK", name: "Tokelau", flag: countryFlag("TK") },
  { code: "UM", name: "U.S. Minor Outlying Islands", flag: countryFlag("UM") },
  { code: "VG", name: "British Virgin Islands", flag: countryFlag("VG") },
  { code: "VI", name: "U.S. Virgin Islands", flag: countryFlag("VI") },
  { code: "WF", name: "Wallis and Futuna", flag: countryFlag("WF") },
  { code: "YT", name: "Mayotte", flag: countryFlag("YT") },
].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

export const POPULAR_COUNTRY_CODES = ["ID", "US", "GB", "DE", "FR", "AU", "SG", "TH", "JP"];

const SPECIAL_NATIONALITIES: readonly CountryOption[] = [
  { code: "XS", name: "Stateless", flag: "🏳️" },
  { code: "XX", name: "Unknown", flag: "❔" },
];

export const NATIONALITY_OPTIONS: readonly CountryOption[] = [
  ...COUNTRY_OPTIONS,
  ...SPECIAL_NATIONALITIES,
].sort((left, right) => left.name.localeCompare(right.name));

const NATIONALITY_BY_CODE = new Map(NATIONALITY_OPTIONS.map((option) => [option.code, option]));
const NATIONALITY_BY_NAME = new Map(
  NATIONALITY_OPTIONS.map((option) => [normalizedNationalityName(option.name), option.code]),
);
const NATIONALITY_ALIASES = new Map([
  ["america", "US"],
  ["dutch", "NL"],
  ["great britain", "GB"],
  ["holland", "NL"],
  ["the netherlands", "NL"],
  ["uk", "GB"],
  ["unknown nationality", "XX"],
  ["us", "US"],
  ["usa", "US"],
]);

export function normalizeNationalityCode(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  const code = input.toUpperCase();
  if (NATIONALITY_BY_CODE.has(code)) return code;
  const name = normalizedNationalityName(input);
  return NATIONALITY_ALIASES.get(name) ?? NATIONALITY_BY_NAME.get(name) ?? null;
}

export function nationalityOption(value: string | null | undefined): CountryOption | null {
  const code = normalizeNationalityCode(value);
  return code ? (NATIONALITY_BY_CODE.get(code) ?? null) : null;
}

export function nationalityLabel(value: string | null | undefined): string | null {
  return nationalityOption(value)?.name ?? null;
}

export function nationalityInputLabel(value: string | null | undefined): string {
  return nationalityLabel(value) ?? value?.trim() ?? "";
}

export function nationalityDisplayLabel(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  return nationalityLabel(input) ?? `${input} · Needs review`;
}

function normalizedNationalityName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
