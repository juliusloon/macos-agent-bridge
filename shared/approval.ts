export const reviewUrls = {
  tinycast: 'tinycast://extensions/cano/macos-agent-bridge/approvals',
  raycast: 'raycast://extensions/cano/macos-agent-bridge/approvals',
} as const;

export function approvalGuidance(source: string) {
  const host = /(?:^|[: ._-])raycast(?:$|[ ._-])/i.test(source) ? 'raycast' : 'tinycast';
  const app = host === 'tinycast' ? 'Tinycast' : 'Raycast';
  const reviewUrl = reviewUrls[host];
  return {
    reviewUrl,
    reviewUrls,
    action: `Open [待确认操作](${reviewUrl}) or ${app} → macOS Agent Bridge → 待确认操作. Review the exact request and choose 批准并执行; this immediately executes it. Query bridge_get_operation with the original tool name and idempotencyKey to read the status and saved result, or retry the identical tool arguments and _idempotencyKey. Keep the same key while waiting; do not submit duplicate requests.`,
  };
}
