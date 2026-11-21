import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = new URL(process.env.CONSOLE_ORIGIN ?? "http://localhost:5174")
  .origin;
const realm = process.env.ADMIN_REALM ?? "master";
const admin = process.env.ADMIN_CLIENT_ID;
const secretFile = process.env.ADMIN_CLIENT_SECRET_FILE;
assert.ok(
  admin && secretFile,
  "Set ADMIN_CLIENT_ID and ADMIN_CLIENT_SECRET_FILE for a test administrator.",
);
const secret = (await readFile(secretFile, "utf8")).trim();
const tag = "console-smoke-" + randomUUID();
const api = `/admin/realms/${encodeURIComponent(realm)}`;
const whoami = `/admin/${encodeURIComponent(realm)}/console/whoami`;
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(12_000);
page.on("pageerror", (error) => console.error(error));
const cleanup = [];

async function verifyWrite(path, method, expected, action) {
  const pending = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.replace(/\/$/, "") === path &&
      response.request().method() === method
    );
  });
  await action();
  const response = await pending;
  const actual = response.status();
  if (actual === 201)
    cleanup.push(new URL(response.headers().location, origin).pathname);
  if (actual !== expected) {
    const details = await response
      .text()
      .catch(() => "Response body unavailable");
    assert.equal(actual, expected, `${method} ${path}: ${details}`);
  }
}
async function request(path, options) {
  return context.request.fetch(origin + path, options);
}

try {
  await page.goto(origin);
  await page.getByLabel("Administrator client ID").fill(admin);
  await page.getByLabel("Client secret").fill(secret);
  await page.getByRole("button", { name: "Sign in" }).click();
  const navigation = page.getByRole("navigation");
  await navigation.getByRole("link", { name: "Users", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Users", exact: true }),
  ).toBeVisible();

  const denied = await request(api + "/users", {
    method: "POST",
    headers: { Origin: "https://other.invalid" },
    data: {},
  });
  assert.equal(denied.status(), 403);

  await page.goto(origin + `/#/${encodeURIComponent(realm)}/users/add-user`);
  await page.getByTestId("username").fill(tag);
  await page.getByTestId("email").fill(tag + "@example.test");
  await verifyWrite(api + "/users", "POST", 201, () =>
    page.getByTestId("user-creation-save").click(),
  );
  const userPath = cleanup.at(-1);
  await page.waitForURL(`**/#/${encodeURIComponent(realm)}/users/*/settings`);
  await page.getByTestId(`${tag}-switch`).press("Space");
  await verifyWrite(userPath, "PUT", 204, () =>
    page.getByRole("button", { name: "Disable", exact: true }).click(),
  );
  const users = await (
    await request(
      api + "/users?" + new URLSearchParams({ username: tag, exact: "true" }),
    )
  ).json();
  assert.equal(users.length, 1);
  assert.equal(users[0].username, tag);
  assert.equal(users[0].enabled, false);

  await navigation.getByRole("link", { name: "Clients", exact: true }).click();
  await page.getByTestId("createClient").click();
  await page.getByTestId("clientId").fill(tag);
  const next = page.getByRole("button", { name: "Next", exact: true });
  await next.click();
  await next.click();
  const callback = "https://example.test/callback";
  await page.getByTestId("redirectUris0").fill(callback);
  await verifyWrite(api + "/clients", "POST", 201, () =>
    page.getByRole("button", { name: "Save", exact: true }).click(),
  );
  const clientPath = cleanup.at(-1);
  const editedCallback = "https://example.test/updated";
  await page.getByRole("heading", { name: tag, exact: true }).waitFor();
  await page.getByTestId("redirectUris0").fill(editedCallback);
  await verifyWrite(clientPath, "PUT", 204, () =>
    page.getByTestId("settings-save").click(),
  );
  const client = await (await request(clientPath)).json();
  assert.equal(client.clientId, tag);
  assert.deepEqual(client.redirectUris, [editedCallback]);

  for (const path of [...cleanup].reverse()) {
    assert.equal(
      (
        await request(path, { method: "DELETE", headers: { Origin: origin } })
      ).status(),
      204,
    );
    cleanup.splice(cleanup.indexOf(path), 1);
  }
  assert.equal((await request(whoami)).status(), 200);
  await page.getByRole("button", { name: admin, exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  assert.equal((await request(whoami)).status(), 401);
  console.log(
    "Rust sign-in, off-origin write rejection, user and client edits, cleanup, and sign-out passed.",
  );
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2200));
  throw error;
} finally {
  for (const path of cleanup.reverse()) {
    const result = await request(path, {
      method: "DELETE",
      headers: { Origin: origin },
    });
    if (!result.ok())
      console.error(`Test cleanup failed for ${path}: ${result.status()}`);
  }
  await browser.close();
}
