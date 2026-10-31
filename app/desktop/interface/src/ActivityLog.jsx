import React from 'react';
export function ActivityLog({ activity }) {
  if (!activity?.entries?.length) return null;
  return <details className="notice-activity"><summary>{activity.summary || 'Activity'}</summary><ol>{activity.entries.map(entry => <li key={entry.id}><span>{entry.label}</span><small>{entry.state}{Number.isFinite(entry.durationMs) ? ` · ${(entry.durationMs / 1000).toFixed(1)}s` : ''}</small></li>)}</ol></details>;
}
