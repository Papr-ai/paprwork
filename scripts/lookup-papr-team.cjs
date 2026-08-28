/**
 * List every @papr.ai user with a workspace_follower row on a workspace.
 * Read-only.
 */

const fs = require("fs");
const path = require("path");
const electron = require("electron");

const { app, safeStorage } = electron;
app.setName("Papr Work");

const PARSE_SERVER_URL =
  process.env.PARSE_SERVER_URL || "https://server.papr.ai/parse";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";
const WORKSPACE_ID =
  process.argv.slice(2).find((a) => !a.startsWith("--")) || "qDgAdi2eMf";
const PAGE = 500;

function readSessionToken() {
  const keysFile = path.join(
    app.getPath("userData"),
    "data",
    "custom-keys.global.json",
  );
  const store = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const entry = Object.values(store).find(
    (k) => k && k.name === "PAPR_SESSION_TOKEN",
  );
  if (!entry?.encryptedValue) throw new Error("PAPR_SESSION_TOKEN not found");
  return safeStorage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
}

async function restGet(sessionToken, urlPath, params) {
  const url = new URL(`${PARSE_SERVER_URL}${urlPath}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: {
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Parse REST ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function fetchAll(sessionToken, urlPath, params) {
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = await restGet(sessionToken, urlPath, {
      ...params,
      limit: String(PAGE),
      skip: String(skip),
    });
    out.push(...page.results);
    if (page.results.length < PAGE) return out;
  }
}

async function main() {
  await app.whenReady();
  const sessionToken = readSessionToken();

  const followers = await fetchAll(
    sessionToken,
    "/classes/workspace_follower",
    {
      where: JSON.stringify({
        workspace: {
          __type: "Pointer",
          className: "WorkSpace",
          objectId: WORKSPACE_ID,
        },
        isMember: true,
        archive: { $ne: true },
      }),
      keys: "objectId,isMember,archive,createdAt,user,user.email,user.displayName,user.fullname,user.username",
      include: "user",
      order: "createdAt",
    },
  );

  const paprTeam = [];
  for (const follower of followers) {
    const user = follower.user;
    if (!user) continue;
    const email = (user.email || user.username || "").toLowerCase();
    if (!email.endsWith("@papr.ai")) continue;
    paprTeam.push({
      createdAt: follower.createdAt,
      email,
      name: user.displayName || user.fullname || email,
      userId: user.objectId,
    });
  }

  console.log(
    `@papr.ai users with isMember=true on ${WORKSPACE_ID}: ${paprTeam.length}\n`,
  );
  for (const row of paprTeam) {
    console.log(`${row.createdAt.slice(0, 10)}  ${row.name}  ${row.email}`);
  }

  const expected = ["wasseem", "ryan", "hassan", "corey"];
  console.log("\nExpected names missing from @papr.ai isMember list:");
  for (const name of expected) {
    const hit = paprTeam.some(
      (row) =>
        row.name.toLowerCase().includes(name) ||
        row.email.toLowerCase().includes(name),
    );
    if (!hit) {
      console.log(`  - ${name} (no @papr.ai isMember row found)`);
    }
  }

  const corey = await restGet(sessionToken, "/users", {
    where: JSON.stringify({
      $or: [
        { email: { $regex: "corey", $options: "i" } },
        { displayName: { $regex: "corey", $options: "i" } },
      ],
    }),
    limit: "20",
  });
  const expectedEmails = [
    "wasseem@papr.ai",
    "waseem@papr.ai",
    "ryan@papr.ai",
    "hassan@papr.ai",
    "corey@papr.ai",
    "cbadcock@gmail.com",
  ];
  console.log("\nExpected email accounts:");
  for (const email of expectedEmails) {
    const users = await restGet(sessionToken, "/users", {
      where: JSON.stringify({ email }),
      limit: "3",
    });
    if (users.results.length === 0) {
      console.log(`  ${email} -> NO Parse user`);
      continue;
    }
    for (const user of users.results) {
      const rows = await restGet(sessionToken, "/classes/workspace_follower", {
        where: JSON.stringify({
          workspace: {
            __type: "Pointer",
            className: "WorkSpace",
            objectId: WORKSPACE_ID,
          },
          user: {
            __type: "Pointer",
            className: "_User",
            objectId: user.objectId,
          },
        }),
        limit: "3",
      });
      const follower = rows.results[0];
      console.log(
        `  ${email} -> ${user.displayName || user.fullname || user.objectId} | follower=${follower ? `isMember=${follower.isMember}` : "NONE"}`,
      );
    }
  }

  console.log("\nCorey accounts with follower rows:");
  for (const user of corey.results) {
    const email = user.email || user.username || "";
    const rows = await restGet(sessionToken, "/classes/workspace_follower", {
      where: JSON.stringify({
        workspace: {
          __type: "Pointer",
          className: "WorkSpace",
          objectId: WORKSPACE_ID,
        },
        user: {
          __type: "Pointer",
          className: "_User",
          objectId: user.objectId,
        },
      }),
      limit: "3",
    });
    const follower = rows.results[0];
    console.log(
      `  ${user.displayName || user.fullname || email} | ${email} | follower=${follower ? `isMember=${follower.isMember}` : "NONE"}`,
    );
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("FAILED:", error.message);
    app.exit(1);
  });
