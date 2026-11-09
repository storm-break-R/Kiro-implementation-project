import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../../api/client';
import type { VotingEvent } from '../../api/types';
import StatusChip from '../../components/StatusChip';
import { usePolling } from '../../hooks/usePolling';
import { formatDateTime, formatPercent } from '../../utils/format';

export interface DashboardEvent extends VotingEvent {
  turnout: { eligible: number; registered: number; voted: number; remaining: number; percent: number };
}

export interface Dashboard {
  totals: { events: number; open: number; eligible: number; registered: number; voted: number };
  events: DashboardEvent[];
}

export const DASHBOARD_REFRESH_MS = 5000;

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Paper sx={{ p: 2, textAlign: 'center' }}>
      <Typography variant="h4" component="p" sx={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
      <Typography color="text.secondary">{label}</Typography>
    </Paper>
  );
}

export default function AdminDashboardPage() {
  const { data, error, refresh } = usePolling(() => api<Dashboard>('/api/admin/dashboard'), DASHBOARD_REFRESH_MS);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(e: DashboardEvent, action: 'open' | 'close') {
    const prompt =
      action === 'close' ? `Close voting for "${e.title}" now? This cannot be undone.` : `Open "${e.title}" for voting?`;
    if (!window.confirm(prompt)) return;
    setActionError(null);
    try {
      await api(`/api/admin/events/${e.id}/${action}`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h3" component="h1">
          Admin dashboard
        </Typography>
        <Button variant="contained" component={RouterLink} to="/admin/events">
          Manage events
        </Button>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && <Alert severity="error">{actionError}</Alert>}

      {data && (
        <Box
          aria-label="Totals"
          component="section"
          sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' } }}
        >
          <Stat label="Open events" value={data.totals.open} />
          <Stat label="Eligible voters" value={data.totals.eligible.toLocaleString()} />
          <Stat label="Registered" value={data.totals.registered.toLocaleString()} />
          <Stat label="Votes cast" value={data.totals.voted.toLocaleString()} />
        </Box>
      )}

      <Box component="section" aria-label="Events" sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }}>
        {data?.events.length === 0 && (
          <Typography color="text.secondary">
            No events yet. <RouterLink to="/admin/events">Create the first one.</RouterLink>
          </Typography>
        )}
        {data?.events.map((e) => (
          <Card key={e.id} component="article" aria-label={e.title}>
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="h6" component="h2">
                  {e.title}
                </Typography>
                <StatusChip status={e.status} />
              </Stack>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                {formatDateTime(e.startsAt)} to {formatDateTime(e.endsAt)}
              </Typography>
              <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {e.turnout.voted} voted · {e.turnout.remaining} registered but not voted · {e.turnout.eligible} eligible
              </Typography>
              <LinearProgress
                variant="determinate"
                value={Math.min(e.turnout.percent, 100)}
                aria-label={`Turnout ${formatPercent(e.turnout.percent)}`}
                sx={{ height: 8, borderRadius: 4, my: 1 }}
              />
              <Typography variant="body2" color="text.secondary">
                Turnout {formatPercent(e.turnout.percent)}
              </Typography>
            </CardContent>
            <CardActions sx={{ flexWrap: 'wrap' }}>
              <Button size="small" component={RouterLink} to={`/admin/events/${e.id}`}>
                Manage
              </Button>
              {e.status !== 'draft' && (
                <Button size="small" component={RouterLink} to={`/events/${e.id}`}>
                  Public results
                </Button>
              )}
              {e.status === 'draft' && (
                <Button size="small" variant="contained" onClick={() => void act(e, 'open')}>
                  Open
                </Button>
              )}
              {e.status === 'open' && (
                <Button size="small" color="warning" variant="contained" onClick={() => void act(e, 'close')}>
                  Close voting
                </Button>
              )}
            </CardActions>
          </Card>
        ))}
      </Box>
    </Stack>
  );
}
