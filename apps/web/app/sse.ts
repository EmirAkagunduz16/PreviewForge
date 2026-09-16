export function parseSse(frame: string): { event: string; data: string } | null {
  const event = frame.match(/^event: ([^\n]+)/m)?.[1] ?? "message";
  const data = frame.match(/^data: ([^\n]*)/m)?.[1];
  return data === undefined
    ? event === "heartbeat"
      ? { event, data: "" }
      : null
    : { event, data };
}
