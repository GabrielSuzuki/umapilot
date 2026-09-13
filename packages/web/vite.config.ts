import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The web app lives inside the monorepo and imports the engine as SOURCE, not as
 * a built package. That is deliberate: there is no build step between changing
 * `planner/index.ts` and seeing the recommendation change, which is the whole
 * point of keeping the UI in the same repo as the model.
 *
 * `fs.allow` reaches up to the repo root because two things live outside this
 * package and must not be copied into it: the generated dataset (gitignored --
 * it is the player's own game data, extracted from their master.mdb) and
 * `examples/`. Copying either would put game data somewhere it does not belong.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
  build: { target: "es2022", outDir: "dist" },
});
