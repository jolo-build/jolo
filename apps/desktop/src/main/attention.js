import { app, Notification } from "electron";
import { createAttentionService } from "./attention-service.js";
export const createAttention = options => createAttentionService({ ...options, app, Notification });
