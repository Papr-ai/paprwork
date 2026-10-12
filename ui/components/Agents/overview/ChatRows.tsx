import React, { useState } from "react";
import type { AgentsOverview, AgentsOverviewChat } from "../../../../src/core/types/agentsOverview";
import { useTabStore } from "../../../stores/tabStore";
import { MixBar } from "./Hero";
import { ago, chatTitle, modelName, pct, tok, usd } from "./format";

function openChat(c: AgentsOverviewChat) {
  const { createTab, switchToTab } = useTabStore.getState();
  switchToTab(createTab("chat", c.id, chatTitle(c.title)));
}

function Detail({ c }: { c: AgentsOverviewChat }) {
  const fresh = Math.max(0, c.tokens - c.cacheRead - c.cacheWrite - c.output);
  return (
    <div className="ag-detail">
      <div className="ag-chips">
        <div className="ag-chip"><small>Per turn</small><b>{usd(c.cost / c.turns)}</b></div>
        <div className="ag-chip"><small>Turns</small><b>{c.turns}</b></div>
        <div className="ag-chip"><small>Avg steps</small><b>{c.steps ?? "—"}</b></div>
        <div className="ag-chip"><small>Peak context</small><b>{c.peak ? tok(c.peak) : "not measured"}</b></div>
      </div>
      <div className="ag-detail-foot">
        <MixBar parts={[[c.cacheRead, "--ag-c-cache"], [c.cacheWrite, "--ag-c-write"], [fresh, "--ag-c-fresh"], [c.output, "--ag-c-out"]]} />
        <span className="ag-row-meta">
          {tok(c.tokens)} · read {pct(c.cacheRead, c.tokens)}% · write {pct(c.cacheWrite, c.tokens)}% · out {pct(c.output, c.tokens)}%
        </span>
        <button className="ag-link" type="button" onClick={() => openChat(c)}>Open chat →</button>
      </div>
    </div>
  );
}

export function ChatRows({ data }: { data: AgentsOverview }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const list = all ? data.chats : data.chats.slice(0, 6);
  const max = Math.max(...data.chats.map((c) => c.tokens), 1);
  return (
    <>
      {list.map((c) => {
        const isOpen = open === c.id;
        return (
          <React.Fragment key={c.id}>
            <button
              className={`ag-row${isOpen ? " is-open" : ""}`}
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : c.id)}
            >
              <span className="ag-min">
                <div className="ag-row-title">{chatTitle(c.title)}</div>
                <div className="ag-row-meta">
                  {modelName(c.model)} · {c.turns} turns · {pct(c.cacheRead, c.tokens)}% cached · {ago(c.last)}
                </div>
              </span>
              <span className="ag-row-peak" title={`${c.tokens.toLocaleString()} total tokens`}>
                <span className="ag-meter"><i style={{ width: `${(c.tokens / max) * 100}%` }} /></span>
                {tok(c.tokens)}
              </span>
              <span className="ag-row-cost">{usd(c.cost)}</span>
            </button>
            {isOpen && <Detail c={c} />}
          </React.Fragment>
        );
      })}
      {all && data.longTail.chats > 0 && (
        <div className="ag-row ag-mrow">
          <span className="ag-min">
            <div className="ag-row-title">{data.longTail.chats} other chats</div>
            <div className="ag-row-meta">avg {usd(data.longTail.cost / data.longTail.chats)} each</div>
          </span>
          <span />
          <span className="ag-row-cost">{usd(data.longTail.cost)}</span>
        </div>
      )}
      {data.chats.length > 6 && (
        <button className="ag-more" type="button" onClick={() => setAll(!all)}>
          {all ? "Show less" : `All ${data.totals.chats} chats`}
        </button>
      )}
    </>
  );
}

export function ModelRows({ data }: { data: AgentsOverview }) {
  const max = data.models[0]?.cost || 1;
  return (
    <>
      {data.models.map((m) => (
        <div className="ag-row ag-mrow" key={m.model}>
          <span className="ag-min">
            <div className="ag-row-title">{modelName(m.model)}</div>
            <div className="ag-row-meta">
              {m.turns.toLocaleString()} turns · {tok(m.tokens)} tokens{m.peak ? ` · peak context ${tok(m.peak)}` : ""}
            </div>
          </span>
          <span className="ag-meter"><i style={{ width: `${(m.cost / max) * 100}%` }} /></span>
          <span className="ag-row-cost">{usd(m.cost)}</span>
        </div>
      ))}
    </>
  );
}
