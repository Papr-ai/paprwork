/**
 * useMeetings – React hook for meeting management
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { gateway } from "../src/lib/gateway";

// ---------- Types ----------

export interface Meeting {
  id: string;
  title: string;
  date: string;
  duration: number;
  status: "scheduled" | "recording" | "completed" | "cancelled";
  notes: string;
  transcript: string;
  summary: string;
  participants: string[];
  calendarEventId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingCreateInput {
  title: string;
  date: string;
  duration?: number;
  participants?: string[];
  notes?: string;
}

// ---------- Hook ----------

export function useMeetings() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const listenersAttached = useRef(false);

  const loadMeetings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await gateway.send("meetings:list", {});
      if (response.success && Array.isArray(response.data)) {
        setMeetings(response.data as Meeting[]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!listenersAttached.current) {
      listenersAttached.current = true;
      void loadMeetings();
    }
  }, [loadMeetings]);

  const createMeeting = useCallback(
    async (input: MeetingCreateInput): Promise<Meeting | null> => {
      try {
        const response = await gateway.send("meetings:create", input);
        if (response.success && response.data) {
          const meeting = response.data as Meeting;
          setMeetings((prev) => [meeting, ...prev]);
          return meeting;
        }
        return null;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [],
  );

  const updateMeeting = useCallback(
    async (
      meetingId: string,
      updates: Partial<Meeting>,
    ): Promise<Meeting | null> => {
      try {
        const response = await gateway.send("meetings:update", {
          meetingId,
          ...updates,
        });
        if (response.success && response.data) {
          const updated = response.data as Meeting;
          setMeetings((prev) =>
            prev.map((m) => (m.id === meetingId ? updated : m)),
          );
          return updated;
        }
        return null;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [],
  );

  const deleteMeeting = useCallback(async (meetingId: string) => {
    try {
      await gateway.send("meetings:delete", { meetingId });
      setMeetings((prev) => prev.filter((m) => m.id !== meetingId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const startRecording = useCallback(
    async (meetingId: string): Promise<Meeting | null> => {
      try {
        const response = await gateway.send("meetings:start-recording", {
          meetingId,
        });
        if (response.success && response.data) {
          const updated = response.data as Meeting;
          setMeetings((prev) =>
            prev.map((m) => (m.id === meetingId ? updated : m)),
          );
          return updated;
        }
        return null;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [],
  );

  const stopRecording = useCallback(
    async (meetingId: string, duration: number): Promise<Meeting | null> => {
      try {
        const response = await gateway.send("meetings:stop-recording", {
          meetingId,
          duration,
        });
        if (response.success && response.data) {
          const updated = response.data as Meeting;
          setMeetings((prev) =>
            prev.map((m) => (m.id === meetingId ? updated : m)),
          );
          return updated;
        }
        return null;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [],
  );

  return {
    meetings,
    loading,
    error,
    loadMeetings,
    createMeeting,
    updateMeeting,
    deleteMeeting,
    startRecording,
    stopRecording,
  };
}
