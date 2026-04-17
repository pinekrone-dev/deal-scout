/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace']
      },
      colors: {
        ink: {
          50: '#f6f7f9',
          100: '#eceef2',
          200: '#d5d9e1',
          300: '#b0b8c6',
          400: '#8591a5',
          500: '#697488',
          600: '#535c6e',
          700: '#424a59',
          800: '#363c48',
          900: '#24282f',
          950: '#16181d'
        },
        accent: {
          500: '#2563eb',
          600: '#1d4ed8'
        }
      }
    }
  },
  plugins: []
};
