/** Compiled CSS is committed at ../app/static/css/app.css; run `npm run build` after changing classes. */
module.exports = {
  content: ["../app/templates/**/*.html", "../app/static/js/**/*.js"],
  theme: {
    extend: {
      fontFamily: { sans: ["Plus Jakarta Sans", "ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"] },
      colors: {
        brand: {
          50: "#f0f6ff", 100: "#e0edff", 200: "#bfdbfe", 300: "#93c5fd", 400: "#60a5fa",
          500: "#3b82f6", 600: "#2563eb", 700: "#1d4ed8", 800: "#1e40af", 900: "#1e3a8a", 950: "#172554",
        },
      },
    },
  },
};
