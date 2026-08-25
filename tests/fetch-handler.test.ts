import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.js";
import { resolveRuntimeEntryModule } from "../packages/vinext/src/entries/runtime-entry-module.js";
import type { VinextOptions } from "../packages/vinext/src/index.js";

async function loadVirtualModule(
  root: string,
  id: string,
  options: {
    cache?: VinextOptions["cache"];
    cdn?: boolean;
    hostPluginName?: string;
  } = {},
): Promise<string> {
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      root,
      configFile: false,
      plugins: [
        vinext({ cache: options.cache ?? (options.cdn ? { cdn: cdnAdapter() } : undefined) }),
        ...(options.hostPluginName ? [{ name: options.hostPluginName }] : []),
      ],
      server: { port: 0 },
      logLevel: "silent",
    });

    const resolved = await server.pluginContainer.resolveId(id);
    expect(resolved?.id).toBe(`\0${id}`);

    const loaded = await server.pluginContainer.load(resolved!.id);
    return typeof loaded === "string" ? loaded : ((loaded as { code?: string })?.code ?? "");
  } finally {
    await server?.close();
  }
}

function loadUnifiedFetchHandler(
  root: string,
  options: Parameters<typeof loadVirtualModule>[2] = {},
): Promise<string> {
  return loadVirtualModule(root, "virtual:vinext-worker-entry", options);
}

async function resolveWithCdnOutput(root: string, id: string): Promise<string | undefined> {
  const server = await createServer({
    root,
    configFile: false,
    plugins: [vinext({ cache: { cdn: cdnAdapter() } }), { name: "vite-plugin-cloudflare" }],
    server: { port: 0 },
    logLevel: "silent",
  });
  try {
    return (await server.pluginContainer.resolveId(id))?.id;
  } finally {
    await server.close();
  }
}

describe("unified Cloudflare fetch handler", () => {
  it("delegates App Router apps to the App Router worker entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-fetch-handler-app-"));
    try {
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "app/page.tsx"),
        "export default function Page() { return <div>app</div>; }\n",
      );

      await expect(loadUnifiedFetchHandler(root)).resolves.toBe(
        'export { default } from "vinext/server/app-router-entry";',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("delegates Pages Router apps to the Pages Router worker entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-fetch-handler-pages-"));
    try {
      fs.mkdirSync(path.join(root, "pages"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "pages/index.tsx"),
        "export default function Page() { return <div>pages</div>; }\n",
      );

      await expect(loadUnifiedFetchHandler(root)).resolves.toBe(
        'export { default } from "vinext/server/pages-router-entry";',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the Cloudflare CDN adapter select its multi-stage Worker facade", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-fetch-handler-cdn-"));
    try {
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "app/page.tsx"),
        "export default function Page() { return <div>app</div>; }\n",
      );

      const descriptor = cdnAdapter();
      await expect(
        loadUnifiedFetchHandler(root, {
          cdn: true,
          hostPluginName: "vite-plugin-cloudflare",
        }),
      ).resolves.toBe(
        [
          `export { default } from ${JSON.stringify(descriptor.output.entry)};`,
          `export * from ${JSON.stringify(descriptor.output.entry)};`,
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["app-router-entry", "pages-router-entry"])(
    "routes a direct %s main through the selected safe facade",
    async (entry) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-direct-router-cdn-"));
      try {
        fs.mkdirSync(path.join(root, "app"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "app/page.tsx"),
          "export default function Page() { return <div>app</div>; }\n",
        );

        await expect(resolveWithCdnOutput(root, `vinext/server/${entry}`)).resolves.toBe(
          "\0virtual:vinext-worker-entry",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps the single-stage output when no CDN adapter is configured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-fetch-handler-no-cdn-"));
    try {
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "app/page.tsx"),
        "export default function Page() { return <div>app</div>; }\n",
      );

      await expect(
        loadUnifiedFetchHandler(root, { hostPluginName: "vite-plugin-cloudflare" }),
      ).resolves.toBe('export { default } from "vinext/server/app-router-entry";');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not activate a platform facade outside its target build", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-fetch-handler-non-cf-"));
    try {
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "app/page.tsx"),
        "export default function Page() { return <div>app</div>; }\n",
      );

      await expect(loadUnifiedFetchHandler(root, { cdn: true })).resolves.toBe(
        'export { default } from "vinext/server/app-router-entry";',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a non-Cloudflare adapter select the same transport-neutral output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-fetch-handler-http-stages-"));
    try {
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "app/page.tsx"),
        "export default function Page() { return <div>app</div>; }\n",
      );
      const entry = "/adapter/http-stage-gateway.js";
      const cache: VinextOptions["cache"] = {
        cdn: {
          adapter: "/adapter/http-cache.js",
          output: {
            entry,
            matchesBuild: ({ plugins }) =>
              plugins.some(({ name }) => name === "independent-http-stage-host"),
            type: "multi-stage",
          },
        },
      };

      await expect(
        loadUnifiedFetchHandler(root, {
          cache,
          hostPluginName: "independent-http-stage-host",
        }),
      ).resolves.toBe(
        [
          `export { default } from ${JSON.stringify(entry)};`,
          `export * from ${JSON.stringify(entry)};`,
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes request and response stages as independent virtual entries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-independent-stages-"));
    try {
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "app/page.tsx"),
        "export default function Page() { return <div>app</div>; }\n",
      );

      await expect(loadVirtualModule(root, "virtual:vinext-request-stage")).resolves.toBe(
        `export { handleRequestStage } from ${JSON.stringify(resolveRuntimeEntryModule("app-request-stage-independent-entry"))};\n`,
      );
      await expect(loadVirtualModule(root, "virtual:vinext-response-stage")).resolves.toBe(
        `export { handleResponseStage } from ${JSON.stringify(resolveRuntimeEntryModule("app-response-stage-entry"))};\n`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes Pages request and response stages through distinct entry modules", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-independent-stages-"));
    try {
      fs.mkdirSync(path.join(root, "pages"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "pages/index.tsx"),
        "export default function Page() { return <div>pages</div>; }\n",
      );

      await expect(loadVirtualModule(root, "virtual:vinext-request-stage")).resolves.toBe(
        `export { handleRequestStage } from ${JSON.stringify(resolveRuntimeEntryModule("pages-request-stage-entry"))};\n`,
      );
      await expect(loadVirtualModule(root, "virtual:vinext-response-stage")).resolves.toBe(
        `export { handleResponseStage } from ${JSON.stringify(resolveRuntimeEntryModule("pages-response-stage-entry"))};\n`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
