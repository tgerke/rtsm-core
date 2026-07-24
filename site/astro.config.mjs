// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://tgerke.github.io",
  base: "/rtsm-core",
  integrations: [
    starlight({
      title: "rtsm-core",
      description:
        "An open-source Randomization and Trial Supply Management system where the blinding boundary is architectural: the master list lives in its own application and database, and assignments reach the EDC through the same public intake a commercial RTSM would use",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/tgerke/rtsm-core" }],
      sidebar: [
        { label: "Getting started", items: ["getting-started"] },
        { label: "Integration", items: ["list-format", "edc-delivery"] },
        { label: "Supply", items: ["kits-and-dispensing"] },
        { label: "Compliance", items: ["blinding", "audit"] },
      ],
    }),
  ],
});
