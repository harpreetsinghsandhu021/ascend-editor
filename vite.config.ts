import { sync } from "glob";

export default {
  root: "./src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollUpOptions: {
      input: sync("./src/**/*.html".replace(/\\/g, "/")),
    },
  },
};
