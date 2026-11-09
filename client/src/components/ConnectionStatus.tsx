import { Chip } from '@mui/material';
import type { ConnectionStatus as Status } from '../realtime/useLiveResults';

const config: Record<Status, { label: string; color: 'success' | 'default' | 'warning' }> = {
  live: { label: 'Live', color: 'success' },
  connecting: { label: 'Connecting…', color: 'default' },
  offline: { label: 'Reconnecting, refreshing every 10s', color: 'warning' },
};

export default function ConnectionStatus({ status }: { status: Status }) {
  const { label, color } = config[status];
  return (
    <span role="status" aria-live="polite">
      <Chip size="small" color={color} label={label} variant={status === 'live' ? 'filled' : 'outlined'} />
    </span>
  );
}
