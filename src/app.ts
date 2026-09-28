import express, { Application } from "express";
import cors from "cors";
import router from "./routes";

export function createApp(): Application {
  const app = express();

  // Allow requests from any origin for now.
  // TODO: restrict to the extension's chrome-extension://... origin once it has a stable ID.
  app.use(cors());

  app.use(express.json());

  // Mount all routes
  app.use("/", router);

  return app;
}
