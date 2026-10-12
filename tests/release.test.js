import test from "node:test";
import assert from "node:assert/strict";
import { shouldPublish } from "../scripts/release-check.mjs";

const pkg = { name: "@team/patchwork-cli", version: "0.2.1" };
const registry = {
  name: pkg.name,
  versions: { "0.2.0": {}, "0.0.0-stage": {} },
  "dist-tags": { latest: "0.2.0" },
};

test("publishing requires an explicit new version; retries and ordinary commits do not republish", () => {
  assert.equal(shouldPublish(pkg, registry), true);
  assert.equal(shouldPublish({ ...pkg, version: "0.2.0" }, registry), false);
  assert.equal(shouldPublish(pkg, {
    ...registry, versions: { ...registry.versions, "0.2.1": {} },
  }), false);
  assert.equal(shouldPublish({ ...pkg, version: "1.0.0" }, registry), true);
});

test("release checks reject downgrades, prereleases, malformed versions and incomplete registry data", () => {
  for (const version of ["0.1.9", "0.2.1-beta.1", "v0.2.1", "01.2.1", "1.2.9007199254740992"])
    assert.throws(() => shouldPublish({ ...pkg, version }, registry));
  for (const response of [{}, { ...registry, name: "@other/package" },
    { ...registry, versions: [] }, { ...registry, "dist-tags": {} }])
    assert.throws(() => shouldPublish(pkg, response), /Cannot verify/);
  assert.throws(() => shouldPublish({ ...pkg, version: "0.2.9" }, {
    ...registry, versions: { ...registry.versions, "0.2.10": {} },
  }), /above published/);
});
