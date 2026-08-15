"use strict";

/**
 * Redirects `@minecraft/server` to the test fixture before any SDK module loads.
 * Loaded via `node --require` ahead of the unit suite.
 */
const Module = require("module");
const path = require("path");

const FIXTURE = path.join(__dirname, "fixtures", "minecraftServer.ts");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "@minecraft/server") {
    return originalResolveFilename.call(this, FIXTURE, parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
