import react from "@vitejs/plugin-react-swc";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getProperties } from "properties-file";
import { defineConfig } from "vitest/config";
import dts from "vite-plugin-dts";

export default defineConfig(() => {
  const library = process.env.LIB === "true";
  const messages = new URL("./messages/", import.meta.url);

  return {
    plugins: [
      react(),
      library
        ? dts({ insertTypesEntry: true })
        : {
            name: "admin-console-messages",
            generateBundle() {
              for (const file of readdirSync(messages)) {
                const match = /^messages_([\w]+)\.properties$/.exec(file);
                if (!match) continue;
                const locale = match[1].replaceAll("_", "-");
                const properties = getProperties(
                  readFileSync(new URL(file, messages)),
                );
                this.emitFile({
                  type: "asset",
                  fileName: `messages/${locale}.json`,
                  source: JSON.stringify(properties),
                });
              }
            },
          },
    ],
    build: {
      target: "esnext",
      ...(library && {
        lib: {
          entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
          formats: ["es"],
        },
        outDir: "lib",
        rollupOptions: {
          external: [
            "react",
            "react/jsx-runtime",
            "react-dom",
            "react-router-dom",
            "react-i18next",
          ],
        },
      }),
    },
    test: {
      watch: false,
      environment: "jsdom",
      exclude: ["**/node_modules/**", "**/dist/**", "test/**", "scripts/**"],
      server: {
        deps: {
          inline: [/@patternfly\/.*/],
        },
      },
    },
  };
});
