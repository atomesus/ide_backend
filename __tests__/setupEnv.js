// Runs before each test file: in-memory SQLite, memory kv (no Redis), local Mongo if reachable.
process.env.NODE_ENV = "test";
process.env.DOTENV_PATH = "/dev/null";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-0123456789";
process.env.DB_DIALECT = "sqlite";
process.env.DB_STORAGE = ":memory:";
process.env.MONGO_URI = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27017";
process.env.MONGO_DB_NAME = "atomesus_ide_test";
process.env.MONGO_REQUIRED = "false";
process.env.REDIS_HOST = "";
process.env.REDIS_URL = "";
process.env.API_PUBLIC_URL = "http://localhost:4100";
process.env.ATOMESUS_BASE_URL = "http://upstream.test/v1";
process.env.ATOMESUS_MODEL = "ethos-6";
process.env.FREE_PLAN_MONTHLY_CREDITS = "10";
