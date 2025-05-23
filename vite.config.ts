import { sync } from "glob";
import tailwindcss from "@tailwindcss/vite";
export default {
  root: "./src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollUpOptions: {
      input: sync("./src/**/*.html".replace(/\\/g, "/")),
    },
  },
  plugins: [tailwindcss()],
};
