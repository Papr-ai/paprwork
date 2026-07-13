/**
 * Read-only attachment chips shown on sent user messages.
 */

import React from "react";
import type { MessageAttachment } from "../../types/chat";
import {
  attachmentFileSrc,
  attachmentKindLabel,
  isImageAttachment,
} from "../../utils/messageAttachments";
import "./MessageAttachments.css";

interface MessageAttachmentsProps {
  attachments: MessageAttachment[];
}

function AttachmentIcon({ attachment }: { attachment: MessageAttachment }) {
  if (attachment.mimeType === "application/pdf") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M8.5 13h7M8.5 16.5h5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (isImageAttachment(attachment)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect
          x="3"
          y="5"
          width="18"
          height="14"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <circle cx="9" cy="10" r="1.5" fill="currentColor" />
        <path
          d="M3 16l4.5-4 3 3L14 11l7 7"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6M9 15h6M9 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="message-attachments" data-testid="message-attachments">
      {attachments.map((attachment) => {
        const showPreview =
          isImageAttachment(attachment) && Boolean(attachment.filePath);

        return (
          <div key={attachment.id} className="message-attachment">
            {showPreview && attachment.filePath ? (
              <img
                className="message-attachment__thumb"
                src={attachmentFileSrc(attachment.filePath)}
                alt={attachment.name}
              />
            ) : (
              <span className="message-attachment__icon">
                <AttachmentIcon attachment={attachment} />
              </span>
            )}
            <span className="message-attachment__meta">
              <span className="message-attachment__name" title={attachment.name}>
                {attachment.name}
              </span>
              <span className="message-attachment__kind">
                {attachmentKindLabel(attachment)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
