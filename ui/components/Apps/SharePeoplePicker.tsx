/**
 * SharePeoplePicker — one field for teammates, guest emails, and @domains.
 */

import React, { useMemo, useRef, useState } from "react";
import { UserAvatar } from "../common/UserAvatar";
import {
  buildUniqueMentionHandles,
  matchesMentionQuery,
} from "../../utils/mentionHandle";
import {
  normalizeAllowedEmailDomains,
  normalizeAllowedEmails,
} from "../../utils/shareAudienceModel";
import {
  buildSharePeopleMenuEntries,
  type SharePeopleMenuEntry,
} from "../../utils/sharePeopleInput";
import "./SharePeoplePicker.css";

export interface SharePeopleMember {
  userId: string;
  displayName: string;
  email: string;
  imageUrl?: string;
}

interface SharePeoplePickerProps {
  members: SharePeopleMember[];
  value: string[];
  onChange: (userIds: string[]) => void;
  allowedEmails?: string[];
  allowedEmailDomains?: string[];
  onEmailsChange?: (emails: string[]) => void;
  onDomainsChange?: (domains: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
  /** Publisher — always retains access, shown as a non-removable owner row. */
  currentUserId?: string | null;
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4ZM11 11l3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DomainGlyph() {
  return (
    <span className="people-picker__domain-icon" aria-hidden="true">
      @
    </span>
  );
}

export function SharePeoplePicker({
  members,
  value,
  onChange,
  allowedEmails = [],
  allowedEmailDomains = [],
  onEmailsChange,
  onDomainsChange,
  loading = false,
  disabled = false,
  currentUserId = null,
}: SharePeoplePickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const externalEnabled =
    onEmailsChange !== undefined && onDomainsChange !== undefined;

  const emails = useMemo(
    () => normalizeAllowedEmails(allowedEmails),
    [allowedEmails],
  );
  const domains = useMemo(
    () => normalizeAllowedEmailDomains(allowedEmailDomains),
    [allowedEmailDomains],
  );

  const handles = useMemo(() => buildUniqueMentionHandles(members), [members]);
  const byId = useMemo(
    () => new Map(members.map((m) => [m.userId, m])),
    [members],
  );
  const memberEmailsByUserId = useMemo(
    () => new Map(members.map((m) => [m.userId, m.email])),
    [members],
  );

  const owner = currentUserId ? byId.get(currentUserId) : undefined;

  const granted = useMemo(
    () => value.map((id) => byId.get(id)).filter(Boolean) as SharePeopleMember[],
    [value, byId],
  );

  const memberMatches = useMemo(() => {
    const chosen = new Set(value);
    return members
      .filter(
        (m) =>
          m.userId !== currentUserId &&
          !chosen.has(m.userId) &&
          matchesMentionQuery(
            { userId: m.userId, displayName: m.displayName, email: m.email },
            handles.get(m.userId) ?? "",
            query,
          ),
      )
      .map((m) => ({ userId: m.userId, email: m.email }));
  }, [members, value, currentUserId, handles, query]);

  const menuEntries = useMemo(() => {
    if (!query.trim()) {
      return [];
    }
    if (!externalEnabled) {
      return memberMatches
        .slice(0, 5)
        .map((m) => ({ kind: "member" as const, userId: m.userId }));
    }
    return buildSharePeopleMenuEntries({
      query,
      memberUserIds: value,
      memberEmailsByUserId,
      allowedEmails: emails,
      allowedEmailDomains: domains,
      memberMatches,
      currentUserId,
    });
  }, [
    query,
    externalEnabled,
    memberMatches,
    value,
    memberEmailsByUserId,
    emails,
    domains,
    currentUserId,
  ]);

  const menuOpen = query.trim().length > 0;

  const applyEntry = (entry: SharePeopleMenuEntry) => {
    if (entry.kind === "member") {
      if (!value.includes(entry.userId)) {
        onChange([...value, entry.userId]);
      }
    } else if (entry.kind === "external_email" && onEmailsChange) {
      if (!emails.includes(entry.email)) {
        onEmailsChange([...emails, entry.email]);
      }
    } else if (entry.kind === "domain" && onDomainsChange) {
      if (!domains.includes(entry.domain)) {
        onDomainsChange([...domains, entry.domain]);
      }
    }
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!menuOpen && event.key === "Enter") {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, menuEntries.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      const pick = menuEntries[activeIndex];
      if (pick) {
        event.preventDefault();
        applyEntry(pick);
      }
    } else if (event.key === "Escape") {
      setQuery("");
    }
  };

  const placeholder = externalEnabled
    ? "Add people by name, email, or company domain"
    : "Add people by name or email";

  const hasGuests = emails.length > 0 || domains.length > 0;

  return (
    <div className="people-picker" data-disabled={disabled || undefined}>
      <div className="people-picker__search">
        <span className="people-picker__search-icon">
          <SearchGlyph />
        </span>
        <input
          ref={inputRef}
          className="people-picker__input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {menuOpen ? (
        <ul className="people-picker__menu" role="listbox">
          {loading && menuEntries.length === 0 ? (
            <li className="people-picker__empty">Loading workspace…</li>
          ) : menuEntries.length === 0 ? (
            <li className="people-picker__empty">No matches — try an email or @domain</li>
          ) : (
            menuEntries.map((entry, i) => {
              if (entry.kind === "member") {
                const person = byId.get(entry.userId);
                if (!person) {
                  return null;
                }
                return (
                  <li key={`member-${entry.userId}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === activeIndex}
                      className={`people-picker__option${i === activeIndex ? " is-active" : ""}`}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => applyEntry(entry)}
                    >
                      <UserAvatar
                        imageUrl={person.imageUrl}
                        displayName={person.displayName}
                        email={person.email}
                        size={28}
                      />
                      <span className="people-picker__person">
                        <span className="people-picker__name">{person.displayName}</span>
                        <span className="people-picker__sub">{person.email}</span>
                      </span>
                    </button>
                  </li>
                );
              }
              if (entry.kind === "external_email") {
                return (
                  <li key={`email-${entry.email}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === activeIndex}
                      className={`people-picker__option${i === activeIndex ? " is-active" : ""}`}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => applyEntry(entry)}
                    >
                      <DomainGlyph />
                      <span className="people-picker__person">
                        <span className="people-picker__name">{entry.email}</span>
                        <span className="people-picker__sub">
                          Signed-in guest — not in your workspace
                        </span>
                      </span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={`domain-${entry.domain}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    className={`people-picker__option${i === activeIndex ? " is-active" : ""}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => applyEntry(entry)}
                  >
                    <DomainGlyph />
                    <span className="people-picker__person">
                      <span className="people-picker__name">@{entry.domain}</span>
                      <span className="people-picker__sub">
                        Anyone signed in with this email domain
                      </span>
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}

      <div className="people-picker__access">
        <div className="people-picker__access-title">People with access</div>
        <ul className="people-picker__access-list">
          {owner ? (
            <li className="people-picker__row">
              <UserAvatar
                imageUrl={owner.imageUrl}
                displayName={owner.displayName}
                email={owner.email}
                size={28}
              />
              <span className="people-picker__person">
                <span className="people-picker__name">{owner.displayName} (you)</span>
                <span className="people-picker__sub">{owner.email}</span>
              </span>
              <span className="people-picker__badge">Owner</span>
            </li>
          ) : null}

          {granted.map((person) => (
            <li key={person.userId} className="people-picker__row">
              <UserAvatar
                imageUrl={person.imageUrl}
                displayName={person.displayName}
                email={person.email}
                size={28}
              />
              <span className="people-picker__person">
                <span className="people-picker__name">{person.displayName}</span>
                <span className="people-picker__sub">{person.email}</span>
              </span>
              <button
                type="button"
                className="people-picker__remove"
                onClick={() => onChange(value.filter((id) => id !== person.userId))}
                disabled={disabled}
              >
                Remove
              </button>
            </li>
          ))}

          {externalEnabled
            ? emails.map((email) => (
                <li key={`guest-${email}`} className="people-picker__row">
                  <DomainGlyph />
                  <span className="people-picker__person">
                    <span className="people-picker__name">{email}</span>
                    <span className="people-picker__sub">Guest (signed in)</span>
                  </span>
                  <button
                    type="button"
                    className="people-picker__remove"
                    onClick={() =>
                      onEmailsChange?.(emails.filter((e) => e !== email))
                    }
                    disabled={disabled}
                  >
                    Remove
                  </button>
                </li>
              ))
            : null}

          {externalEnabled
            ? domains.map((domain) => (
                <li key={`domain-${domain}`} className="people-picker__row">
                  <DomainGlyph />
                  <span className="people-picker__person">
                    <span className="people-picker__name">@{domain}</span>
                    <span className="people-picker__sub">Email domain</span>
                  </span>
                  <button
                    type="button"
                    className="people-picker__remove"
                    onClick={() =>
                      onDomainsChange?.(domains.filter((d) => d !== domain))
                    }
                    disabled={disabled}
                  >
                    Remove
                  </button>
                </li>
              ))
            : null}
        </ul>

        {granted.length === 0 && !hasGuests ? (
          <p className="people-picker__hint">
            {externalEnabled
              ? "No one else yet — add a teammate, an email, or @company.com above."
              : "No one else yet — add a teammate above, or nobody but you will be able to open this app."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
