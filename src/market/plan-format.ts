// Pure formatting of a `plan-tool-use` result into terminal lines. No I/O and no
// color of its own — the caller passes a helpers bag (h) so market/client.ts
// injects ANSI. Ported verbatim from planner's plan-format.mjs.
//
// When the plan carries capability `groups`, each capability prints its options
// (the recommended one first, tagged) so the agent sees the alternatives. Older
// / template plans without groups fall back to the flat `tools` list.

export interface PlanHelpers {
  bold: (s: string) => string;
  dim: (s: string) => string;
  lime: (s: string) => string;
  gray: (s: string) => string;
  kind: (k: string) => string;
  pad: (s: string, n: number) => string;
  usd: (units: number) => string;
  unesc: (s: string) => string;
}

export function planLines(plan: any, h: PlanHelpers): { lines: string[]; total: number } {
  const lines: string[] = [];
  const heading = h.unesc(plan.reason || plan.task || 'Recommended');
  lines.push('');
  lines.push('  ' + h.bold('Recommended') + '  ' + h.dim(heading));

  const groups = Array.isArray(plan.groups) ? plan.groups : null;
  let total = 0;

  if (groups && groups.length) {
    for (const g of groups) {
      lines.push('  ' + h.dim(h.unesc(g.capability || '')));
      const lead = g.options.find((o: any) => o.recommended) || g.options[0];
      const ordered = lead ? [lead, ...g.options.filter((o: any) => o !== lead)] : g.options;
      if (lead) total += lead.units || 0;
      for (const o of ordered) {
        const k = h.kind(o.kind);
        const tag = o === lead ? '  ' + h.lime('recommended') : '';
        lines.push(
          `    ${k}  ${h.bold(h.pad(o.slug, 34))} ${h.dim(h.pad(h.unesc(o.detail || ''), 24))} ${h.lime('~' + (o.units || 0).toLocaleString() + ' Units')}${tag}`,
        );
      }
    }
  } else {
    for (const t of plan.tools || []) {
      total += t.units || 0;
      const k = h.kind(t.kind);
      lines.push(
        `    ${k}  ${h.bold(h.pad(t.slug, 36))} ${h.dim(h.pad(h.unesc(t.detail || ''), 30))} ${h.lime('~' + (t.units || 0).toLocaleString() + ' Units')}`,
      );
    }
  }

  lines.push(h.gray('    ' + '─'.repeat(78)));
  lines.push(`    ${h.bold('est')} ${h.lime('~' + total.toLocaleString() + ' Units')} ${h.dim('(~' + h.usd(total) + ')')}`);
  if (plan.instructions) {
    lines.push('');
    lines.push('  ' + h.dim(h.unesc(plan.instructions)));
  }
  lines.push(h.dim('\n  → Run these yourself. Paid endpoints answer HTTP 402; settle with fluxa-wallet market model topup or a signed mandate.'));
  return { lines, total };
}
