import { Alert, Box, Card, CardActionArea, CardContent, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../api/client';
import type { VotingEvent } from '../api/types';
import StatusChip from '../components/StatusChip';
import { formatDateTime } from '../utils/format';

export default function HomePage() {
  const [events, setEvents] = useState<VotingEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ events: VotingEvent[] }>('/api/events', { auth: false })
      .then((r) => setEvents(r.events.filter((e) => e.status === 'open')))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load events'));
  }, []);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h2" component="h1" gutterBottom>
          Pick your player of the season
        </Typography>
        <Typography color="text.secondary">Open voting events. Results update live.</Typography>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {events?.length === 0 && <Typography color="text.secondary">There are no open events right now.</Typography>}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }}>
        {events?.map((e) => (
          <Card key={e.id}>
            <CardActionArea component={RouterLink} to={`/events/${e.id}`}>
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="h5" component="h2">
                    {e.title}
                  </Typography>
                  <StatusChip status={e.status} />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Voting closes {formatDateTime(e.endsAt)}
                </Typography>
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Stack>
  );
}
