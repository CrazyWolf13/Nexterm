module.exports = {
    async up(queryInterface, Sequelize) {
        const columns = await queryInterface.describeTable("sources");

        if (!columns.authToken) {
            await queryInterface.addColumn("sources", "authToken", {
                type: Sequelize.TEXT,
                allowNull: true,
            });
        }

        if (!columns.authTokenIV) {
            await queryInterface.addColumn("sources", "authTokenIV", {
                type: Sequelize.STRING,
                allowNull: true,
            });
        }

        if (!columns.authTokenAuthTag) {
            await queryInterface.addColumn("sources", "authTokenAuthTag", {
                type: Sequelize.STRING,
                allowNull: true,
            });
        }
    },
};
