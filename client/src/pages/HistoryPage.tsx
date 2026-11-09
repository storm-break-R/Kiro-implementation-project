import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import { Alert, Box, Card, CardActionArea, CardContent, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../api/client';
import { formatDateTime, formatPercent } from '../utils/format';

export interface HistoryItem {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  closedAt: string | null;
  totalVotes: number;
  turnoutPercent: number;
  winners: Array<{ id: string; name: string; team: string; votes: number; percent: number }>;
}

/** Final results of every closed event. */
export default function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ events: HistoryItem[] }>('/api/events/history', { auth: false })
      .then((r) => setItems(r.events))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load history'));
  }, []);

  return (
    <Stack spacing={3}>
      <Typography variant="h3" component="h1">
        Past results
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {items?.length === 0 && <Typography color="text.secondary">No events have finished yet.</Typography>}
      <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }}>
        {items?.map((e) => (
          <Box component="li" key={e.eventId}>
            <Card sx={{ height: '100%' }}>
              <CardActionArea component={RouterLink} to={`/events/${e.eventId}`} sx={{ height: '100%' }}>
                <CardContent>
                  <Typography variant="h5" component="h2">
                    {e.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Closed {formatDateTime(e.closedAt ?? e.endsAt)}
                  </Typography>
                  {e.winners.length === 0 ? (
                    <Typography>No votes were cast.</Typography>
                  ) : (
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <EmojiEventsIcon aria-hidden sx={{ color: 'secondary.main' }} />
                      <Typography sx={{ fontWeight: 700 }}>
                        {e.winners.length > 1 ? 'Joint winners: ' : 'Winner: '}
                        {e.winners.map((w) => `${w.name} (${formatPercent(w.percent)})`).join(', ')}
                      </Typography>
                    </Stack>
                  )}
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {e.totalVotes.toLocaleString()} votes · turnout {formatPercent(e.turnoutPercent)}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          </Box>
        ))}
      </Box>
    </Stack>
  );
}
