import vinext from "vinext";
import { nitro } from "nitro/vite";
import { defineConfig, type UserConfig } from "vite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hostingConfig from "./.openai/hosting.json";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async (): Promise<UserConfig> => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const isVercelBuild =
    process.env.VERCEL === "1" || process.env.NITRO_PRESET === "vercel";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const cloudflare = isVercelBuild
    ? null
    : (await import("@cloudflare/vite-plugin")).cloudflare;

  return {
    // Vite 8 / Rolldown changed CJS default-export interop, which makes
    // react-server-dom-webpack (RSC runtime) emit a duplicate `default` export
    // during dep optimization and hard-crash the dev server. Restoring the
    // previous (pre-Vite-8) interop behaviour is the documented escape hatch
    // for this class of error. Deprecated but safe to keep until plugin-rsc
    // ships a Rolldown-compatible release.
    legacy: {
      inconsistentCjsInterop: true,
    },
    // In demo mode (HERMES_TUNNEL=1) point Vite's cache into os.tmpdir() so that
    // dependency re-optimization cleanup hits a path the sandbox's safe-delete
    // shim allows for native deletion (node_modules/.vite is not whitelisted and
    // would otherwise crash the dev server on startup).
    cacheDir:
      process.env.HERMES_TUNNEL === "1"
        ? join(tmpdir(), "hermes-vite-cache")
        : undefined,
    // Vite 8 / Rolldown's commonjs interop mis-transforms react-server-dom-webpack
    // (RSC runtime) and emits a duplicate `default` export, which hard-crashes the
    // dev server. Excluding it from pre-bundling (in BOTH the default and the rsc
    // environment, since @vitejs/plugin-rsc defines its own per-env optimizeDeps)
    // lets the RSC server require the CJS module directly instead of through the
    // buggy optimizer.
    optimizeDeps: {
      exclude: ["react-server-dom-webpack"],
    },
    environments: {
      rsc: {
        optimizeDeps: {
          exclude: ["react-server-dom-webpack"],
        },
      },
    },
    server: {
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
      // Allow the public cloudflared tunnel host only when HERMES_TUNNEL=1 (demo only).
      ...(process.env.HERMES_TUNNEL === "1" ? { allowedHosts: true } : {}),
    },
    plugins: isVercelBuild
      ? [vinext(), nitro()]
      : [
          vinext(),
          cloudflare!({
            viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
            config: localBindingConfig,
          }),
        ],
  };
});
