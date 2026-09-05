/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "../../packages/settings-ui/src/**/*.{js,ts,jsx,tsx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./services/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#EFF2FF",
          100: "#DFE5FF",
          200: "#BFCBFF",
          300: "#9FB1FF",
          400: "#5F7FFF",
          500: "#2F52F5",
          600: "#1E3EDB",
          700: "#162FB8",
          800: "#0F2095",
          900: "#081172",
        },
        success: {
          50: "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          500: "#22c55e",
          600: "#16a34a",
          700: "#15803d",
        },
        warning: {
          50: "#fffbeb",
          100: "#fef3c7",
          200: "#fde68a",
          500: "#f59e0b",
          600: "#d97706",
          700: "#b45309",
        },
        error: {
          50: "#fef2f2",
          100: "#fee2e2",
          500: "#ef4444",
          600: "#dc2626",
        },
        surface: {
          DEFAULT: "#f9f8f6",
          light: "#fafafa",
          dark: "#f5f5f4",
        },
        muted: {
          DEFAULT: "#64748b",
          light: "#94a3b8",
          dark: "#475569",
        },
      },
    },
  },
  plugins: [],
};
