import { app, Notification } from "electron";
import { createAttentionService } from "./attention-service.mjs";
export const createAttention = options => createAttentionService({ ...options, app, Notification });
