import HowToVoteIcon from '@mui/icons-material/HowToVote';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  CardMedia,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { Suspense, lazy, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { Candidate, EventDetail, VoterEvent } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import ConnectionStatus from '../components/ConnectionStatus';
import ResultsBoard from '../components/ResultsBoard';
// Chart.js is the heaviest dependency; load it after the scoreboard is on screen.
const StatsPanel = lazy(() => import('../components/StatsPanel'));
import StatusChip from '../components/StatusChip';
import { useLiveResults } from '../realtime/useLiveResults';
import { formatDateTime } from '../utils/format';

type Ballot = { state: 'loading' } | { state: 'none' } | { state: 'eligible'; hasVoted: boolean };

export default function EventPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ballot, setBallot] = useState<Ballot>({ state: 'loading' });
  const [choice, setChoice] = useState<Candidate | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [justVoted, setJustVoted] = useState(false);
  const live = useLiveResults(id);

  useEffect(() => {
    api<EventDetail>(`/api/events/${id}`, { auth: false })
      .then(setEvent)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load event'));
  }, [id]);

  // Only voters registered for this event get a ballot.
  useEffect(() => {
    if (user?.role !== 'voter') {
      setBallot({ state: 'none' });
      return;
    }
    api<{ events: VoterEvent[] }>('/api/voter/events')
      .then((r) => {
        const mine = r.events.find((e) => e.id === id);
        setBallot(mine ? { state: 'eligible', hasVoted: mine.hasVoted } : { state: 'none' });
      })
      .catch(() => setBallot({ state: 'none' }));
  }, [id, user]);

  async function submitVote() {
    if (!choice) return;
    setSubmitting(true);
    setVoteError(null);
    try {
      await api(`/api/voter/events/${id}/vote`, { method: 'POST', body: { candidateId: choice.id } });
      setBallot({ state: 'eligible', hasVoted: true });
      setJustVoted(true);
      setChoice(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_VOTED') {
        setBallot({ state: 'eligible', hasVoted: true });
        setChoice(null);
      }
      setVoteError(e instanceof Error ? e.message : 'Your vote could not be submitted');
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!event) return <Typography>Loading event…</Typography>;

  const votingOpen = live.snapshot?.votingOpen ?? event.votingOpen;
  const canVote = ballot.state === 'eligible' && !ballot.hasVoted && votingOpen;

  return (
    <Stack spacing={3}>
      <Box>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h3" component="h1">
            {event.title}
          </Typography>
          <StatusChip status={live.snapshot?.status ?? event.status} />
          <ConnectionStatus status={live.status} />
        </Stack>
        <Typography color="text.secondary">
          {votingOpen ? `Voting closes ${formatDateTime(event.endsAt)}` : `Voting ran ${formatDateTime(event.startsAt)} to ${formatDateTime(event.endsAt)}`}
        </Typography>
        {event.description && <Typography sx={{ mt: 1 }}>{event.description}</Typography>}
      </Box>

      {justVoted && (
        <Alert severity="success" icon={<HowToVoteIcon />}>
          Your vote has been counted. Thanks for taking part.
        </Alert>
      )}
      {voteError && !justVoted && <Alert severity="warning">{voteError}</Alert>}
      {ballot.state === 'eligible' && ballot.hasVoted && !justVoted && (
        <Alert severity="info">You have already voted in this event.</Alert>
      )}
      {!user && votingOpen && (
        <Alert severity="info">
          <RouterLink to="/login" state={{ from: `/events/${id}` }}>
            Sign in
          </RouterLink>{' '}
          to vote. Anyone can follow the results.
        </Alert>
      )}

      <Box
        sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: canVote ? '3fr 2fr' : '1fr' }, alignItems: 'start' }}
      >
        {canVote && (
          <Box component="section" aria-labelledby="ballot-title">
            <Typography id="ballot-title" variant="h5" component="h2" gutterBottom>
              Cast your vote
            </Typography>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' } }}>
              {event.candidates.map((c) => (
                <Card key={c.id} sx={{ display: 'flex', flexDirection: 'column' }}>
                  {c.imageUrl ? (
                    <CardMedia component="img" height="200" image={c.imageUrl} alt={`Photo of ${c.name}`} sx={{ objectFit: 'cover' }} />
                  ) : (
                    <Box
                      aria-hidden
                      sx={{ height: 200, display: 'grid', placeItems: 'center', bgcolor: 'primary.light', color: 'primary.contrastText' }}
                    >
                      <Typography variant="h2">{c.name.charAt(0)}</Typography>
                    </Box>
                  )}
                  <CardContent sx={{ flex: 1 }}>
                    <Typography variant="h6" component="h3">
                      {c.name}
                    </Typography>
                    {c.team && <Typography color="text.secondary">{c.team}</Typography>}
                    {c.bio && <Typography variant="body2">{c.bio}</Typography>}
                  </CardContent>
                  <CardActions>
                    <Button fullWidth variant="contained" onClick={() => setChoice(c)} aria-label={`Vote for ${c.name}`}>
                      Vote
                    </Button>
                  </CardActions>
                </Card>
              ))}
            </Box>
          </Box>
        )}

        <Stack spacing={2}>
          {live.error && !live.snapshot && <Alert severity="error">{live.error}</Alert>}
          {live.snapshot ? (
            <ResultsBoard snapshot={live.snapshot} />
          ) : (
            !live.error && <Typography>Loading results…</Typography>
          )}
        </Stack>
      </Box>

      {live.snapshot && (
        <Suspense fallback={<Typography color="text.secondary">Loading statistics…</Typography>}>
          <StatsPanel snapshot={live.snapshot} />
        </Suspense>
      )}

      <Dialog open={!!choice} onClose={() => !submitting && setChoice(null)} aria-labelledby="confirm-title">
        <DialogTitle id="confirm-title">Vote for {choice?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>You can vote once in this event and you can&apos;t change your vote afterwards.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setChoice(null)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void submitVote()} disabled={submitting}>
            Confirm vote
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
