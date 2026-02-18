/**
 * MeetingDetail – Shows full meeting details with notes,
 * transcript, summary, and recording controls.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import type { Meeting } from "../../hooks/useMeetings";
import "./MeetingDetail.css";

interface MeetingDetailProps {
  meeting: Meeting;
  onBack: () => void;
  onUpdate: (updates: Partial<Meeting>) => Promise<Meeting | null>;
  onDelete: () => void;
  onStartRecording: () => Promise<Meeting | null>;
  onStopRecording: (duration: number) => Promise<Meeting | null>;
}

type DetailTab = "notes" | "transcript" | "summary";

export function MeetingDetail({
  meeting,
  onBack,
  onUpdate,
  onDelete,
  onStartRecording,
  onStopRecording,
}: MeetingDetailProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>("notes");
  const [notes, setNotes] = useState(meeting.notes);
  const [saving, setSaving] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(meeting.title);
  const titleRef = useRef<HTMLInputElement>(null);

  // Recording timer state
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(
    null,
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync notes from props
  useEffect(() => {
    setNotes(meeting.notes);
  }, [meeting.notes]);

  useEffect(() => {
    setTitleDraft(meeting.title);
  }, [meeting.title]);

  // Focus title input when editing
  useEffect(() => {
    if (editingTitle && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
    }
  }, [editingTitle]);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ---- Notes save ----
  const handleSaveNotes = useCallback(async () => {
    setSaving(true);
    await onUpdate({ notes });
    setSaving(false);
  }, [notes, onUpdate]);

  // ---- Title save ----
  const handleTitleSave = useCallback(async () => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft !== meeting.title) {
      await onUpdate({ title: titleDraft.trim() });
    }
  }, [titleDraft, meeting.title, onUpdate]);

  // ---- Recording ----
  const handleStartRecording = useCallback(async () => {
    await onStartRecording();
    const startTime = Date.now();
    setRecordingStartTime(startTime);
    setElapsedSeconds(0);

    timerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
  }, [onStartRecording]);

  const handleStopRecording = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const duration = recordingStartTime
      ? Math.floor((Date.now() - recordingStartTime) / 1000)
      : 0;
    setRecordingStartTime(null);
    setElapsedSeconds(0);
    await onStopRecording(duration);
  }, [recordingStartTime, onStopRecording]);

  // ---- Formatting helpers ----
  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const dateStr = new Date(meeting.date).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="meeting-detail">
      {/* Top bar */}
      <div className="meeting-detail__topbar">
        <button className="meeting-detail__back-btn" onClick={onBack}>
          ← Back
        </button>
        <button className="meeting-detail__delete-btn" onClick={onDelete}>
          Delete
        </button>
      </div>

      {/* Title */}
      <div className="meeting-detail__title-row">
        {editingTitle ? (
          <input
            ref={titleRef}
            className="meeting-detail__title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleTitleSave();
              if (e.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <h1
            className="meeting-detail__title"
            onDoubleClick={() => setEditingTitle(true)}
          >
            {meeting.title}
          </h1>
        )}
        <span
          className={`meeting-detail__status meeting-detail__status--${meeting.status}`}
        >
          {meeting.status}
        </span>
      </div>

      {/* Meta */}
      <div className="meeting-detail__meta">
        <span>{dateStr}</span>
        {meeting.duration > 0 && (
          <span>{Math.round(meeting.duration / 60)} min</span>
        )}
        {meeting.participants.length > 0 && (
          <span>{meeting.participants.join(", ")}</span>
        )}
      </div>

      {/* Recording controls */}
      {(meeting.status === "scheduled" || meeting.status === "recording") && (
        <div className="meeting-detail__recording">
          {meeting.status === "recording" ? (
            <>
              <span className="meeting-detail__recording-indicator" />
              <span className="meeting-detail__recording-time">
                Recording: {formatDuration(elapsedSeconds)}
              </span>
              <button
                className="meeting-detail__btn meeting-detail__btn--danger"
                onClick={handleStopRecording}
              >
                Stop Recording
              </button>
            </>
          ) : (
            <button
              className="meeting-detail__btn meeting-detail__btn--record"
              onClick={handleStartRecording}
            >
              Start Recording
            </button>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="meeting-detail__tabs">
        {(["notes", "transcript", "summary"] as DetailTab[]).map((tab) => (
          <button
            key={tab}
            className={`meeting-detail__tab ${
              activeTab === tab ? "meeting-detail__tab--active" : ""
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="meeting-detail__content">
        {activeTab === "notes" && (
          <div className="meeting-detail__notes">
            <textarea
              className="meeting-detail__textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add meeting notes..."
            />
            <button
              className="meeting-detail__btn meeting-detail__btn--save"
              onClick={handleSaveNotes}
              disabled={saving || notes === meeting.notes}
            >
              {saving ? "Saving..." : "Save Notes"}
            </button>
          </div>
        )}

        {activeTab === "transcript" && (
          <div className="meeting-detail__transcript">
            {meeting.transcript ? (
              <pre className="meeting-detail__transcript-text">
                {meeting.transcript}
              </pre>
            ) : (
              <p className="meeting-detail__placeholder">
                No transcript available. Record a meeting to generate a
                transcript.
              </p>
            )}
          </div>
        )}

        {activeTab === "summary" && (
          <div className="meeting-detail__summary">
            {meeting.summary ? (
              <div className="meeting-detail__summary-text">
                {meeting.summary}
              </div>
            ) : (
              <p className="meeting-detail__placeholder">
                No summary available. A summary will be generated after the
                meeting is transcribed.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
