import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyBedrockLook } from './camera';
test('camera follows the Bedrock view vector for all headings and vertical aim', () => {
  const camera = new THREE.PerspectiveCamera();
  for (const yaw of [0,90,180,270]) for (const pitch of [-60,0,60]) {
    applyBedrockLook(camera,[0,0,0],yaw,pitch);
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const y = yaw*Math.PI/180, p=pitch*Math.PI/180;
    const expected = new THREE.Vector3(-Math.sin(y)*Math.cos(p),-Math.sin(p),Math.cos(y)*Math.cos(p));
    assert(dir.distanceTo(expected)<1e-8, `yaw=${yaw}, pitch=${pitch}: ${dir.toArray()}`);
  }
});
