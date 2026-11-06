import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const emotesPath = fileURLToPath(
  new URL("./.cache/emotes/runtime.json", import.meta.url),
);

export default defineConfig({
  root: ".",
  publicDir: false,
  plugins: [
    {
      name: "local-native-emotes",
      resolveId(id) {
        if (id === "virtual:native-emotes") return "\0virtual:native-emotes";
      },
      load(id) {
        if (id !== "\0virtual:native-emotes") return;
        this.addWatchFile(emotesPath);
        if (!existsSync(emotesPath)) {
          this.warn(
            "Native emotes unavailable. Run python3 tools/import-emotes.py before filming emotes.",
          );
          return "export default {schemaVersion: 1, emotes: []};";
        }
        const dataset = JSON.parse(readFileSync(emotesPath, "utf8"));
        // Provenance stays in the local dataset, not in the browser bundle.
        return `export default ${JSON.stringify({
          schemaVersion: dataset.schemaVersion,
          emotes: dataset.emotes.map(
            ({
              id,
              animationName,
              document,
            }: {
              id: string;
              animationName: string;
              document: unknown;
            }) => ({ id, animationName, document }),
          ),
        })};`;
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
});
