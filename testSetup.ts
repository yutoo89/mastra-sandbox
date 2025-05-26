import { beforeAll } from "vitest";
import { attachListeners } from "@mastra/evals";
import { mastra } from "./src/mastra/index";

beforeAll(async () => {
  await attachListeners(mastra);
});