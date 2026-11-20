import path from "node:path";
import { loadConfig } from "./config/index.js";
import { AppDatabase } from "./storage/index.js";

const [action, accountId, contactId] = process.argv.slice(2);
const config = loadConfig();
const database = new AppDatabase(path.join(config.server.dataDir, "weixin-household-gateway.sqlite"));
try {
  database.initialize();
  if (action === "list") {
    console.log(JSON.stringify(database.listAdminContacts(), null, 2));
  } else if ((action === "grant" || action === "revoke") && accountId && contactId) {
    database.setAdminContact(accountId, contactId, action === "grant");
    console.log("联系人授权已更新，下一个任务开始前生效。");
  } else {
    throw new Error("Usage: admin-contacts list | grant <account-id> <contact-id> | revoke <account-id> <contact-id>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
