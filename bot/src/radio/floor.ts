/**
 * Broadcast classification floor (docs/radio.md §6.3): a bumper is heard by
 * everyone present, so it retrieves at the *intersection* of every member's
 * clearance — one uncleared listener floors the whole window. Pure so the
 * adversarial case is unit-testable; the caller binds `levelsFor` to
 * allowedClassificationsFor(subject, rightsEngine).
 */
export interface PresentMember {
  uid?: string;
  serverGroups?: string[];
  /** TeamSpeak client type: 1 = query/bot — skipped (it isn't a listener). */
  type?: number;
}

export function floorFromMembers(
  members: PresentMember[],
  levelsFor: (subject: { uid: string; serverGroups: string[] }) => string[] | undefined,
): string[] {
  let floor: Set<string> | null = null;
  for (const m of members) {
    if (m.type === 1) continue;
    const levels = levelsFor({ uid: m.uid ?? "", serverGroups: (m.serverGroups ?? []).map(String) })
      ?? ["unclassified"];
    floor = floor === null ? new Set(levels) : new Set(levels.filter((l) => floor!.has(l)));
  }
  return floor && floor.size > 0 ? [...floor] : ["unclassified"];
}
