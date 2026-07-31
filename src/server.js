const { buildApp } = require("./api");
const { config } = require("./config");
const { createPool, migrate } = require("./db");

async function main() {
  const pool = createPool();
  await migrate(pool);

  buildApp(pool).listen(config.port, () => {
    console.log(`studio listening on ${config.port}, platform at ${config.platformBaseUrl}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
