require("dotenv").config();

const fs = require("fs");
const mysql = require("mysql2/promise");

async function migrate() {
  console.log("🚀 Starting migration...");

  const schema = fs.readFileSync("./db/schema.sql", "utf8");

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true, // VERY IMPORTANT
  });

  console.log("✅ Connected to Railway MySQL");

  await connection.query(schema);

  console.log("🎉 Schema executed successfully");
  await connection.end();
  process.exit(0);
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
