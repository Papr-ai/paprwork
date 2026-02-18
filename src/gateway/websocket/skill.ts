import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendError, sendResponse } from "./index.js";
import { getSkillService } from "../services/SkillService.js";

interface SkillIdPayload {
  skillId: string;
}

interface CreateSkillPayload {
  name: string;
  description: string;
  content: string;
}

interface UpdateSkillPayload {
  skillId: string;
  name?: string;
  description?: string;
  content?: string;
}

interface InstallCatalogSkillPayload {
  source: "clawhub" | "skills.sh";
  catalogId: string;
}

interface ToggleSkillPayload {
  skillId: string;
  enabled: boolean;
}

interface SkillAccessPayload {
  skillId: string;
  agentIds: string[];
}

export async function setupSkillHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const skillService = getSkillService();

  try {
    switch (message.type) {
      case "skill:list": {
        const skills = await skillService.listSkills();
        sendResponse(ws, { id: message.id, success: true, data: skills });
        break;
      }
      case "skill:get": {
        const payload = message.payload as SkillIdPayload;
        const skill = await skillService.getSkill(payload.skillId);
        if (!skill) {
          sendError(ws, message.id, `Skill not found: ${payload.skillId}`);
          return;
        }
        sendResponse(ws, { id: message.id, success: true, data: skill });
        break;
      }
      case "skill:create": {
        const payload = message.payload as CreateSkillPayload;
        const skill = await skillService.createSkill(payload);
        sendResponse(ws, { id: message.id, success: true, data: skill });
        break;
      }
      case "skill:update": {
        const payload = message.payload as UpdateSkillPayload;
        const skill = await skillService.updateSkill(payload.skillId, {
          name: payload.name,
          description: payload.description,
          content: payload.content,
        });
        if (!skill) {
          sendError(ws, message.id, `Skill not found: ${payload.skillId}`);
          return;
        }
        sendResponse(ws, { id: message.id, success: true, data: skill });
        break;
      }
      case "skill:delete": {
        const payload = message.payload as SkillIdPayload;
        const deleted = await skillService.deleteSkill(payload.skillId);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { deleted },
        });
        break;
      }
      case "skill:catalog": {
        const skills = await skillService.listCatalogSkills();
        sendResponse(ws, { id: message.id, success: true, data: skills });
        break;
      }
      case "skill:install-catalog": {
        const payload = message.payload as InstallCatalogSkillPayload;
        const installed = await skillService.installCatalogSkill(payload);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: installed,
        });
        break;
      }
      case "skill:toggle-enabled": {
        const payload = message.payload as ToggleSkillPayload;
        const updated = await skillService.setEnabled(
          payload.skillId,
          payload.enabled,
        );
        if (!updated) {
          sendError(ws, message.id, `Skill not found: ${payload.skillId}`);
          return;
        }
        sendResponse(ws, { id: message.id, success: true, data: updated });
        break;
      }
      case "skill:set-access": {
        const payload = message.payload as SkillAccessPayload;
        const updated = await skillService.setAgentAccess(
          payload.skillId,
          payload.agentIds,
        );
        if (!updated) {
          sendError(ws, message.id, `Skill not found: ${payload.skillId}`);
          return;
        }
        sendResponse(ws, { id: message.id, success: true, data: updated });
        break;
      }
      default:
        sendError(ws, message.id, `Unknown skill message type: ${message.type}`);
    }
  } catch (error) {
    console.error("[Skill WebSocket] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
