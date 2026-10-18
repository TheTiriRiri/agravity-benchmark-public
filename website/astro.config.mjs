import {defineConfig} from "astro/config";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://agrav-bench.pages.dev",
  integrations: [react(), tailwind()],
  output: "static",
});
