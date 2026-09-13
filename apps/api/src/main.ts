import "reflect-metadata";
import { createApplication } from "./application.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const app = await createApplication(config);

await app.listen(config.port, config.host);
