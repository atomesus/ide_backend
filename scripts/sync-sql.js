#!/usr/bin/env node
// Creates/alters the ide_* tables inside the platform database. Never touches `Users`.
const { connectSql, sequelize, syncOwnedTables } = require("../src/db/sql");
(async () => {
  await connectSql();
  await syncOwnedTables({ alter: process.argv.includes("--alter") });
  console.log("ide_* tables synced");
  await sequelize.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
