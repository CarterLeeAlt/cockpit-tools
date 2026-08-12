import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const sideNavSourceUrl = new URL(
  "../src/components/layout/SideNav.tsx",
  import.meta.url,
);
const apiServiceStylesUrl = new URL(
  "../src/pages/CodexApiServicePage.css",
  import.meta.url,
);

describe("codex API service UI alignment", () => {
  it("uses the compact 2FA label in the classic sidebar", async () => {
    const source = await readFile(sideNavSourceUrl, "utf8");

    assert.match(source, /title="2FA"/);
    assert.match(source, /<span className="nav-item-text">2FA<\/span>/);
  });

  it("centers the API service hero button contents on both axes", async () => {
    const source = await readFile(apiServiceStylesUrl, "utf8");
    const buttonRule = source.match(
      /\.codex-api-service-hero-actions \.btn \{([\s\S]*?)\n\}/,
    )?.[1];
    const iconRule = source.match(
      /\.codex-api-service-hero-actions \.btn svg \{([\s\S]*?)\n\}/,
    )?.[1];

    assert.ok(buttonRule);
    assert.match(buttonRule, /display:\s*inline-flex;/);
    assert.match(buttonRule, /align-items:\s*center;/);
    assert.match(buttonRule, /justify-content:\s*center;/);
    assert.match(buttonRule, /height:\s*30px;/);
    assert.match(buttonRule, /line-height:\s*1;/);
    assert.ok(iconRule);
    assert.match(iconRule, /display:\s*block;/);
    assert.match(iconRule, /flex:\s*0 0 auto;/);
  });
});
