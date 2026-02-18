/**
 * Meetings WebSocket Handlers
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import { getMeetingsService } from "../services/MeetingsService.js";
import type { MeetingCreateInput, MeetingUpdateInput } from "../services/MeetingsService.js";

export async function setupMeetingsHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const service = getMeetingsService();
  await service.initialize();

  try {
    switch (message.type) {
      case "meetings:list": {
        const meetings = await service.listMeetings();
        sendResponse(ws, { id: message.id, success: true, data: meetings });
        break;
      }

      case "meetings:upcoming": {
        const meetings = await service.listUpcoming();
        sendResponse(ws, { id: message.id, success: true, data: meetings });
        break;
      }

      case "meetings:create": {
        const payload = message.payload as MeetingCreateInput;
        const meeting = await service.createMeeting(payload);
        sendResponse(ws, { id: message.id, success: true, data: meeting });
        break;
      }

      case "meetings:get": {
        const { meetingId } = message.payload as { meetingId: string };
        const meeting = await service.getMeeting(meetingId);
        sendResponse(ws, { id: message.id, success: true, data: meeting });
        break;
      }

      case "meetings:update": {
        const { meetingId, ...updates } = message.payload as { meetingId: string } & MeetingUpdateInput;
        const meeting = await service.updateMeeting(meetingId, updates);
        sendResponse(ws, { id: message.id, success: true, data: meeting });
        break;
      }

      case "meetings:delete": {
        const { meetingId } = message.payload as { meetingId: string };
        const success = await service.deleteMeeting(meetingId);
        sendResponse(ws, { id: message.id, success: true, data: { success } });
        break;
      }

      case "meetings:start-recording": {
        const { meetingId } = message.payload as { meetingId: string };
        const meeting = await service.startRecording(meetingId);
        sendResponse(ws, { id: message.id, success: true, data: meeting });
        break;
      }

      case "meetings:stop-recording": {
        const { meetingId, duration } = message.payload as { meetingId: string; duration: number };
        const meeting = await service.stopRecording(meetingId, duration);
        sendResponse(ws, { id: message.id, success: true, data: meeting });
        break;
      }

      case "meetings:set-transcript": {
        const { meetingId, transcript } = message.payload as { meetingId: string; transcript: string };
        const meeting = await service.setTranscript(meetingId, transcript);
        sendResponse(ws, { id: message.id, success: true, data: meeting });
        break;
      }

      case "meetings:set-summary": {
        const { meetingId, summary } = message.payload as { meetingId: string; summary: string };
        const meeting = await service.setSummary(meetingId, summary);
        sendResponse(ws, { id: message.id, success: true, data: meeting });
        break;
      }

      default:
        sendError(ws, message.id, `Unknown meetings type: ${message.type}`);
    }
  } catch (error) {
    console.error("[Meetings WS] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
