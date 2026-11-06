/** Render imported emotes against a local vanilla player rig. No game assets are vendored.
 * node tools/preview-emotes.mjs /path/to/resource_pack [.cache/emotes/preview.png]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const baseline = process.argv[2];
if (!baseline) throw new Error('Pass an extracted vanilla resource_pack directory');
const dataset = JSON.parse(readFileSync('.cache/emotes/runtime.json', 'utf8'));
const geometry = JSON.parse(readFileSync(join(baseline, 'models/entity/humanoid.custom.geo.json'), 'utf8'));
const skin = 'data:image/png;base64,' + readFileSync(join(baseline, 'textures/entity/steve.png')).toString('base64');
const out = resolve(process.argv[3] ?? '.cache/emotes/preview.png');
const vite = await createServer({ server: { host: '127.0.0.1', port: 5198, strictPort: false }, logLevel: 'error' });
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.route('**/emote-preview', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.goto(new URL('/emote-preview', vite.resolvedUrls.local[0]).href);
  const result = await page.evaluate(async ({ dataset, geometry, skin }) => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { buildEntityModel, geometryById, applyBonePoses, sampleAnimationPoses, registerNativeEmotes, builtinEmote } = await import('/src/entity/index.ts');
    const { createDefaultHost } = await import('/src/molang/index.ts');
    registerNativeEmotes(dataset);
    const texture = await new THREE.TextureLoader().loadAsync(skin);
    // HTMLImage textures need the same V flip as registry's flipped ImageBitmap.
    texture.flipY = true;
    const model = buildEntityModel({ geometry: geometryById(geometry, 'geometry.humanoid.custom'), texture });
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(240, 300, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#94b7d5');
    scene.add(model.root);
    const camera = new THREE.PerspectiveCamera(36, 240/300, 0.05, 100);
    camera.position.set(2.4, 1.5, -4.5); camera.lookAt(0, 1, 0);
    const sheet = document.createElement('canvas'); sheet.width = 5*240; sheet.height = dataset.emotes.length*330;
    const ctx = sheet.getContext('2d'); ctx.fillStyle = '#162536'; ctx.fillRect(0, 0, sheet.width, sheet.height);
    const notes = [];
    for (let row = 0; row < dataset.emotes.length; row++) {
      const e = dataset.emotes[row], anim = builtinEmote(e.id);
      notes.push({ id: e.id, name: e.name, duration: anim.animationLength, unmappedBones: [...anim.bones.keys()].filter(b => !model.bones.has(b)) });
      for (let col = 0; col < 5; col++) {
        const t = anim.animationLength * col / 4;
        applyBonePoses(model.bones, sampleAnimationPoses(anim, t, createDefaultHost()));
        renderer.render(scene, camera); ctx.drawImage(renderer.domElement, col*240, row*330);
        ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif';
        ctx.fillText(`${e.name} ${t.toFixed(2)}s`, col*240+8, row*330+320);
      }
    }
    renderer.dispose(); model.dispose();
    return { png: sheet.toDataURL(), notes };
  }, { dataset, geometry, skin });
  writeFileSync(out, Buffer.from(result.png.split(',')[1], 'base64'));
  writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(result.notes, null, 2) + '\n');
  console.log(out); console.log(JSON.stringify(result.notes));
} finally {
  await browser?.close(); await vite.close();
}
