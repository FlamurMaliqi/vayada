/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/feature-hub/src/**/*.{js,ts,jsx,tsx}",
    "../../packages/product-onboarding/src/**/*.{js,ts,jsx,tsx}",
    "../../packages/settings-ui/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "var(--color-primary-50, #EFF2FF)",
          100: "var(--color-primary-100, #DFE5FF)",
          200: "var(--color-primary-200, #BFCBFF)",
          300: "var(--color-primary-300, #9FB1FF)",
          400: "var(--color-primary-400, #5F7FFF)",
          500: "var(--color-primary-500, #2F52F5)",
          600: "var(--color-primary-600, #1E3EDB)",
          700: "var(--color-primary-700, #162FB8)",
          800: "var(--color-primary-800, #0F2095)",
          900: "var(--color-primary-900, #081172)",
        },
      },
    },
  },
  plugins: [],
};
