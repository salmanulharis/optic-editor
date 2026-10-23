/** @type {import('tailwindcss').Config} */
// Colours are theme tokens (CSS variables, see src/index.css): dark, darker and light-neutral grey.
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: v('app'),
        panel: v('panel'),
        line: v('line'),
        ink: { DEFAULT: v('ink'), dim: v('ink-dim'), faint: v('ink-faint') },
        strong: v('strong'),
        raise: v('raise'),
        sunk: v('sunk'),
        hover: v('hover'),
        active: v('active'),
        edge: v('edge'),
        accent: { DEFAULT: v('accent'), hi: v('accent-hi') },
        'on-accent': v('on-accent'),
        meter: v('meter'),
      },
      fontSize: { xxs: ['10px', '14px'] },
    },
  },
  plugins: [],
};
