const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("sources", {
    name: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    url: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    isDefault: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    lastSyncStatus: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    snippetCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    scriptCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    themeCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    // Optional access token for private repositories, encrypted at rest (AES-256-GCM).
    // Never decrypted by a hook on purpose: it is only read while fetching, see sourceRequest.js
    authToken: {
        type: Sequelize.TEXT,
        allowNull: true,
    },
    authTokenIV: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    authTokenAuthTag: {
        type: Sequelize.STRING,
        allowNull: true,
    },
}, { freezeTableName: true, createdAt: true, updatedAt: true });
