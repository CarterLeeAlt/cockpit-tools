import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const serviceSourceUrl = new URL(
  "../src/services/codexLocalAccessService.ts",
  import.meta.url,
);

describe("codex local access state synchronization", () => {
  it("broadcasts successful enable and activate mutations through one helper", async () => {
    const source = await readFile(serviceSourceUrl, "utf8");

    assert.match(
      source,
      /async function invokeCodexLocalAccessStateMutation[\s\S]*?notifyCodexLocalAccessStateUpdated\(\);/,
    );
    assert.match(
      source,
      /setCodexLocalAccessEnabled[\s\S]*?invokeCodexLocalAccessStateMutation\(\s*"codex_local_access_set_enabled"/,
    );
    assert.match(
      source,
      /activateCodexLocalAccess[\s\S]*?invokeCodexLocalAccessStateMutation\(\s*"codex_local_access_activate"/,
    );
  });

  it("keeps read-only state loading free of synchronization broadcasts", async () => {
    const source = await readFile(serviceSourceUrl, "utf8");
    const getter = source.match(
      /export async function getCodexLocalAccessState[\s\S]*?\n}/,
    )?.[0];

    assert.ok(getter);
    assert.doesNotMatch(getter, /notifyCodexLocalAccessStateUpdated/);
    assert.doesNotMatch(getter, /invokeCodexLocalAccessStateMutation/);
  });
});
