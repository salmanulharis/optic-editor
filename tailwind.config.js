/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: '#1c1c1c',
        panel: '#262626',
        line: '#333333',
        ink: { DEFAULT: '#d4d4d4', dim: '#8a8a8a', faint: '#5c5c5c' },
      },
      fontSize: { xxs: ['10px', '14px'] },
    },
  },
  plugins: [],
};
