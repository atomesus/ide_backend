#!/usr/bin/env node
// Creates/alters the SQL tables (users, api_keys). Use on first deploy; production boots do not sync.
const { connectSql, sequelize } = require("../src/db/sql");
(async () => {
  await connectSql();
  await sequelize.sync({ alter: process.argv.includes("--alter") });
  console.log("SQL schema synced");
  await sequelize.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
