/**
 * Blockbench ground-truth vs the viewer, same model / animation / camera.
 *
 * Blockbench is a dev-time tool. Point BLOCKBENCH_ROOT at a local web build
 * (`npm run build-web` in the Blockbench repo). It is not vendored.
 *
 *   BLOCKBENCH_ROOT=/tmp/blockbench \
 *   node tools/blockbench-oracle.mjs pokemon:charizard pokemon:glaceon
 *
 * Writes ORACLE_OUT (default /tmp/oracle)/<id>/<pose>/<cam>-{oracle,viewer,diff,sbs}.png
 * and summary.json. Poses: rest, and the entity's default_ground_idle at --time.
 *
 *   --rest-only   --idle-only   --time 1   --out /tmp/oracle
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const bbRoot = process.env.BLOCKBENCH_ROOT || "/tmp/blockbench";
const packRoot =
  process.env.PACK_ROOT ||
  "/Users/eanlowell/GitHub/pokebedrock/pokebedrock-res/subpacks/3d";
const packFallback = join(packRoot, "..", "..");

const SIZE = 512;
const BG = { r: 255, g: 0, b: 255 };

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const timeFlag = argv.indexOf("--time");
const animTime = timeFlag >= 0 ? Number(argv[timeFlag + 1]) : 1;
const outFlag = argv.indexOf("--out");
const outRoot =
  outFlag >= 0 ? argv[outFlag + 1] : process.env.ORACLE_OUT || "/tmp/oracle";
const ids = argv.filter((a) => a.startsWith("pokemon:"));
const species = (
  ids.length ? ids : ["pokemon:charizard", "pokemon:glaceon"]
).map((s) => s.replace(/^pokemon:/, ""));
const doRest = !flags.has("--idle-only");
const doIdle = !flags.has("--rest-only");

if (!existsSync(join(bbRoot, "dist/bundle.js"))) {
  console.error("Blockbench web build missing at", bbRoot);
  console.error(
    "Clone https://github.com/JannisX11/blockbench and run: npm run build-web",
  );
  process.exit(1);
}

/**
 * @param {string} rel
 * @returns {string | null}
 */
function resolvePackFile(rel) {
  const clean = rel.replace(/\\/g, "/").replace(/^\//, "");
  for (const root of [packRoot, packFallback]) {
    const abs = join(root, clean);
    if (existsSync(abs)) return abs;
    if (!clean.endsWith(".png") && existsSync(abs + ".png"))
      return abs + ".png";
  }
  return null;
}

/**
 * @param {string} id species id without namespace
 */
function loadSpecies(id) {
  const entityPath = resolvePackFile(`entity/pokemon/${id}.entity.json`);
  const geoPath = resolvePackFile(`models/entity/pokemon/${id}.geo.json`);
  const animPath = resolvePackFile(`animations/pokemon/${id}.animation.json`);
  if (!entityPath || !geoPath) {
    throw new Error(`missing entity/geo for ${id}`);
  }
  const entity = JSON.parse(readFileSync(entityPath, "utf8"));
  const desc = entity["minecraft:client_entity"].description;
  const geoId = desc.geometry?.default;
  const geoDoc = JSON.parse(readFileSync(geoPath, "utf8"));
  const geometries = geoDoc["minecraft:geometry"] ?? [];
  const geo =
    geometries.find((g) => g.description?.identifier === geoId) ??
    geometries[0];
  if (!geo) throw new Error(`no geometry in ${geoPath}`);
  const singleGeo = {
    format_version: geoDoc.format_version ?? "1.16.0",
    "minecraft:geometry": [geo],
  };
  const texRel = desc.textures?.default;
  const texAbs = texRel
    ? resolvePackFile(texRel.endsWith(".png") ? texRel : `${texRel}.png`)
    : null;
  if (!texAbs) throw new Error(`missing texture ${texRel} for ${id}`);
  const textureDataUrl =
    "data:image/png;base64," + readFileSync(texAbs).toString("base64");
  const animName = desc.animations?.default_ground_idle ?? null;
  const animJson = animPath ? readFileSync(animPath, "utf8") : null;
  return { id, singleGeo, textureDataUrl, animName, animJson, geoId };
}

/**
 * @param {import('pngjs').PNG} png
 * @returns {Uint8Array}
 */
function foreground(png) {
  const m = new Uint8Array(png.width * png.height);
  const d = png.data;
  for (let i = 0; i < m.length; i++) {
    const r = d[i * 4];
    const g = d[i * 4 + 1];
    const b = d[i * 4 + 2];
    const a = d[i * 4 + 3];
    const magenta = r > 230 && g < 30 && b > 230;
    m[i] = a > 20 && !magenta ? 1 : 0;
  }
  return m;
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function iou(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x || y) union++;
    if (x && y) inter++;
  }
  return union === 0 ? 1 : inter / union;
}

/**
 * @param {import('pngjs').PNG} oracle
 * @param {import('pngjs').PNG} viewer
 * @param {Uint8Array} om
 * @param {Uint8Array} vm
 */
function colorMismatch(oracle, viewer, om, vm) {
  let both = 0;
  let far = 0;
  const od = oracle.data;
  const vd = viewer.data;
  for (let i = 0; i < om.length; i++) {
    if (!om[i] || !vm[i]) continue;
    both++;
    const dr = od[i * 4] - vd[i * 4];
    const dg = od[i * 4 + 1] - vd[i * 4 + 1];
    const db = od[i * 4 + 2] - vd[i * 4 + 2];
    if (dr * dr + dg * dg + db * db > 60 * 60) far++;
  }
  return both === 0 ? 0 : far / both;
}

/**
 * @param {import('pngjs').PNG} oracle
 * @param {import('pngjs').PNG} viewer
 * @param {Uint8Array} om
 * @param {Uint8Array} vm
 */
function diffPng(oracle, viewer, om, vm) {
  const out = new PNG({ width: oracle.width, height: oracle.height });
  for (let i = 0; i < om.length; i++) {
    const o = om[i];
    const v = vm[i];
    const p = i * 4;
    if (o && v) {
      out.data[p] = oracle.data[p];
      out.data[p + 1] = oracle.data[p + 1];
      out.data[p + 2] = oracle.data[p + 2];
    } else if (o) {
      out.data[p] = 220;
      out.data[p + 1] = 40;
      out.data[p + 2] = 40;
    } else if (v) {
      out.data[p] = 40;
      out.data[p + 1] = 90;
      out.data[p + 2] = 220;
    } else {
      out.data[p] = BG.r;
      out.data[p + 1] = BG.g;
      out.data[p + 2] = BG.b;
    }
    out.data[p + 3] = 255;
  }
  return out;
}

/**
 * @param {import('pngjs').PNG} a
 * @param {import('pngjs').PNG} b
 * @param {import('pngjs').PNG} c
 */
function sideBySide(a, b, c) {
  const out = new PNG({ width: a.width * 3, height: a.height });
  const blit = (src, ox) => {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const s = (y * src.width + x) * 4;
        const d = (y * out.width + x + ox) * 4;
        out.data[d] = src.data[s];
        out.data[d + 1] = src.data[s + 1];
        out.data[d + 2] = src.data[s + 2];
        out.data[d + 3] = 255;
      }
    }
  };
  blit(a, 0);
  blit(b, a.width);
  blit(c, a.width * 2);
  return out;
}

/**
 * @param {string} dataUrl
 */
function pngFromDataUrl(dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return PNG.sync.read(Buffer.from(b64, "base64"));
}

const bbServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const abs = join(bbRoot, rel);
  if (!abs.startsWith(bbRoot) || !existsSync(abs)) {
    res.writeHead(404);
    res.end("no");
    return;
  }
  const ext = abs.slice(abs.lastIndexOf("."));
  const mime =
    ext === ".html"
      ? "text/html"
      : ext === ".js"
        ? "text/javascript"
        : ext === ".css"
          ? "text/css"
          : ext === ".png"
            ? "image/png"
            : ext === ".svg"
              ? "image/svg+xml"
              : ext === ".json"
                ? "application/json"
                : "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(abs));
});
await new Promise((resolve) => bbServer.listen(0, "127.0.0.1", resolve));
const bbPort = /** @type {import('node:net').AddressInfo} */ (
  bbServer.address()
).port;
const bbBase = `http://127.0.0.1:${bbPort}/index.html`;

const vite = await createVite({
  root: viewerRoot,
  configFile: join(viewerRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  logLevel: "error",
});
await vite.listen();
const appBase = vite.resolvedUrls?.local[0];
if (!appBase) throw new Error("no vite url");

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const bbPage = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
bbPage.setDefaultTimeout(120_000);
bbPage.on("pageerror", (err) => console.error("bb pageerror", err.message));
const viewPage = await browser.newPage({
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 1,
});
viewPage.setDefaultTimeout(120_000);
await viewPage.goto(appBase, { waitUntil: "domcontentloaded" });

/**
 * @param {import('playwright').Page} page
 * @param {ReturnType<typeof loadSpecies>} spec
 * @param {string | null} animName
 * @param {number} time
 */
async function shootBlockbench(page, spec, animName, time) {
  await page.goto(bbBase, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      window.Blockbench &&
      window.Blockbench.setup_successful &&
      window.Codecs &&
      window.Codecs.bedrock &&
      window.Preview &&
      window.Preview.selected,
  );
  return page.evaluate(
    async ({ singleGeo, textureDataUrl, animJson, animName, time, size }) => {
      const errors = [];
      try {
        Codecs.bedrock.load(singleGeo, { path: "", no_file: true });
      } catch (err) {
        errors.push("load " + (err && err.message ? err.message : err));
      }
      if (typeof three_grid !== "undefined") three_grid.visible = false;
      if (Canvas.ground_plane) Canvas.ground_plane.visible = false;
      Canvas.scene.background = new THREE.Color(0xff00ff);
      const tex = new Texture({ name: "skin" }).fromDataURL(textureDataUrl);
      tex.add(false);
      await new Promise((resolve) => {
        if (tex.img.complete && tex.img.naturalWidth) resolve();
        else {
          tex.img.onload = () => resolve();
          tex.img.onerror = () => resolve();
        }
      });
      const map = new THREE.Texture(tex.img);
      map.magFilter = THREE.NearestFilter;
      map.minFilter = THREE.NearestFilter;
      map.colorSpace = THREE.SRGBColorSpace;
      map.needsUpdate = true;
      const basic = new THREE.MeshBasicMaterial({
        map,
        side: THREE.DoubleSide,
        alphaTest: 0.15,
        transparent: false,
      });
      let underScene = 0;
      Cube.all.forEach((cube) => {
        const mesh = cube.mesh;
        if (!mesh) return;
        if (mesh.outline) mesh.outline.visible = false;
        mesh.visible = true;
        mesh.frustumCulled = false;
        mesh.material = basic;
        let p = mesh;
        while (p) {
          if (p === Canvas.scene) {
            underScene++;
            break;
          }
          p = p.parent;
        }
      });
      if (animName && animJson) {
        try {
          AnimationCodec.codecs.bedrock.loadFile(
            { content: animJson, path: "oracle.animation.json" },
            [animName],
          );
          const anim = Animation.all.find((a) => a.name === animName);
          if (!anim) errors.push("anim missing " + animName);
          else {
            Animation.all.forEach((a) => {
              a.playing = false;
            });
            anim.select();
            anim.playing = true;
            Timeline.setTime(time);
            Animator.preview();
            anim.playing = false;
          }
        } catch (err) {
          errors.push("anim " + (err && err.message ? err.message : err));
        }
      } else if (Animator.showDefaultPose) {
        Animator.showDefaultPose();
      }
      Cube.all.forEach((cube) => {
        if (cube.mesh?.outline) cube.mesh.outline.visible = false;
      });

      const box = new THREE.Box3();
      for (const cube of Cube.all) {
        if (cube.mesh) box.expandByObject(cube.mesh);
      }
      if (box.isEmpty()) {
        box.set(new THREE.Vector3(-8, 0, -8), new THREE.Vector3(8, 16, 8));
      }
      const center = box.getCenter(new THREE.Vector3());
      const dims = box.getSize(new THREE.Vector3());
      const half = Math.max(dims.x, dims.y, dims.z, 8) * 0.62;

      const preview = Preview.selected;
      preview.setProjectionMode(true);
      preview.renderer.setPixelRatio(1);
      preview.renderer.setSize(size, size, false);
      preview.renderer.setClearColor(0xff00ff, 1);
      preview.width = size;
      preview.height = size;
      // Blockbench's orbit update rewrites the camera from a stale spherical.
      preview.controls.update = () => {};

      let inScene = 0;
      for (const cube of Cube.all) {
        if (cube.mesh?.parent) inScene++;
      }

      const dirs = {
        front: new THREE.Vector3(0, 0, -1),
        side: new THREE.Vector3(1, 0, 0),
        threequarter: new THREE.Vector3(-1, 0.35, -1).normalize(),
      };
      /** @type {Record<string, any>} */
      const cameras = {};
      /** @type {Record<string, string>} */
      const shots = {};
      const gl = preview.renderer.getContext();
      for (const [name, dir] of Object.entries(dirs)) {
        const pos = center.clone().addScaledVector(dir, half * 4);
        const cam = preview.camOrtho;
        cam.layers.enableAll();
        cam.left = -half;
        cam.right = half;
        cam.top = half;
        cam.bottom = -half;
        cam.near = -4000;
        cam.far = 4000;
        cam.zoom = 1;
        cam.position.copy(pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(center);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        preview.renderer.render(Canvas.scene, cam);
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        // WebGL is bottom-up. Flip into a PNG-ordered canvas.
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        const image = ctx.createImageData(w, h);
        for (let y = 0; y < h; y++) {
          const src = (h - 1 - y) * w * 4;
          image.data.set(buf.subarray(src, src + w * 4), y * w * 4);
        }
        ctx.putImageData(image, 0, 0);
        shots[name] = canvas.toDataURL("image/png");
        cameras[name] = {
          position: [pos.x, pos.y, pos.z],
          target: [center.x, center.y, center.z],
          left: -half,
          right: half,
          top: half,
          bottom: -half,
          near: -4000,
          far: 4000,
        };
      }
      return {
        errors,
        cameras,
        shots,
        cubes: Cube.all.length,
        bones: Group.all.length,
        inScene,
        underScene,
        half,
        center: [center.x, center.y, center.z],
        dims: [dims.x, dims.y, dims.z],
      };
    },
    {
      singleGeo: spec.singleGeo,
      textureDataUrl: spec.textureDataUrl,
      animJson: animName ? spec.animJson : null,
      animName,
      time,
      size: SIZE,
    },
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {ReturnType<typeof loadSpecies>} spec
 * @param {string | null} animName
 * @param {number} time
 * @param {Record<string, any>} cameras
 */
async function shootViewer(page, spec, animName, time, cameras) {
  return page.evaluate(
    async ({
      singleGeo,
      textureDataUrl,
      animJson,
      animName,
      time,
      cameras,
      size,
    }) => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const { parseGeometryDocument } = await import("/src/geometry/index.ts");
      const { buildEntityModel } = await import("/src/entity/buildModel.ts");
      const { materialStateFromName, createEntityMaterial } =
        await import("/src/entity/material.ts");
      const { parseAnimations } = await import("/src/entity/parseAnimation.ts");
      const { applyBonePoses, sampleAnimationPoses } =
        await import("/src/entity/animation.ts");
      const { createDefaultHost } = await import("/src/molang/host.ts");

      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("tex"));
        el.src = textureDataUrl;
      });
      const tex = new THREE.Texture(img);
      tex.flipY = true;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      const geo = parseGeometryDocument(singleGeo).geometries[0];
      const state = materialStateFromName("entity_emissive_alpha");
      const material = createEntityMaterial(tex, state);
      const model = buildEntityModel({
        geometry: geo,
        texture: tex,
        materialState: state,
      });
      // createEntityMaterial already built one material; the model built another.
      // Swap onto the meshes so the oracle and the film share the emissive cutout.
      model.root.traverse((obj) => {
        if (obj.isMesh) obj.material = material;
      });
      if (animName && animJson) {
        const anims = parseAnimations(JSON.parse(animJson));
        const anim = anims.get(animName);
        if (!anim) throw new Error("viewer missing anim " + animName);
        const poses = sampleAnimationPoses(anim, time, createDefaultHost());
        applyBonePoses(model.bones, poses, 0);
      }
      model.root.updateMatrixWorld(true);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xff00ff);
      scene.add(model.root);
      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
        alpha: false,
      });
      renderer.setPixelRatio(1);
      renderer.setSize(size, size, false);
      renderer.setClearColor(0xff00ff, 1);
      const shots = {};
      const U = 16;
      for (const [name, cam] of Object.entries(cameras)) {
        const camera = new THREE.OrthographicCamera(
          cam.left / U,
          cam.right / U,
          cam.top / U,
          cam.bottom / U,
          cam.near / U,
          cam.far / U,
        );
        camera.position.set(
          cam.position[0] / U,
          cam.position[1] / U,
          cam.position[2] / U,
        );
        camera.up.set(0, 1, 0);
        camera.lookAt(cam.target[0] / U, cam.target[1] / U, cam.target[2] / U);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        shots[name] = renderer.domElement.toDataURL("image/png");
      }
      renderer.dispose();
      model.dispose();
      return { shots };
    },
    {
      singleGeo: spec.singleGeo,
      textureDataUrl: spec.textureDataUrl,
      animJson: spec.animJson,
      animName,
      time,
      cameras,
      size: SIZE,
    },
  );
}

/** @type {any[]} */
const summary = [];
mkdirSync(outRoot, { recursive: true });

for (const id of species) {
  let spec;
  try {
    spec = loadSpecies(id);
  } catch (err) {
    console.error(id, err.message);
    summary.push({ id, error: String(err.message ?? err) });
    continue;
  }
  const poses = [];
  if (doRest) poses.push({ pose: "rest", anim: null });
  if (doIdle && spec.animName)
    poses.push({ pose: "idle", anim: spec.animName });
  for (const { pose, anim } of poses) {
    console.log("oracle", id, pose, anim ?? "");
    try {
      await shootPose(id, spec, pose, anim);
    } catch (err) {
      console.error(" ", id, pose, err.message);
      summary.push({ id, pose, error: String(err.message ?? err) });
    }
  }
}

/**
 * Render one pose in both renderers, write the images, and append the scores.
 *
 * @param {string} id
 * @param {ReturnType<typeof loadSpecies>} spec
 * @param {string} pose
 * @param {string | null} anim
 */
async function shootPose(id, spec, pose, anim) {
  {
    const bb = await shootBlockbench(bbPage, spec, anim, animTime);
    if (bb.errors?.length) console.log("  bb", bb.errors.join(" | "));
    console.log(
      "  cubes",
      bb.cubes,
      "bones",
      bb.bones,
      "inScene",
      bb.inScene,
      "underScene",
      bb.underScene,
      "half",
      bb.half?.toFixed?.(1),
      "center",
      bb.center?.map((v) => v.toFixed(1)).join(","),
    );
    const view = await shootViewer(viewPage, spec, anim, animTime, bb.cameras);
    const dir = join(outRoot, id, pose);
    mkdirSync(dir, { recursive: true });
    /** @type {Record<string, number>} */
    const scores = {};
    /** @type {Record<string, number>} */
    const colors = {};
    for (const cam of Object.keys(bb.shots)) {
      const oracle = pngFromDataUrl(bb.shots[cam]);
      const viewer = pngFromDataUrl(view.shots[cam]);
      const om = foreground(oracle);
      const vm = foreground(viewer);
      const score = iou(om, vm);
      const color = colorMismatch(oracle, viewer, om, vm);
      scores[cam] = score;
      colors[cam] = color;
      const diff = diffPng(oracle, viewer, om, vm);
      const sbs = sideBySide(oracle, viewer, diff);
      writeFileSync(join(dir, `${cam}-oracle.png`), PNG.sync.write(oracle));
      writeFileSync(join(dir, `${cam}-viewer.png`), PNG.sync.write(viewer));
      writeFileSync(join(dir, `${cam}-diff.png`), PNG.sync.write(diff));
      writeFileSync(join(dir, `${cam}-sbs.png`), PNG.sync.write(sbs));
      console.log(
        `  ${cam} iou ${score.toFixed(3)} colorFar ${(color * 100).toFixed(1)}%`,
      );
    }
    const cams = Object.values(scores);
    const mean = cams.reduce((s, v) => s + v, 0) / cams.length;
    summary.push({
      id,
      pose,
      anim,
      time: anim ? animTime : 0,
      iou: scores,
      meanIou: mean,
      colorFar: colors,
      errors: bb.errors,
    });
  }
}

writeFileSync(join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
console.log("wrote", outRoot);
await browser.close();
await vite.close();
bbServer.close();
