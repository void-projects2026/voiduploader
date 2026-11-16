/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: '#0b0e14',
        panel: '#0f131b',
        card: '#131722',
        border: '#1c2230',
        accent: '#3b82f6',
      },
    },
  },
  plugins: [],
};
