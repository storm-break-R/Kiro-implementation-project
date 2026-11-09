import { Alert, Box, Card, CardActionArea, CardContent, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import type { VotingEvent } from '../../api/types';
import EventForm, { type EventFormValues } from '../../components/EventForm';
import StatusChip from '../../components/StatusChip';
import { formatDateTime, fromLocalInput, toLocalInput } from '../../utils/format';

export default function AdminEventsPage() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<VotingEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ events: VotingEvent[] }>('/api/admin/events')
      .then((r) => setEvents(r.events))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load events'));
  }, []);

  const initial: EventFormValues = {
    title: '',
    description: '',
    startsAt: toLocalInput(new Date().toISOString()),
    endsAt: toLocalInput(new Date(Date.now() + 7 * 24 * 3600_000).toISOString()),
    resultsVisibility: 'live',
  };

  async function create(values: EventFormValues) {
    setError(null);
    try {
      const created = await api<VotingEvent>('/api/admin/events', {
        method: 'POST',
        body: {
          ...values,
          startsAt: fromLocalInput(values.startsAt),
          endsAt: fromLocalInput(values.endsAt),
        },
      });
      navigate(`/admin/events/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create event');
    }
  }

  return (
    <Stack spacing={4}>
      <Typography variant="h3" component="h1">
        Voting events
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}

      <Box
        component="section"
        aria-label="Existing events"
        sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }}
      >
        {events?.length === 0 && <Typography color="text.secondary">No events yet. Create the first one below.</Typography>}
        {events?.map((e) => (
          <Card key={e.id}>
            <CardActionArea component={RouterLink} to={`/admin/events/${e.id}`}>
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="h6" component="h2">
                    {e.title}
                  </Typography>
                  <StatusChip status={e.status} />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(e.startsAt)} to {formatDateTime(e.endsAt)}
                </Typography>
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>

      <Paper component="section" aria-labelledby="new-event" sx={{ p: 3 }}>
        <Typography id="new-event" variant="h5" component="h2" gutterBottom>
          Create an event
        </Typography>
        <EventForm initial={initial} submitLabel="Create event" onSubmit={create} />
      </Paper>
    </Stack>
  );
}
