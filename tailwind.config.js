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
        danger: { DEFAULT: v('danger'), bg: v('danger-bg') },
        warn: v('warn'),
        star: v('star'),
        control: v('control'),
        'hist-bg': v('hist-bg'),
        success: { DEFAULT: v('success'), bg: v('success-bg') },
        info: { DEFAULT: v('info'), bg: v('info-bg') },
        thumb: { DEFAULT: v('thumb'), edge: v('thumb-edge') },
      },
      // 2xs (11 px) is the smallest size for interface text; xs (12 px) for help text and hints.
      fontSize: { '2xs': ['11px', '16px'] },
    },
  },
  plugins: [],
};
