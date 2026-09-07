import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#08090c",
          900: "#0d0f14",
          850: "#12151c",
          800: "#181c25",
          700: "#232833",
          600: "#333a48",
        },
        accent: {
          DEFAULT: "#4ade80",
          dim: "#22c55e",
        },
        signal: "#60a5fa",
        warn: "#fbbf24",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "Segoe UI", "Inter", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
