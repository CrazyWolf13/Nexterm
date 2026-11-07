const { encrypt, decrypt } = require("./encryption");

const USER_AGENT = "Nexterm/1.0";
const GITHUB_API_HOST = "api.github.com";

const assertNoUrlCredentials = (url) => {
    const { username, password } = new URL(url);
    if (username || password) {
        throw new Error("Do not put credentials in the source URL, use the access token field instead");
    }
};

const isSameOrigin = (urlA, urlB) => {
    try {
        return new URL(urlA).origin === new URL(urlB).origin;
    } catch {
        return false;
    }
};

// Builds the URL of a file inside a source. In contrast to plain string concatenation this keeps
// a query string intact (e.g. "?ref=main" for the GitHub contents API) and encodes the path.
// With restrictToBase, ".." segments are rejected, so an index entry can never point a request
// (and with it the access token) at anything outside of the configured source root.
const buildSourceUrl = (baseUrl, path, { restrictToBase = false } = {}) => {
    const url = new URL(baseUrl);
    const segments = String(path).split("/").filter((segment) => segment !== "" && segment !== ".");

    if (restrictToBase && segments.includes("..")) {
        throw new Error(`Path escapes the source root: ${path}`);
    }

    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${segments.map(encodeURIComponent).join("/")}`;
    return url.toString();
};

const buildSourceHeaders = (url, authToken) => {
    const headers = { "User-Agent": USER_AGENT };

    // The GitHub contents API answers with JSON unless the raw media type is requested
    if (new URL(url).hostname === GITHUB_API_HOST) {
        headers.Accept = "application/vnd.github.raw+json";
    }

    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }

    return headers;
};

const describeIndexFailure = (status, hasToken) => {
    const message = `Failed to fetch NTINDEX: HTTP ${status}`;

    if (status === 401 || status === 403) {
        return hasToken
            ? `${message} - the access token was rejected or lacks permission`
            : `${message} - this source requires an access token`;
    }

    if (status === 404) {
        return hasToken
            ? `${message} - check the URL and that the access token can read this repository`
            : `${message} - check the URL, private repositories need an access token`;
    }

    return message;
};

const encryptSourceToken = (token) => {
    if (!token) return { authToken: null, authTokenIV: null, authTokenAuthTag: null };

    const { encrypted, iv, authTag } = encrypt(token);
    return { authToken: encrypted, authTokenIV: iv, authTokenAuthTag: authTag };
};

const decryptSourceToken = (source) => {
    if (!source?.authToken) return null;

    try {
        return decrypt(source.authToken, source.authTokenIV, source.authTokenAuthTag);
    } catch {
        throw new Error("The stored access token could not be decrypted (was the ENCRYPTION_KEY changed?), enter it again");
    }
};

// What the API may expose: never the token itself, nor its ciphertext, IV or auth tag
const toPublicSource = (source) => {
    const plain = typeof source.get === "function" ? source.get({ plain: true }) : source;
    const { authToken, authTokenIV, authTokenAuthTag, ...rest } = plain;
    return { ...rest, hasAuthToken: Boolean(authToken) };
};

module.exports = {
    assertNoUrlCredentials,
    buildSourceHeaders,
    buildSourceUrl,
    decryptSourceToken,
    describeIndexFailure,
    encryptSourceToken,
    isSameOrigin,
    toPublicSource,
};
