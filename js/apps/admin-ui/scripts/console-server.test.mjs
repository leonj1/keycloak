import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { createConsoleServer } from "./console-server.mjs";

async function listen(server, context) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("serves the built console and forwards the Rust session on the configured origin", async (context) => {
  const requests = [];
  const session =
    "kc_admin_console=fixture; Path=/admin/; HttpOnly; SameSite=Strict";
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    const url = new URL(req.url, "http://fixture");
    const writeJson = (body) =>
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    if (url.pathname.endsWith("/login")) {
      return res
        .writeHead(303, {
          "Set-Cookie": session,
          Location: "/admin/team/console",
        })
        .end();
    }
    if (url.pathname.endsWith("/whoami")) {
      if (!req.headers.cookie) return res.writeHead(401).end("Sign in");
      return writeJson({
        id: "123",
        realm: "team",
        username: "team-admin",
        realmAccess: "realm",
      });
    }
    if (url.pathname.endsWith("/messages.json"))
      return writeJson({ clients: "Applications" });
    if (url.pathname === "/admin/serverinfo") {
      return writeJson({
        runtime: { version: "0.1.0" },
        themes: { login: ["builtin"] },
      });
    }
    if (url.pathname.endsWith("/users"))
      return res.writeHead(422).end("Invalid fixture");
    return res.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream, context);
  const publicOrigin = "https://console.example.test";
  const rustPublicOrigin = "https://identity.example.test";
  const frontend = await listen(
    createConsoleServer({
      backendOrigin: upstreamUrl,
      rustPublicOrigin,
      consoleOrigin: publicOrigin,
      realm: "team",
    }),
    context,
  );
  // Use HTTP directly so the fixture can model the public Host behind a TLS proxy.
  const call = (path, { headers, method, body } = {}) =>
    new Promise((resolve, reject) => {
      const connection = request(
        frontend + path,
        { headers, method },
        async (response) => {
          try {
            const chunks = [];
            for await (const chunk of response) chunks.push(chunk);
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers: response.headers,
              }),
            );
          } catch (error) {
            reject(error);
          }
        },
      );
      connection.on("error", reject);
      connection.end(body?.toString());
    });

  const index = await call("/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /^text\/html/);
  const html = await index.text();
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset);
  const script = await call(asset, { method: "HEAD" });
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.match(script.headers.get("cache-control"), /immutable/);
  assert.equal((await call("/missing.js")).status, 404);
  assert.deepEqual(await (await call("/console-config.json")).json(), {
    realm: "team",
  });
  assert.equal((await call("/admin/team/console/whoami")).status, 401);

  const cookie = "kc_admin_console=fixture";
  const authenticated = { headers: { Cookie: cookie } };
  const console = await call("/admin/team/console", authenticated);
  assert.equal(console.status, 303);
  assert.equal(console.headers.get("location"), "/");
  const info = await (await call("/admin/serverinfo", authenticated)).json();
  assert.equal(info.systemInfo.version, "0.1.0");
  assert.deepEqual(info.themes.login, [{ name: "builtin" }]);

  const ownRealm = await (
    await call("/admin/team/console/whoami?currentRealm=team", authenticated)
  ).json();
  assert.equal(ownRealm.displayName, "team-admin");
  assert.equal(ownRealm.createRealm, false);
  assert.ok(ownRealm.realm_access.team.includes("manage-users"));
  const differentRealm = await (
    await call("/admin/team/console/whoami?currentRealm=another", authenticated)
  ).json();
  assert.deepEqual(differentRealm.realm_access, { another: [] });

  const messages = await (await call("/resources/team/admin/en")).json();
  assert.ok(
    messages.some(
      ({ key, value }) => key === "clients" && value === "Applications",
    ),
  );
  assert.ok(messages.length > 1);

  const form = new URLSearchParams({ client_id: "fixture" });
  const originHeaders = {
    Host: new URL(publicOrigin).host,
    Origin: publicOrigin,
  };
  const login = await call("/admin/team/console/login", {
    method: "POST",
    headers: originHeaders,
    body: form,
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("set-cookie"), session);
  assert.equal(login.headers.get("location"), "/admin/team/console");
  assert.equal(requests.at(-1).body, form.toString());
  assert.equal(requests.at(-1).headers.origin, rustPublicOrigin);

  const requestCount = requests.length;
  for (const headers of [
    {},
    { Origin: "https://other.example.test" },
    { Origin: publicOrigin },
  ]) {
    const rejected = await call("/admin/realms/team/users", {
      method: "POST",
      headers,
    });
    assert.equal(rejected.status, 403);
  }
  const crossSiteLogout = await call("/admin/team/console/logout", {
    headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(crossSiteLogout.status, 403);
  assert.equal(requests.length, requestCount);

  const error = await call("/admin/realms/team/users", {
    method: "POST",
    headers: {
      ...originHeaders,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(error.status, 422);
  assert.equal(await error.text(), "Invalid fixture");
  assert.equal(requests.at(-1).headers.cookie, cookie);
});
