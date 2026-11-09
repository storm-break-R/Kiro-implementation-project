import { Alert, Box, Button, Card, CardContent, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../api/client';
import type { VotingEvent } from '../api/types';
import StatusChip from '../components/StatusChip';
import { formatDateTime } from '../utils/format';

type VoterEvent = VotingEvent & { hasVoted: boolean };

/** The voter's own events: vote now, already voted, or view results. */
export default function DashboardPage() {
  const [events, setEvents] = useState<VoterEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ events: VoterEvent[] }>('/api/voter/events')
      .then((r) => setEvents(r.events))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load your events'));
  }, []);

  return (
    <Stack spacing={3}>
      <Typography variant="h3" component="h1">
        Your ballots
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {events?.length === 0 && <Typography color="text.secondary">You are not registered for any events yet.</Typography>}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }}>
        {events?.map((e) => (
          <Card key={e.id}>
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="h5" component="h2">
                  {e.title}
                </Typography>
                <StatusChip status={e.status} />
              </Stack>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                {e.votingOpen ? `Voting closes ${formatDateTime(e.endsAt)}` : `Voting window: ${formatDateTime(e.startsAt)}`}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                {e.hasVoted ? (
                  <Typography color="success.main" sx={{ fontWeight: 700 }}>
                    ✓ You have voted
                  </Typography>
                ) : e.votingOpen ? (
                  <Button variant="contained" component={RouterLink} to={`/events/${e.id}`}>
                    Vote now
                  </Button>
                ) : null}
                <Button component={RouterLink} to={`/events/${e.id}`}>
                  View results
                </Button>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Box>
    </Stack>
  );
}
