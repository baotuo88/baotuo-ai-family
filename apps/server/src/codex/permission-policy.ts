/** Deterministic gates: model review must never expand filesystem authority. */
export function choosePermissionOption<T extends { kind: string; optionId: string }>(
  options: T[], preferredKinds: ReadonlySet<string>,
): T | undefined {
  return options.find(option => preferredKinds.has(option.kind));
}

export const FAMILY_HARD_BLOCKED_COMMANDS =
  /\b(sudo|su|doas|passwd|visudo|chown|chmod|systemctl|service|journalctl|mount|umount|docker|kubectl|reboot|shutdown|halt|poweroff|useradd|usermod|userdel|curl|wget|ssh|scp|sftp|rsync|ftp|telnet|nc|ncat|apt|apt-get|yum|dnf|brew|rm|dd|mkfs|fdisk|iptables)\b|\/etc\/(systemd|sudoers|sudoers\.d)\b|(^|[\/\s])(?:uninstall|install)(\.sh)?\b/i;

export function shouldReviewDeniedFamilyPermission(params: {
  toolKind: string;
  touchedPaths: string[];
  contentText: string;
  decisionReason: string;
}): boolean {
  // Unknown scope and out-of-workspace/read-only denials are hard denials.
  if (/outside controlled workspace|no safe path scope|read-only/i.test(params.decisionReason)) return false;
  if (params.touchedPaths.length === 0) return false;
  if (FAMILY_HARD_BLOCKED_COMMANDS.test(params.contentText)) return false;
  // Only ambiguous execution within a previously validated scope is reviewable.
  // Existing denials do not carry this explicit classification: fail closed by default.
  return params.toolKind === 'execute' && params.decisionReason === 'reviewable execution inside controlled workspace';
}

export function assertFamilyIsolation(role: string, isolation: boolean): void {
  if (role === 'family' && !isolation) {
    throw new Error('Family ACP requires workspace isolation; refusing tool execution');
  }
}
