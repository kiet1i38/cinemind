/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./public/index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        cinema: {
          ink: "#090909",
          panel: "#141414",
          elevated: "#1d1d1d",
          red: "#e50914",
          redDeep: "#b20710",
          text: "#f5f5f1",
          muted: "#a3a3a3"
        }
      },
      boxShadow: {
        cinema: "0 24px 70px rgba(0, 0, 0, 0.42)",
        card: "0 14px 32px rgba(0, 0, 0, 0.26)"
      }
    }
  },
  plugins: []
};
