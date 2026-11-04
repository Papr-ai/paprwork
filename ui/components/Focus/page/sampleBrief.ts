/** The welcome brief Home showed before the first real one (data.js sample()). */
export function sampleBrief() {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return JSON.stringify({
    hero: { date, title: "Welcome to Paprwork", subtitle: "Your AI assistant is ready",
      stats: [{ value: "✓", label: "account" }, { value: "✓", label: "API key" }, { value: "∞", label: "possibilities" }] },
    sections: [
      { type: "priorities", title: "Next Steps", items: [
        { rank: 1, title: "Tell me what you need help with", why: "Open chat and describe your workflow. I'll help you set up integrations, create jobs, or build apps — just ask." },
        { rank: 2, title: "Connect your tools (optional)", why: 'Want calendar, LinkedIn, or email in your brief? Just ask me: "Connect my Google Calendar" or "Track my LinkedIn activity".' },
        { rank: 3, title: "Create your first mini-app", why: 'Once you have some jobs running, we can build custom dashboards to visualize your data. Ask me: "Create a dashboard for my sales pipeline".' }] },
      { type: "timeline", title: "What Happens Next", items: [
        { time: "After we chat", title: "I understand your context", tags: ["milestone"], detail: {
          What: "Every conversation helps me learn your goals, priorities, and workflow.",
          Memory: "I remember past discussions and use them to make better recommendations.",
          Better: "The more we talk, the more helpful I become. Think of me as your chief of staff." } },
        { time: "After 1st job", title: "Automation kicks in", tags: ["milestone"], detail: {
          What: "Jobs run in the background without you thinking about them.",
          Examples: "Sync calendar every 15 min, track LinkedIn weekly, pull CRM data daily.",
          Power: "Jobs can query APIs, process data, and feed other jobs. Chain them together for complex workflows." } },
        { time: "After 1st app", title: "You get a custom dashboard", tags: ["milestone"], detail: {
          What: "Mini-apps visualize your data and let you take actions.",
          Examples: "Sales pipeline tracker, meeting prep dashboard, weekly review.",
          This: "Focus is your home page. You can create specialized apps for any workflow." } }] },
      { type: "alerts", title: "Quick Actions", items: [
        { severity: "info", message: 'Click "Generate My Real Brief" above', action: "Creates your first personalized brief from our conversation so far" },
        { severity: "info", message: "Open chat and say hi", action: 'Try: "What can you help me with?" or "I want to automate my [workflow]"' }] },
      { type: "freeform", title: "How This Works", content: "<strong>You're not configuring software — you're talking to an assistant.</strong> No forms, no settings screens, no complex setup. Just tell me what you need: <em>\"Sync my calendar\"</em>, <em>\"Track LinkedIn connections\"</em>, <em>\"Build a sales dashboard\"</em>. I'll create the jobs, apps, and automations. <strong>Everything happens through conversation.</strong>" },
    ],
  });
}
