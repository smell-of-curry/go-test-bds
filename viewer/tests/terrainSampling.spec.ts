import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("terrain shader preserves equal widths for all 16 texels across a block", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const counts = await page.evaluate(async () => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const { createTerrainMaterial } =
        await import("/src/terrain/material.ts");
      const pixels = new Uint8Array(16 * 4);
      for (let i = 0; i < 16; i++) pixels.set([i * 16, 0, 0, 255], i * 4);
      const map = new THREE.DataTexture(pixels, 16, 1);
      map.magFilter = map.minFilter = THREE.NearestFilter;
      map.generateMipmaps = false;
      map.needsUpdate = true;
      const material = createTerrainMaterial({
        map,
        atlasWidth: 16,
        atlasHeight: 1,
      });
      const geometry = new THREE.PlaneGeometry(1, 1);
      geometry.setAttribute("tileUv", geometry.getAttribute("uv").clone());
      geometry.setAttribute(
        "atlasRect",
        new THREE.Float32BufferAttribute(
          [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
          4,
        ),
      );
      geometry.setAttribute(
        "tileRot",
        new THREE.Float32BufferAttribute([0, 0, 0, 0], 1),
      );
      geometry.setAttribute(
        "vertColor",
        new THREE.Float32BufferAttribute(Array(12).fill(1), 3),
      );
      const renderer = new THREE.WebGLRenderer({ antialias: false });
      renderer.setSize(160, 16, false);
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(geometry, material));
      const camera = new THREE.OrthographicCamera(
        -0.5,
        0.5,
        0.5,
        -0.5,
        0.1,
        10,
      );
      camera.position.z = 1;
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const row = new Uint8Array(160 * 4);
      gl.readPixels(0, 8, 160, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      const counts = Array(16).fill(0);
      for (let i = 0; i < 160; i++) counts[Math.round(row[i * 4]! / 16)]++;
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      map.dispose();
      return counts;
    });
    expect(counts).toEqual(Array(16).fill(10));
  } finally {
    await server.close();
  }
});
