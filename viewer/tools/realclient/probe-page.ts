/**
 * Paint `probe.root` with the viewer's JSON UI engine. Query:
 * `guiScale`, `width`, `height` (CSS px). Packs come from the same origin.
 */

import { mapMinecraftGlyphs, stripFormatCodes } from "../../src/ui/formatCodes";
import { ensureMojangles, measureMojangles } from "../../src/ui/mojangles";
import { renderTree, type JsonUiAssets, type TextureInfo } from "../../src/ui/jsonui/dom";
import {
  collapseLangPercentEscapes,
  LABEL_FONT_SIZE_GUI,
  LABEL_LINE_HEIGHT_GUI,
} from "../../src/ui/jsonui/labelMetrics";
import { layoutTree } from "../../src/ui/jsonui/layout";
import { loadUiFileSet } from "../../src/ui/jsonui/load";
import { buildResolver } from "../../src/ui/jsonui/resolve";
import { createFetchUiClient } from "../../src/ui/jsonui/runtime";
import type { ResolvedElement } from "../../src/ui/jsonui/types";

const FONT =
  '"Mojangles", "Minecraft", ui-sans-serif, system-ui, "Segoe UI", sans-serif';

function numParam(name: string, fallback: number): number {
  const raw = new URLSearchParams(location.search).get(name);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function collectTextures(el: ResolvedElement, out: Set<string>): void {
  const tex = el.props.texture;
  if (typeof tex === "string" && (tex.includes("/") || tex.startsWith("textures"))) {
    out.add(tex.replace(/\.png$/i, ""));
  }
  for (const child of el.controls) collectTextures(child.element, out);
}

async function pngSize(buf: ArrayBuffer): Promise<{ w: number; h: number } | null> {
  if (buf.byteLength < 24) return null;
  const view = new DataView(buf);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

async function loadTextureInfo(path: string): Promise<TextureInfo | undefined> {
  const rel = path.replace(/^\/+/, "");
  const [metaRes, pngRes] = await Promise.all([
    fetch(`/asset/${rel}.json`),
    fetch(`/asset/${rel}.png`),
  ]);
  const meta = metaRes.ok
    ? ((await metaRes.json()) as { nineslice_size?: unknown; base_size?: unknown })
    : null;
  if (!pngRes.ok && meta?.nineslice_size === undefined) return undefined;
  const bytes = pngRes.ok ? await pngRes.arrayBuffer() : null;
  const ihdr = bytes ? await pngSize(bytes) : null;
  const base = Array.isArray(meta?.base_size) ? meta.base_size : null;
  const w = ihdr?.w || Number(base?.[0]) || 0;
  const h = ihdr?.h || Number(base?.[1]) || 0;
  if (w <= 0 && h <= 0 && meta?.nineslice_size === undefined) return undefined;
  return { w, h, nineslice: meta?.nineslice_size };
}

async function main(): Promise<void> {
  const guiScale = numParam("guiScale", 2);
  const width = numParam("width", window.innerWidth);
  const height = numParam("height", window.innerHeight);
  const host = document.getElementById("json-hud");
  if (!host) throw new Error("missing #json-hud");

  try {
    await document.fonts.load(`16px ${FONT}`);
  } catch {
    /* system fallback still measures */
  }
  await document.fonts.ready;
  await ensureMojangles(location.origin);

  const client = createFetchUiClient(location.origin);
  const { files, globals } = await loadUiFileSet(client);
  const resolver = buildResolver(files, globals);
  const root = resolver.resolve("probe", "root");
  if (!root) {
    throw new Error("probe.root did not resolve");
  }

  const paths = new Set<string>();
  collectTextures(root, paths);
  const info = new Map<string, TextureInfo>();
  await Promise.all(
    [...paths].map(async (path) => {
      const loaded = await loadTextureInfo(path);
      if (loaded) info.set(path, loaded);
    }),
  );

  const assets: JsonUiAssets = {
    textureUrl(path: string): string {
      const withExt = /\.[a-z]{3,4}$/i.test(path) ? path : `${path}.png`;
      const rel = withExt
        .replace(/^\/+/, "")
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      return `${location.origin}/asset/${rel}`;
    },
    textureInfo(path: string): TextureInfo | undefined {
      return info.get(path);
    },
  };

  const laid = layoutTree(
    root,
    { width: width / guiScale, height: height / guiScale },
    {
      measureText(text, fontScale) {
        const plain = mapMinecraftGlyphs(
          collapseLangPercentEscapes(stripFormatCodes(text)),
        );
        const moj = measureMojangles(plain, fontScale);
        if (moj) return moj;
        const lines = plain.length ? plain.split("\n") : [""];
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const cssFontPx = LABEL_FONT_SIZE_GUI * guiScale * fontScale;
        let maxWcss = 1;
        if (ctx) {
          ctx.font = `${cssFontPx}px ${FONT}`;
          for (const line of lines) {
            const raw = line || " ";
            const marker = ctx.measureText("M").width;
            maxWcss = Math.max(
              maxWcss,
              Math.max(0, ctx.measureText(`${raw}M`).width - marker),
            );
          }
        } else {
          let maxLen = 1;
          for (const line of lines) maxLen = Math.max(maxLen, line.length);
          maxWcss = maxLen * 6 * guiScale * fontScale;
        }
        return {
          w: Math.max(1, maxWcss / guiScale + 1),
          h: Math.max(1, lines.length) * LABEL_LINE_HEIGHT_GUI * fontScale,
        };
      },
    },
  );

  host.replaceChildren();
  renderTree(laid, host, { guiScale, assets, textureInfo: info });
  host.dataset.probeReady = "1";
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  document.body.dataset.probeError = msg;
  document.body.textContent = msg;
  console.error(msg);
});
