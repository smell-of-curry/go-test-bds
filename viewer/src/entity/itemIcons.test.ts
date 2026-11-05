import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemIconResolver } from './itemIcons';
import type { AssetClient } from '../terrain/assetClient';
test('hub items resolve namespaced IDs and vanilla clock/compass atlas aliases',async()=>{
  const data = {spyglass:'textures/items/spyglass',recovery_compass:'textures/items/recovery_compass_item',clock_item:'textures/items/clock_item',nether_star:'textures/items/nether_star',compass_item:'textures/items/compass_item'};
  const resolver = new ItemIconResolver({fetchJson:async()=>({texture_data:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,{textures:v}]))}),has:async()=>false} as unknown as AssetClient);
  for(const name of ['spyglass','recovery_compass','clock','nether_star','compass']) assert(await resolver.resolve('minecraft:'+name),name);
  assert.equal(await resolver.resolve('minecraft:missing'),null);
});
