/**
 * MeetingsView – Full meetings management interface
 *
 * Shows upcoming and past meetings with create, edit, record,
 * transcription and summary capabilities.
 */

import React, { useState, useCallback, useMemo } from "react";
import { useMeetings } from "../../hooks/useMeetings";
import type { Meeting, MeetingCreateInput } from "../../hooks/useMeetings";
import { MeetingDetail } from "./MeetingDetail";
import "./MeetingsView.css";

type ViewFilter = "all" | "upcoming" | "completed";

export function MeetingsView() {
  const {
    meetings,
    loading,
    error,
    createMeeting,
    deleteMeeting,
    updateMeeting,
    startRecording,
    stopRecording,
  } = useMeetings();

  const [filter, setFilter] = useState<ViewFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  // ---- Form state ----
  const [newTitle, setNewTitle] = useState("");
  const [newDate, setNewDate] = useState("");
  const [newParticipants, setNewParticipants] = useState("");

  // ---- Filtered meetings ----
  const filtered = useMemo(() => {
    const now = new Date();
    return meetings.filter((m) => {
      if (filter === "upcoming") {
        return (
          new Date(m.date) >= now &&
          (m.status === "scheduled" || m.status === "recording")
        );
      }
      if (filter === "completed") {
        return m.status === "completed";
      }
      return true;
    });
  }, [meetings, filter]);

  const selectedMeeting = useMemo(
    () => meetings.find((m) => m.id === selectedId) ?? null,
    [meetings, selectedId],
  );

  // ---- Handlers ----
  const handleCreate = useCallback(async () => {
    if (!newTitle.trim() || !newDate) return;

    const input: MeetingCreateInput = {
      title: newTitle.trim(),
      date: new Date(newDate).toISOString(),
      participants: newParticipants
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    };

    const meeting = await createMeeting(input);
    if (meeting) {
      setSelectedId(meeting.id);
      setShowNewForm(false);
      setNewTitle("");
      setNewDate("");
      setNewParticipants("");
    }
  }, [newTitle, newDate, newParticipants, createMeeting]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteMeeting(id);
      if (selectedId === id) setSelectedId(null);
    },
    [deleteMeeting, selectedId],
  );

  // ---- Loading / Error states ----
  if (loading) {
    return (
      <div className="meetings-view meetings-view--loading">
        <div className="meetings-view__spinner" />
        <span>Loading meetings...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="meetings-view meetings-view--error">
        <span>Error: {error}</span>
      </div>
    );
  }

  // ---- Detail view ----
  if (selectedMeeting) {
    return (
      <MeetingDetail
        meeting={selectedMeeting}
        onBack={() => setSelectedId(null)}
        onUpdate={(updates) => updateMeeting(selectedMeeting.id, updates)}
        onDelete={() => handleDelete(selectedMeeting.id)}
        onStartRecording={() => startRecording(selectedMeeting.id)}
        onStopRecording={(duration) =>
          stopRecording(selectedMeeting.id, duration)
        }
      />
    );
  }

  // ---- List view ----
  return (
    <div className="meetings-view">
      {/* Header */}
      <div className="meetings-view__header">
        <h2>Meetings</h2>
        <button
          className="meetings-view__btn meetings-view__btn--primary"
          onClick={() => setShowNewForm(!showNewForm)}
        >
          {showNewForm ? "Cancel" : "+ New Meeting"}
        </button>
      </div>

      {/* New meeting form */}
      {showNewForm && (
        <div className="meetings-view__new-form">
          <input
            type="text"
            placeholder="Meeting title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="meetings-view__input"
            autoFocus
          />
          <input
            type="datetime-local"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className="meetings-view__input"
          />
          <input
            type="text"
            placeholder="Participants (comma-separated)"
            value={newParticipants}
            onChange={(e) => setNewParticipants(e.target.value)}
            className="meetings-view__input"
          />
          <button
            className="meetings-view__btn meetings-view__btn--primary"
            onClick={handleCreate}
            disabled={!newTitle.trim() || !newDate}
          >
            Create
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="meetings-view__filters">
        {(["all", "upcoming", "completed"] as ViewFilter[]).map((f) => (
          <button
            key={f}
            className={`meetings-view__filter-btn ${
              filter === f ? "meetings-view__filter-btn--active" : ""
            }`}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Meetings list */}
      {filtered.length === 0 ? (
        <div className="meetings-view__empty">
          No {filter !== "all" ? filter : ""} meetings found.
        </div>
      ) : (
        <div className="meetings-view__list">
          {filtered.map((m) => (
            <MeetingCard
              key={m.id}
              meeting={m}
              onClick={() => setSelectedId(m.id)}
              onDelete={() => handleDelete(m.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Sub-component: Meeting Card ----

interface MeetingCardProps {
  meeting: Meeting;
  onClick: () => void;
  onDelete: () => void;
}

function MeetingCard({ meeting, onClick, onDelete }: MeetingCardProps) {
  const dateStr = new Date(meeting.date).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const statusColors: Record<Meeting["status"], string> = {
    scheduled: "var(--accent-blue, #60a5fa)",
    recording: "var(--accent-red, #f87171)",
    completed: "var(--accent-green, #4ade80)",
    cancelled: "var(--text-tertiary, #888)",
  };

  return (
    <div className="meeting-card" onClick={onClick}>
      <div className="meeting-card__header">
        <span
          className="meeting-card__status"
          style={{ backgroundColor: statusColors[meeting.status] }}
        />
        <h3 className="meeting-card__title">{meeting.title}</h3>
        <button
          className="meeting-card__delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete meeting"
        >
          ×
        </button>
      </div>
      <div className="meeting-card__meta">
        <span className="meeting-card__date">{dateStr}</span>
        {meeting.duration > 0 && (
          <span className="meeting-card__duration">
            {Math.round(meeting.duration / 60)}m
          </span>
        )}
        {meeting.participants.length > 0 && (
          <span className="meeting-card__participants">
            {meeting.participants.length} participant
            {meeting.participants.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
      {meeting.summary && (
        <p className="meeting-card__summary">
          {meeting.summary.slice(0, 120)}
          {meeting.summary.length > 120 ? "..." : ""}
        </p>
      )}
    </div>
  );
}
