import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0b0c0f',
          panel: '#13151a',
          card: '#1a1d24',
          hover: '#22262e',
        },
        border: {
          subtle: '#2a2e38',
          strong: '#3a3f4d',
        },
        text: {
          primary: '#e8eaed',
          secondary: '#a8adb8',
          muted: '#6b6f7a',
        },
        accent: {
          blue: '#5b8def',
          green: '#3eb573',
          orange: '#f08a3e',
          red: '#e85a5a',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'monospace'],
      },
      animation: {
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
