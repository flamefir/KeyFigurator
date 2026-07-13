import { test, expect } from "@playwright/test";

// Frontend test gate (vault Firmware/BACKLOG.md "Harness" item). Runs against
// the browser-mock transport (no Tauri/hid.rs involved) - it exists to catch
// "the app doesn't boot" / "the board doesn't render" before merge, not to
// cover every interaction. Deeper coverage is real-hardware-dependent and
// tracked as its own backlog item (needs a human HW gate, see PR template).

test("app boots with no console errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await page.waitForSelector("#board .key", { timeout: 10_000 });

  expect(errors, `console/page errors: ${errors.join("\n")}`).toEqual([]);
});

test("board renders all 20 keys + encoder + OLED panel", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#board .key");

  await expect(page.locator("#board .key")).toHaveCount(20);
  await expect(page.locator("#board .encoder-wrap")).toHaveCount(1);
  await expect(page.locator("#board .oled-panel")).toHaveCount(1);
  await expect(page.locator("#board .oled-screen")).not.toBeEmpty();
});

test("mock transport reports connected", async ({ page }) => {
  await page.goto("/");
  const pill = page.locator("#conn");
  await expect(pill).toContainText("connected", { timeout: 10_000 });
});

test("clicking a key opens the keycode pill", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#board .key");

  await page.locator("#board .key").first().click();
  await expect(page.locator("#keycode-pill")).toBeVisible();
});
