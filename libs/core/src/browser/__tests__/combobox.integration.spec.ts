/**
 * ARIA combobox handling (Phase 4 of the "close partial feature gaps" plan):
 * `fill()`/`selectOption()` should drive the open-popup-and-click-option flow
 * for non-native comboboxes instead of only supporting real `<select>`s.
 *
 * Uses a real (headless) browser against a local fixture page, since the
 * behavior under test is fundamentally about how Playwright resolves ARIA
 * relationships and click targets — a DOM mock would just re-assert the
 * implementation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../session";

const FIXTURE_HTML = `<!doctype html>
<html>
<body>
  <label for="trigger1">Fruit</label>
  <input id="trigger1" role="combobox" aria-expanded="false" aria-controls="listbox1" aria-autocomplete="list" />
  <ul id="listbox1" role="listbox" hidden>
    <li role="option" id="opt-apple">Apple</li>
    <li role="option" id="opt-banana">Banana</li>
    <li role="option" id="opt-cherry">Cherry</li>
  </ul>
  <div id="result1"></div>

  <button id="trigger2" aria-haspopup="listbox" aria-expanded="false" aria-controls="popup2" type="button">Choose color</button>
  <div id="result2"></div>
  <!-- Popup deliberately placed elsewhere in the DOM, linked only via aria-controls -->
  <div style="margin-top: 200px;">
    <ul id="popup2" role="listbox" hidden>
      <li role="option">Red</li>
      <li role="option">Green</li>
      <li role="option">Blue</li>
    </ul>
  </div>

  <select id="native">
    <option value="one">One</option>
    <option value="two">Two</option>
  </select>

  <input id="plain" type="text" />

  <script>
    function wire(triggerId, popupId, resultId) {
      const trigger = document.getElementById(triggerId);
      const popup = document.getElementById(popupId);
      const result = document.getElementById(resultId);
      const open = () => { popup.hidden = false; trigger.setAttribute('aria-expanded', 'true'); };
      trigger.addEventListener('focus', open);
      trigger.addEventListener('click', open);
      popup.addEventListener('click', (e) => {
        const li = e.target.closest('[role="option"]');
        if (li) {
          result.textContent = li.textContent;
          popup.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
        }
      });
    }
    wire('trigger1', 'listbox1', 'result1');
    wire('trigger2', 'popup2', 'result2');
  </script>
</body>
</html>`;

describe("BrowserSession - ARIA combobox handling", () => {
    let fixtureDir: string;
    let fixturePath: string;
    let session: BrowserSession;

    beforeAll(async () => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-combobox-"));
        fixturePath = path.join(fixtureDir, "combobox.html");
        fs.writeFileSync(fixturePath, FIXTURE_HTML, "utf-8");

        session = BrowserSession.getInstance(fixtureDir);
        await session.start({ headless: true });
        await session.navigate(`file://${fixturePath}`);
    }, 30000);

    afterAll(async () => {
        await BrowserSession.reset();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    const getPage = () => (session as unknown as { page: import("playwright").Page }).page;

    it("drives a role=combobox trigger with an aria-controls popup via fill()", async () => {
        await session.fill("#trigger1", "Banana");

        const text = await getPage().locator("#result1").textContent();
        expect(text).toBe("Banana");
    }, 15000);

    it("drives a button trigger + detached popup (aria-controls, not a DOM sibling) via selectOption()", async () => {
        await session.selectOption("#trigger2", "Green");

        const text = await getPage().locator("#result2").textContent();
        expect(text).toBe("Green");
    }, 15000);

    it("still falls back to native <select> handling, unaffected by the combobox path", async () => {
        await session.fill("#native", "Two");

        const value = await getPage().locator("#native").inputValue();
        expect(value).toBe("two");
    }, 15000);

    it("does not affect a plain text input with no ARIA combobox attributes", async () => {
        await session.fill("#plain", "hello world");

        const value = await getPage().locator("#plain").inputValue();
        expect(value).toBe("hello world");
    }, 15000);
});
