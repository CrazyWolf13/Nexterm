const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const {
    assertNoUrlCredentials,
    buildSourceHeaders,
    buildSourceUrl,
    decryptSourceToken,
    describeIndexFailure,
    encryptSourceToken,
    isSameOrigin,
    toPublicSource,
} = require("../utils/sourceRequest");
const { sourceCreationValidation, sourceUpdateValidation, validateUrlValidation } = require("../validations/source");
const migration = require("../migrations/0044-add-source-auth-token");

const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
});

const close = ({ server }) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
});

test("buildSourceUrl appends the file to the base path", () => {
    assert.equal(buildSourceUrl("https://source.nexterm.dev", "NTINDEX"), "https://source.nexterm.dev/NTINDEX");
    assert.equal(
        buildSourceUrl("https://raw.githubusercontent.com/me/repo/main/nexterm", "scripts/a.sh"),
        "https://raw.githubusercontent.com/me/repo/main/nexterm/scripts/a.sh",
    );
});

test("buildSourceUrl keeps a query string behind the file path", () => {
    assert.equal(
        buildSourceUrl("https://api.github.com/repos/me/snips/contents?ref=dev", "snippets/update.snippet"),
        "https://api.github.com/repos/me/snips/contents/snippets/update.snippet?ref=dev",
    );
    assert.equal(
        buildSourceUrl("https://api.github.com/repos/me/snips/contents/?ref=dev", "NTINDEX"),
        "https://api.github.com/repos/me/snips/contents/NTINDEX?ref=dev",
    );
});

test("buildSourceUrl encodes path segments and ignores ./ prefixes", () => {
    assert.equal(
        buildSourceUrl("https://example.com/s", "./snippets/my file#1.snippet"),
        "https://example.com/s/snippets/my%20file%231.snippet",
    );
});

test("buildSourceUrl rejects parent segments only when restricted to the source root", () => {
    const base = "https://api.github.com/repos/me/a/contents";

    assert.throws(() => buildSourceUrl(base, "../../b/contents/secret.sh", { restrictToBase: true }), /escapes the source root/);
    assert.throws(() => buildSourceUrl(base, "a/../../b", { restrictToBase: true }), /escapes the source root/);

    // an encoded dot segment is just a file name, it cannot climb out either
    assert.equal(buildSourceUrl("https://example.com/s", "%2e%2e/x", { restrictToBase: true }), "https://example.com/s/%252e%252e/x");

    // sources without a token behave exactly as before
    assert.equal(buildSourceUrl("https://example.com/s/nexterm", "../shared/x.sh"), "https://example.com/s/shared/x.sh");
});

test("buildSourceHeaders only adds the bearer token when one is set", () => {
    assert.deepEqual(buildSourceHeaders("https://source.nexterm.dev/NTINDEX", null), { "User-Agent": "Nexterm/1.0" });
    assert.deepEqual(buildSourceHeaders("https://source.nexterm.dev/NTINDEX", "tok"), {
        "User-Agent": "Nexterm/1.0",
        Authorization: "Bearer tok",
    });
});

test("buildSourceHeaders asks the GitHub API for raw file content", () => {
    const headers = buildSourceHeaders("https://api.github.com/repos/me/r/contents/NTINDEX", "tok");

    assert.equal(headers.Accept, "application/vnd.github.raw+json");
    assert.equal(headers.Authorization, "Bearer tok");
    assert.equal(buildSourceHeaders("https://api.github.com/repos/me/r/contents/NTINDEX", null).Accept, "application/vnd.github.raw+json");
    assert.equal(buildSourceHeaders("https://raw.githubusercontent.com/me/r/main/NTINDEX", "tok").Accept, undefined);
});

test("describeIndexFailure points at the access token", () => {
    assert.match(describeIndexFailure(404, false), /private repositories need an access token/);
    assert.match(describeIndexFailure(404, true), /token can read this repository/);
    assert.match(describeIndexFailure(401, true), /rejected or lacks permission/);
    assert.match(describeIndexFailure(403, false), /requires an access token/);
    assert.equal(describeIndexFailure(500, true), "Failed to fetch NTINDEX: HTTP 500");
});

test("source tokens are encrypted at rest and decrypt back", () => {
    const stored = encryptSourceToken("github_pat_secret");

    assert.notEqual(stored.authToken, "github_pat_secret");
    assert.ok(!JSON.stringify(stored).includes("github_pat_secret"));
    assert.equal(decryptSourceToken(stored), "github_pat_secret");
    assert.notEqual(encryptSourceToken("github_pat_secret").authToken, stored.authToken, "every encryption needs a fresh IV");
});

test("removing a token clears every stored column", () => {
    const cleared = { authToken: null, authTokenIV: null, authTokenAuthTag: null };

    assert.deepEqual(encryptSourceToken(null), cleared);
    assert.deepEqual(encryptSourceToken(""), cleared);
    assert.equal(decryptSourceToken(cleared), null);
});

test("a changed ENCRYPTION_KEY gives an actionable error instead of a raw crypto failure", () => {
    const stored = encryptSourceToken("tok");
    const originalKey = process.env.ENCRYPTION_KEY;

    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    try {
        assert.throws(() => decryptSourceToken(stored), /could not be decrypted/);
    } finally {
        process.env.ENCRYPTION_KEY = originalKey;
    }
});

test("toPublicSource never exposes the token, its ciphertext or its IV", () => {
    const row = {
        id: 1,
        name: "Private",
        url: "https://api.github.com/repos/me/r/contents",
        enabled: true,
        ...encryptSourceToken("github_pat_secret"),
    };
    const source = toPublicSource(row);

    assert.deepEqual(Object.keys(source).sort(), ["enabled", "hasAuthToken", "id", "name", "url"]);
    assert.equal(source.hasAuthToken, true);
    assert.equal(toPublicSource({ id: 2, authToken: null }).hasAuthToken, false);
});

test("toPublicSource unwraps model instances", () => {
    const instance = { get: () => ({ id: 3, ...encryptSourceToken("tok") }) };

    assert.equal(toPublicSource(instance).hasAuthToken, true);
    assert.equal(toPublicSource(instance).authToken, undefined);
});

test("credentials in the source URL are refused without echoing them", () => {
    assert.throws(
        () => assertNoUrlCredentials("https://user:s3cret@example.com/x"),
        (error) => /access token field/.test(error.message) && !error.message.includes("s3cret"),
    );
    assert.doesNotThrow(() => assertNoUrlCredentials("https://example.com/x"));
});

test("isSameOrigin compares scheme, host and port", () => {
    assert.equal(isSameOrigin("https://api.github.com/repos/a", "https://api.github.com/repos/b"), true);
    assert.equal(isSameOrigin("https://api.github.com", "https://evil.example"), false);
    assert.equal(isSameOrigin("https://example.com", "http://example.com"), false);
    assert.equal(isSameOrigin("https://example.com", "not a url"), false);
});

test("source validation accepts GitHub style tokens and trims them", () => {
    const { error, value } = sourceCreationValidation.validate({
        name: "Private",
        url: "https://api.github.com/repos/me/r/contents?ref=main",
        authToken: "  github_pat_11AAAA_bbbb  ",
    });

    assert.equal(error, undefined);
    assert.equal(value.authToken, "github_pat_11AAAA_bbbb");
});

test("source validation rejects tokens that cannot be sent in a header", () => {
    for (const authToken of ["has space", "line\nbreak", "ünïcode"]) {
        const { error } = sourceCreationValidation.validate({ name: "x", url: "https://example.com", authToken });
        assert.ok(error, `${JSON.stringify(authToken)} should be rejected`);
    }
});

test("updates can remove a token with null or an empty string, unknown keys stay rejected", () => {
    assert.equal(sourceUpdateValidation.validate({ authToken: null }).error, undefined);
    assert.equal(sourceUpdateValidation.validate({ authToken: "" }).error, undefined);
    assert.ok(sourceUpdateValidation.validate({ removeToken: true }).error);
    assert.equal(validateUrlValidation.validate({ url: "https://example.com", authToken: "tok" }).error, undefined);
});

test("fetch drops the Authorization header when a source redirects to another origin", async () => {
    const seen = {};
    const target = await listen((req, res) => {
        seen.target = req.headers;
        res.end("ok");
    });
    const origin = await listen((req, res) => {
        seen.origin = req.headers;
        res.writeHead(302, { Location: `${target.origin}/file` });
        res.end();
    });

    try {
        const url = `${origin.origin}/NTINDEX`;
        const response = await fetch(url, { headers: buildSourceHeaders(url, "tok-123") });

        assert.equal(await response.text(), "ok");
        assert.equal(seen.origin.authorization, "Bearer tok-123");
        assert.equal(seen.target.authorization, undefined);
    } finally {
        await close(origin);
        await close(target);
    }
});

const fakeQueryInterface = (existingColumns) => {
    const added = [];

    return {
        added,
        describeTable: async (table) => {
            assert.equal(table, "sources");
            return Object.fromEntries(existingColumns.map((column) => [column, {}]));
        },
        addColumn: async (table, column, definition) => {
            added.push({ table, column, definition });
        },
    };
};

test("migration adds the three token columns to sources", async () => {
    const queryInterface = fakeQueryInterface(["id", "name", "url"]);

    await migration.up(queryInterface, { TEXT: "TEXT", STRING: "STRING" });

    assert.deepEqual(queryInterface.added.map(({ column }) => column), ["authToken", "authTokenIV", "authTokenAuthTag"]);
    assert.ok(queryInterface.added.every(({ table, definition }) => table === "sources" && definition.allowNull === true));
});

test("migration skips columns the model already created", async () => {
    const queryInterface = fakeQueryInterface(["id", "authToken", "authTokenIV", "authTokenAuthTag"]);

    await migration.up(queryInterface, { TEXT: "TEXT", STRING: "STRING" });

    assert.deepEqual(queryInterface.added, []);
});
