export const BOOKING_PAGE_COLOR_PRESETS = [
  { name: "Ocean Blue", primary: "#0077B6" },
  { name: "Tropical Gold", primary: "#D4A017" },
  { name: "Forest Green", primary: "#2D6A4F" },
  { name: "Sunset Coral", primary: "#E76F51" },
  { name: "Royal Purple", primary: "#7B2D8E" },
  { name: "Charcoal", primary: "#2D3436" },
] as const;

export const BOOKING_PAGE_FONT_STYLESHEET_URL =
  "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,700;1,400&family=Cinzel:wght@400;600;700&family=Italiana&display=swap";

export const BOOKING_PAGE_FONT_PAIRINGS = [
  {
    id: "high-end-serif",
    name: "High-end Serif",
    fonts: "Playfair Display + Source Sans Pro",
    preview: "Elegant & Timeless",
    headingFamily: "'Playfair Display', serif",
    bodyFamily: "'Source Sans Pro', sans-serif",
  },
  {
    id: "modern-minimalist",
    name: "Modern Minimalist",
    fonts: "Inter + Inter",
    preview: "Clean & Contemporary",
    headingFamily: "'Inter', sans-serif",
    bodyFamily: "'Inter', sans-serif",
  },
  {
    id: "grand-classic",
    name: "Grand Classic",
    fonts: "Lora + Source Sans Pro",
    preview: "Stately & Readable",
    headingFamily: "'Lora', serif",
    bodyFamily: "'Source Sans Pro', sans-serif",
  },
  {
    id: "imperial-serif",
    name: "Imperial Serif",
    fonts: "Cinzel + Source Sans Pro",
    preview: "Monumental & Refined",
    headingFamily: "'Cinzel', serif",
    bodyFamily: "'Source Sans Pro', sans-serif",
  },
  {
    id: "italiana-serif",
    name: "Italiana Serif",
    fonts: "Italiana + Source Sans Pro",
    preview: "Refined & Airy",
    headingFamily: "'Italiana', serif",
    bodyFamily: "'Source Sans Pro', sans-serif",
  },
] as const;

export type ColorPreset = { name: string; primary: string; accent?: string };
export type FontPairing = {
  id: string;
  name: string;
  fonts: string;
  preview: string;
  headingFamily: string;
  bodyFamily: string;
};
