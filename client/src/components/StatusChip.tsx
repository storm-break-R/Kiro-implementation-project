import { Chip } from '@mui/material';
import type { EventStatus } from '../api/types';

const config: Record<EventStatus, { label: string; color: 'default' | 'success' | 'warning' }> = {
  draft: { label: 'Draft', color: 'default' },
  open: { label: 'Open', color: 'success' },
  closed: { label: 'Closed', color: 'warning' },
};

export default function StatusChip({ status }: { status: EventStatus }) {
  const { label, color } = config[status];
  return <Chip size="small" label={label} color={color} />;
}
