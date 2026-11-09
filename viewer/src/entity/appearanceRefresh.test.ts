import { test } from "node:test";
import assert from "node:assert/strict";
import { ViewerScene } from "../scene";
import { EntityModelRegistry } from "./registry";
import { parseClientEntity } from "./parseClient";
import { parseRenderControllers } from "./parseController";

test("native shiny update refreshes the existing scene model only when appearance changes", () => {
  const registry = new EntityModelRegistry({} as never);
  const internals = registry as any;
  internals.entities.set(
    "pokemon:test",
    parseClientEntity({
      "minecraft:client_entity": {
        description: {
          identifier: "pokemon:test",
          geometry: { default: "geometry.test" },
          textures: { default: "normal", shiny: "blue" },
          scripts: {
            initialize: ["v.offset = 2;"],
            pre_animation: [
              "v.skin_index = query.property('pack:skin_index') + v.offset;",
            ],
          },
          render_controllers: ["controller.render.test"],
        },
      },
    }),
  );
  for (const [name, rc] of parseRenderControllers({
    render_controllers: {
      "controller.render.test": {
        arrays: {
          textures: { "Array.skins": ["Texture.default", "Texture.shiny"] },
        },
        geometry: "Geometry.default",
        textures: [
          "Array.skins[(v.skin_index == 2 && query.property('pack:shiny') == true) ? 1 : 0]",
        ],
      },
    },
  }))
    internals.controllers.set(name, rc);
  const ent: any = {
    rid: 1,
    type: "pokemon:test",
    player: false,
    props: { "pack:shiny": 0, "pack:skin_index": 0, air: 300 },
    flags: {},
    bbox: [1, 1],
    rot: [0, 0, 0],
    pos: [0, 0, 0],
  };
  const original = registry.appearanceKey(ent);
  assert.match(original, /normal/);
  const node: any = {
    rid: 1,
    type: ent.type,
    skinKey: "",
    appearanceKey: original,
    model: {},
    nameTag: { setText() {} },
    group: {},
    itemSprite: null,
  };
  let loads = 0;
  const scene: any = {
    entities: new Map([[1, node]]),
    entityRegistry: registry,
    requestEntityModel() {
      loads++;
    },
    syncEntityGear() {},
    entityDrawHidden() {
      return false;
    },
  };
  const update = (ViewerScene.prototype as any).upsertEntity;
  ent.props.air = 299;
  update.call(scene, 1, ent);
  assert.equal(loads, 0);
  ent.props["pack:shiny"] = 1;
  update.call(scene, 1, ent);
  assert.equal(loads, 1);
  assert.match(node.appearanceKey, /blue/);
  update.call(scene, 1, ent);
  assert.equal(loads, 1);
});
