export function facebookGroupId(groupUrl: string): string {
  try {
    const match = /^\/groups\/([^/]+)/i.exec(new URL(groupUrl).pathname);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch { /* Keep a readable fallback for malformed legacy URLs. */ }
  return groupUrl;
}

export function facebookGroupLabel(group: { groupName?: string | null; groupUrl: string }): string {
  const name = group.groupName?.replace(/\s+/g, ' ').trim();
  const placeholder = /^(?:view\s+group|visit\s+group|xem\s+nhóm)(?:\s*[|·-]\s*facebook)?$/i;
  return name && !placeholder.test(name) ? name : facebookGroupId(group.groupUrl);
}
