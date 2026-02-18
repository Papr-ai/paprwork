export function generateFallbackTitle(message: string): string {
  let title = message.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

  const prefixes = [
    "can you ",
    "could you ",
    "please ",
    "i want to ",
    "i need to ",
    "how do i ",
    "how can i ",
    "what is ",
    "what are ",
    "why ",
    "when ",
    "where ",
    "who ",
  ];

  const lowerTitle = title.toLowerCase();
  for (const prefix of prefixes) {
    if (lowerTitle.startsWith(prefix)) {
      title = title.substring(prefix.length);
      title = title.charAt(0).toUpperCase() + title.slice(1);
      break;
    }
  }

  if (title.length > 40) {
    const truncated = title.substring(0, 40);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > 20) {
      title = `${truncated.substring(0, lastSpace)}...`;
    } else {
      title = `${truncated}...`;
    }
  }

  return title || "New Chat";
}
