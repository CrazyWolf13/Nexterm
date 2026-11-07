const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { Op } = require("sequelize");

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

// In-memory stand-ins for the Sequelize models: the real ones need a database connection,
// while this test is about what the source controller sends over the wire and stores.
const matches = (row, where = {}) => Object.entries(where).every(([key, condition]) => {
    if (condition !== null && typeof condition === "object") {
        return Reflect.ownKeys(condition).every((operator) => operator === Op.ne && row[key] !== condition[operator]);
    }
    return row[key] === condition;
});

const createFakeModel = () => {
    let rows = [];
    let nextId = 1;

    return {
        reset: () => {
            rows = [];
            nextId = 1;
        },
        rows: () => rows,
        create: async (data) => {
            const row = { id: nextId++, ...data };
            rows.push(row);
            return { ...row };
        },
        findByPk: async (id) => {
            const row = rows.find((item) => item.id === id);
            return row ? { ...row } : null;
        },
        findOne: async ({ where }) => {
            const row = rows.find((item) => matches(item, where));
            return row ? { ...row } : null;
        },
        findAll: async ({ where } = {}) => rows.filter((item) => matches(item, where)).map((row) => ({ ...row })),
        update: async (values, { where }) => {
            rows.filter((item) => matches(item, where)).forEach((row) => Object.assign(row, values));
        },
        destroy: async ({ where }) => {
            rows = rows.filter((item) => !matches(item, where));
        },
    };
};

const Source = createFakeModel();
const Snippet = createFakeModel();
const Script = createFakeModel();
const Theme = createFakeModel();

const stub = (modulePath, exports) => {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub("../models/Source", Source);
stub("../models/Snippet", Snippet);
stub("../models/Script", Script);
stub("../models/Theme", Theme);
stub("../utils/logger", { info() {}, warn() {}, error() {}, system() {}, debug() {} });
stub("../utils/ssrf", { assertPublicUrl: async () => {} }); // the test servers listen on loopback

const { createSource, updateSource, getSource, listSources, syncSource, validateSourceUrl } = require("../controllers/source");

test.beforeEach(() => [Source, Snippet, Script, Theme].forEach((model) => model.reset()));

const INDEX = "snippets/update.snippet@aaa\nscripts/disk.sh@bbb\n";
const FILES = {
    "snippets/update.snippet": "# @name: Update packages\n# @description: apt upgrade\nsudo apt update && sudo apt upgrade -y",
    "scripts/disk.sh": "# @name: Disk usage\n# @description: df\n\ndf -h",
};

// Mimics a private GitHub repository: 404 without credentials (GitHub hides private repositories),
// 401 for a wrong token. With token: null it behaves like a public host.
const startRepoServer = async ({ token = "ghp_valid", index = INDEX, prefix = "/repos/me/snips/contents" } = {}) => {
    const requests = [];
    const state = { token };

    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, authorization: req.headers.authorization });

        if (state.token) {
            if (!req.headers.authorization) {
                res.writeHead(404);
                return res.end("Not Found");
            }
            if (req.headers.authorization !== `Bearer ${state.token}`) {
                res.writeHead(401);
                return res.end("Bad credentials");
            }
        }

        const { pathname } = new URL(req.url, "http://localhost");
        if (!pathname.startsWith(`${prefix}/`)) {
            res.writeHead(404);
            return res.end();
        }

        const file = decodeURIComponent(pathname.slice(prefix.length + 1));
        const body = file === "NTINDEX" ? index : FILES[file];
        if (body === undefined) {
            res.writeHead(404);
            return res.end();
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(body);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        prefix,
        requests,
        state,
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
        }),
    };
};

test("syncs a private repository with an access token that is encrypted at rest", async () => {
    const repo = await startRepoServer();

    try {
        const created = await createSource({ name: "Private", url: `${repo.origin}${repo.prefix}?ref=dev`, authToken: "ghp_valid" });
        assert.equal(created.code, undefined);

        const [row] = Source.rows();
        assert.notEqual(row.authToken, "ghp_valid");
        assert.ok(row.authTokenIV && row.authTokenAuthTag);
        assert.ok(!JSON.stringify(row).includes("ghp_valid"));
        assert.equal(row.lastSyncStatus, "success");
        assert.equal(row.snippetCount, 1);
        assert.equal(row.scriptCount, 1);

        assert.deepEqual(Snippet.rows().map((snippet) => snippet.name), ["Update packages"]);
        assert.deepEqual(Script.rows().map((script) => script.name), ["Disk usage"]);

        assert.ok(repo.requests.length >= 3);
        assert.ok(repo.requests.every((request) => request.authorization === "Bearer ghp_valid"));
        assert.ok(repo.requests.every((request) => request.url.endsWith("?ref=dev")), "the ref must survive on every request");

        for (const source of [(await listSources())[0], await getSource(created.id)]) {
            assert.equal(source.hasAuthToken, true);
            assert.ok(!JSON.stringify(source).includes("ghp_valid"));
            assert.deepEqual(
                [source.authToken, source.authTokenIV, source.authTokenAuthTag],
                [undefined, undefined, undefined],
            );
        }
    } finally {
        await repo.close();
    }
});

test("public sources keep working without any authorization header", async () => {
    const repo = await startRepoServer({ token: null });

    try {
        const { id } = await createSource({ name: "Public", url: `${repo.origin}${repo.prefix}` });

        assert.ok(repo.requests.length >= 3);
        assert.ok(repo.requests.every((request) => request.authorization === undefined));

        const source = await getSource(id);
        assert.equal(source.hasAuthToken, false);
        assert.equal(source.snippetCount, 1);
    } finally {
        await repo.close();
    }
});

test("tells the user a token is needed when a private repository is added without one", async () => {
    const repo = await startRepoServer();

    try {
        const result = await createSource({ name: "Private", url: `${repo.origin}${repo.prefix}` });

        assert.equal(result.code, 400);
        assert.match(result.message, /HTTP 404/);
        assert.match(result.message, /access token/);
        assert.equal(Source.rows().length, 0);
    } finally {
        await repo.close();
    }
});

test("reports a rejected token", async () => {
    const repo = await startRepoServer();

    try {
        const result = await createSource({ name: "Private", url: `${repo.origin}${repo.prefix}`, authToken: "ghp_wrong" });

        assert.equal(result.code, 400);
        assert.match(result.message, /rejected or lacks permission/);
        assert.equal(Source.rows().length, 0);
    } finally {
        await repo.close();
    }
});

test("refuses credentials in the URL and does not echo them back", async () => {
    const result = await validateSourceUrl("http://user:s3cret@127.0.0.1:1/x");

    assert.equal(result.valid, false);
    assert.match(result.error, /access token field/);
    assert.ok(!result.error.includes("s3cret"));
});

test("keeps synced content when the token stops working and recovers once it is replaced", async () => {
    const repo = await startRepoServer({ token: "ghp_old" });

    try {
        const { id } = await createSource({ name: "Private", url: `${repo.origin}${repo.prefix}`, authToken: "ghp_old" });
        repo.state.token = "ghp_new"; // revoked or rotated on GitHub

        const failed = await syncSource(id);
        assert.equal(failed.success, false);
        assert.match(failed.error, /rejected or lacks permission/);
        assert.equal(Snippet.rows().length, 1, "a failed sync must not delete anything");
        assert.equal((await Source.findByPk(id)).lastSyncStatus, "error");

        const updated = await updateSource(id, { authToken: "ghp_new" });
        assert.equal(updated.code, undefined);
        assert.equal(updated.hasAuthToken, true);
        assert.equal((await Source.findByPk(id)).lastSyncStatus, "success");
        assert.equal(repo.requests.at(-1).authorization, "Bearer ghp_new");
    } finally {
        await repo.close();
    }
});

test("renaming a source neither syncs it nor touches the stored token", async () => {
    const repo = await startRepoServer();

    try {
        const { id } = await createSource({ name: "Private", url: `${repo.origin}${repo.prefix}`, authToken: "ghp_valid" });
        const storedToken = Source.rows()[0].authToken;
        const requestsBefore = repo.requests.length;

        await updateSource(id, { name: "Renamed" });

        assert.equal(repo.requests.length, requestsBefore);
        assert.equal(Source.rows()[0].name, "Renamed");
        assert.equal(Source.rows()[0].authToken, storedToken);
    } finally {
        await repo.close();
    }
});

test("never sends a stored token to another host", async () => {
    const repo = await startRepoServer();
    const other = await startRepoServer({ token: null });

    try {
        const repoUrl = `${repo.origin}${repo.prefix}`;
        const { id } = await createSource({ name: "Private", url: repoUrl, authToken: "ghp_valid" });

        const refused = await updateSource(id, { url: `${other.origin}${other.prefix}` });
        assert.equal(refused.code, 400);
        assert.match(refused.message, /Changing the host/);
        assert.equal(other.requests.length, 0, "the other host must not receive a single request");
        assert.equal((await Source.findByPk(id)).url, repoUrl);

        const sameHost = await updateSource(id, { url: `${repoUrl}?ref=dev` });
        assert.equal(sameHost.code, undefined);
        assert.equal(repo.requests.at(-1).authorization, "Bearer ghp_valid");

        const moved = await updateSource(id, { url: `${other.origin}${other.prefix}`, authToken: null });
        assert.equal(moved.code, undefined);
        assert.equal(moved.hasAuthToken, false);
        assert.ok(other.requests.length > 0);
        assert.ok(other.requests.every((request) => request.authorization === undefined));
    } finally {
        await repo.close();
        await other.close();
    }
});

test("does not follow index entries that leave the source root while a token is configured", async () => {
    const repo = await startRepoServer({ index: "snippets/update.snippet@aaa\n../other/secret.sh@bbb\n" });

    try {
        const { id } = await createSource({ name: "Private", url: `${repo.origin}${repo.prefix}`, authToken: "ghp_valid" });

        assert.ok(repo.requests.every((request) => request.url.startsWith(`${repo.prefix}/`)));
        assert.equal((await Source.findByPk(id)).lastSyncStatus, "error", "an incomplete sync has to be flagged");
        assert.deepEqual(Snippet.rows().map((snippet) => snippet.name), ["Update packages"]);
    } finally {
        await repo.close();
    }
});

test("a changed ENCRYPTION_KEY fails the sync without sending any request", async () => {
    const repo = await startRepoServer();
    const originalKey = process.env.ENCRYPTION_KEY;

    try {
        const { id } = await createSource({ name: "Private", url: `${repo.origin}${repo.prefix}`, authToken: "ghp_valid" });
        const requestsBefore = repo.requests.length;

        process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

        const result = await syncSource(id);
        assert.equal(result.success, false);
        assert.match(result.error, /could not be decrypted/);
        assert.equal(repo.requests.length, requestsBefore);

        const refused = await updateSource(id, { url: `${repo.origin}${repo.prefix}?ref=dev` });
        assert.equal(refused.code, 400);
        assert.match(refused.message, /could not be decrypted/);
    } finally {
        process.env.ENCRYPTION_KEY = originalKey;
        await repo.close();
    }
});
